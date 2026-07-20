import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PipelineProgress } from "../lib/audit/pipeline";
import { buildFinalAuditResult } from "../lib/audit-result";
import { BailianClientError } from "../lib/server/bailian-client";
import { ServerPdfError } from "../lib/server/pdf-renderer";
import {
  TASK_FILE_CLEANUP_INTERVAL_MS,
  TaskWorker,
  createTaskWorkerFromEnv,
  parseTaskWorkerConcurrency,
  parseTaskWorkerPollInterval,
} from "../lib/server/task-worker";
import { strictFinalizeRequest } from "./strict-fixtures";

const finalResult = buildFinalAuditResult(strictFinalizeRequest);
const stages = [
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
] as const;

type TestTask = {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  pdfPath: string | null;
};

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function makeTestWorker(options: {
  concurrency?: number;
  queuedTaskCount?: number;
  tasks?: TestTask[];
  processTask?: (
    task: TestTask,
    onProgress: (progress: PipelineProgress) => void | Promise<void>,
  ) => Promise<typeof finalResult>;
  updateProgress?: (input: { status: string }) => Promise<void> | void;
  cleanup?: () => Promise<void>;
  cleanupIntervalMs?: number;
  pollIntervalMs?: number;
  useDefaultPdfReader?: boolean;
  logger?: { error: (message: string, context: Record<string, unknown>) => void };
  failTask?: (input: { id: string; errorCode: string }) => Promise<void> | void;
}) {
  const dataDir = path.join(os.tmpdir(), "pdf-checker-worker-data");
  const tasks = options.tasks ?? Array.from(
    { length: options.queuedTaskCount ?? 1 },
    (_, index): TestTask => ({
      id: `task-${index + 1}`,
      fileName: `task-${index + 1}.pdf`,
      fileSize: 100,
      fileType: "application/pdf",
      pdfPath: path.join(dataDir, "uploads", `task-${index + 1}.pdf`),
    }),
  );
  const events: string[] = [];
  const progressStages: string[] = [];
  const completedTaskIds: string[] = [];
  const failures: Array<{ id: string; errorCode: string }> = [];
  const destroyedTaskIds: string[] = [];
  let claimIndex = 0;
  let recoveryCount = 0;
  let cleanupCount = 0;

  const repository = {
    recoverInterrupted() {
      recoveryCount += 1;
      events.push("recover");
    },
    claimNext() {
      events.push("claim");
      return tasks[claimIndex++] ?? null;
    },
    async updateProgress(input: { id: string; status: string }) {
      await options.updateProgress?.(input);
      progressStages.push(input.status);
    },
    complete(input: { id: string; result: unknown }) {
      assert.deepEqual(input.result, finalResult);
      completedTaskIds.push(input.id);
    },
    async fail(input: { id: string; errorCode: string }) {
      failures.push({ id: input.id, errorCode: input.errorCode });
      await options.failTask?.(input);
    },
    findExpiredPdfTasks() {
      return [];
    },
    markPdfDeleted() {
      return false;
    },
    claimOrphanPdfDeletion() {
      return false;
    },
    findPendingPdfDeletions() {
      return [];
    },
    markPendingPdfDeleted() {},
  };

  const worker = new TaskWorker({
    repository,
    dataDir,
    concurrency: options.concurrency,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    cleanupIntervalMs: options.cleanupIntervalMs,
    cleanup: async () => {
      cleanupCount += 1;
      events.push("cleanup");
      await options.cleanup?.();
    },
    ...(options.useDefaultPdfReader
      ? {}
      : {
          readPdfBytes: async (pdfPath: string) =>
            new TextEncoder().encode(path.basename(pdfPath, ".pdf")),
        }),
    openPdf: async (bytes: Uint8Array) => {
      const taskId = new TextDecoder().decode(bytes);
      return {
        pageCount: 1,
        async renderPage() {
          return new Blob();
        },
        async renderRegion() {
          return new Blob();
        },
        async destroy() {
          destroyedTaskIds.push(taskId);
        },
      };
    },
    gateway: {} as never,
    runPipeline: async (input) => {
      const task = tasks.find((candidate) => candidate.fileName === input.fileName)!;
      if (options.processTask) return options.processTask(task, input.onProgress!);
      for (const [index, stage] of stages.entries()) {
        await input.onProgress?.({
          stage,
          progress: index * 10 + 1,
          processedPages: 1,
          totalPages: 1,
          batchIndex: 1,
          batchCount: 1,
        });
      }
      return finalResult;
    },
    logger: options.logger ?? { error() {} },
  });

  return {
    worker,
    events,
    progressStages,
    completedTaskIds,
    failures,
    destroyedTaskIds,
    get claimCount() {
      return claimIndex;
    },
    get recoveryCount() {
      return recoveryCount;
    },
    get cleanupCount() {
      return cleanupCount;
    },
  };
}

test("worker never runs more than three tasks concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const harness = makeTestWorker({
    concurrency: 3,
    queuedTaskCount: 6,
    async processTask() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return finalResult;
    },
  });

  const running = harness.worker.runAvailable();
  await waitFor(() => releases.length === 3);
  assert.equal(maximum, 3);
  releases.splice(0).forEach((release) => release());
  await waitFor(() => releases.length === 3);
  releases.splice(0).forEach((release) => release());
  await running;
  assert.equal(maximum, 3);
});

test("concurrent runAvailable callers share one three-slot budget", async () => {
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const harness = makeTestWorker({
    concurrency: 3,
    queuedTaskCount: 6,
    async processTask() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return finalResult;
    },
  });

  const first = harness.worker.runAvailable();
  const second = harness.worker.runAvailable();
  await waitFor(() => releases.length >= 3);
  assert.equal(maximum, 3);
  releases.splice(0).forEach((release) => release());
  await waitFor(() => releases.length === 3);
  releases.splice(0).forEach((release) => release());
  await Promise.all([first, second]);
  assert.equal(maximum, 3);
});

test("worker persists progress before later stages and completes independently of a caller", async () => {
  let persistedStage: string | undefined;
  const observedAfterPersistence: string[] = [];
  const orderedHarness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 1,
    async updateProgress(input) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      persistedStage = input.status;
    },
    async processTask(_task, onProgress) {
      for (const [index, stage] of stages.entries()) {
        await onProgress({
          stage,
          progress: index * 10 + 1,
          processedPages: 1,
          totalPages: 1,
          batchIndex: 1,
          batchCount: 1,
        });
        assert.equal(persistedStage, stage);
        observedAfterPersistence.push(stage);
      }
      return finalResult;
    },
  });
  await orderedHarness.worker.runAvailable();

  assert.deepEqual(observedAfterPersistence, stages);
  assert.equal(persistedStage, "finalizing");
  assert.deepEqual(orderedHarness.completedTaskIds, ["task-1"]);
});

test("worker recovers once and cleans up before its first claim", async () => {
  const harness = makeTestWorker({ concurrency: 1, queuedTaskCount: 0 });
  await harness.worker.runAvailable();
  await harness.worker.runAvailable();

  assert.equal(harness.recoveryCount, 1);
  assert.equal(harness.cleanupCount, 1);
  assert.deepEqual(harness.events.slice(0, 3), ["recover", "cleanup", "claim"]);
});

test("worker cleans up on the fifteen-minute schedule", async () => {
  assert.equal(TASK_FILE_CLEANUP_INTERVAL_MS, 15 * 60 * 1_000);
  const controller = new AbortController();
  const harness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 0,
    cleanupIntervalMs: 10,
    pollIntervalMs: 2,
  });

  const running = harness.worker.start(controller.signal);
  await waitFor(() => harness.cleanupCount >= 2);
  controller.abort("test complete");
  await running;
  assert.equal(harness.recoveryCount, 1);
});

test("worker concurrency defaults to three and accepts only integers from one to three", () => {
  assert.equal(parseTaskWorkerConcurrency(undefined), 3);
  for (const value of [1, 2, 3, "1", "2", "3"]) {
    assert.equal(parseTaskWorkerConcurrency(value), Number(value));
  }
  for (const value of [0, 4, -1, 1.5, "0", "4", "2.5", "", "many"]) {
    assert.throws(() => parseTaskWorkerConcurrency(value), /integer from 1 through 3/);
  }
});

test("worker poll interval defaults to one second and rejects unsafe values", () => {
  assert.equal(parseTaskWorkerPollInterval(undefined), 1_000);
  assert.equal(parseTaskWorkerPollInterval("250"), 250);
  for (const value of ["99", "60001", "2.5", "", "many"]) {
    assert.throws(
      () => parseTaskWorkerPollInterval(value),
      /integer from 100 through 60000/,
    );
  }
});

test("worker environment rejects an invalid poll interval before startup", () => {
  assert.throws(
    () => createTaskWorkerFromEnv({} as never, {
      PDF_AUDIT_DATA_DIR: path.join(os.tmpdir(), "pdf-checker-worker-env"),
      PDF_AUDIT_WORKER_POLL_MS: "99",
    } as unknown as NodeJS.ProcessEnv),
    /PDF_AUDIT_WORKER_POLL_MS must be an integer from 100 through 60000/,
  );
});

test("abort prevents new claims and stop waits for the current task", async () => {
  let release!: () => void;
  let started = false;
  const controller = new AbortController();
  const harness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 2,
    async processTask() {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return finalResult;
    },
  });

  const running = harness.worker.start(controller.signal);
  await waitFor(() => started);
  controller.abort("SIGTERM");
  let stopped = false;
  const stopping = harness.worker.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, false);
  release();
  await Promise.all([running, stopping]);
  assert.equal(harness.claimCount, 1);
});

test("fatal polling waits for an in-progress periodic cleanup before start and stop settle", async () => {
  let releaseFirstTask!: () => void;
  let releasePeriodicCleanup!: () => void;
  let firstTaskStarted = false;
  const controller = new AbortController();
  const harness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 2,
    pollIntervalMs: 2,
    cleanupIntervalMs: 2,
    async cleanup() {
      if (harness.cleanupCount !== 2) return;
      await new Promise<void>((resolve) => {
        releasePeriodicCleanup = resolve;
      });
    },
    async processTask(task) {
      if (task.id === "task-1") {
        firstTaskStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirstTask = resolve;
        });
        return finalResult;
      }
      throw new Error("audit failed");
    },
    async failTask(input) {
      if (input.id === "task-2") throw new Error("repository unavailable");
    },
  });

  let startSettled = false;
  const started = harness.worker.start(controller.signal);
  void started.then(
    () => { startSettled = true; },
    () => { startSettled = true; },
  );
  await waitFor(() => firstTaskStarted && harness.cleanupCount === 2);
  releaseFirstTask();
  await waitFor(() => harness.failures.some((failure) => failure.id === "task-2"));

  let stopSettled = false;
  const stopping = harness.worker.stop().then(() => {
    stopSettled = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const startSettledBeforeCleanupRelease = startSettled;
  const stopSettledBeforeCleanupRelease = stopSettled;

  releasePeriodicCleanup();
  await assert.rejects(started, /repository unavailable/);
  await stopping;
  assert.equal(startSettledBeforeCleanupRelease, false);
  assert.equal(stopSettledBeforeCleanupRelease, false);
});

test("a fatal slot stops sibling claims and rejects only after claimed work settles", async () => {
  let release!: () => void;
  let siblingStarted = false;
  const harness = makeTestWorker({
    concurrency: 2,
    queuedTaskCount: 4,
    async failTask(input) {
      if (input.id === "task-1") throw new Error("repository unavailable");
    },
    async processTask(task) {
      if (task.id === "task-1") throw new Error("audit failed");
      if (task.id !== "task-2") return finalResult;
      siblingStarted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return finalResult;
    },
  });

  let settled = false;
  const running = harness.worker.runAvailable();
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitFor(() => siblingStarted && harness.failures.length === 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  assert.equal(harness.claimCount, 2);
  release();
  await assert.rejects(running, /repository unavailable/);
  assert.equal(harness.claimCount, 2);
  assert.deepEqual(harness.completedTaskIds, ["task-2"]);
});

test("a fatal rejection without a reason still stops sibling claims", async () => {
  let release!: () => void;
  let siblingStarted = false;
  const harness = makeTestWorker({
    concurrency: 2,
    queuedTaskCount: 4,
    async failTask(input) {
      if (input.id === "task-1") return Promise.reject();
    },
    async processTask(task) {
      if (task.id === "task-1") throw new Error("audit failed");
      if (task.id !== "task-2") return finalResult;
      siblingStarted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return finalResult;
    },
  });

  const running = harness.worker.runAvailable();
  await waitFor(() => siblingStarted && harness.failures.length === 1);
  assert.equal(harness.claimCount, 2);
  release();
  await assert.rejects(running, /任务执行器发生未知致命错误/);
  assert.equal(harness.claimCount, 2);
});

test("missing and unsafe PDF paths fail without opening a file", async () => {
  const outside = path.join(os.tmpdir(), "not-private.pdf");
  const harness = makeTestWorker({
    concurrency: 1,
    useDefaultPdfReader: true,
    tasks: [
      { id: "missing", fileName: "missing.pdf", fileSize: 1, fileType: "application/pdf", pdfPath: null },
      { id: "unsafe", fileName: "unsafe.pdf", fileSize: 1, fileType: "application/pdf", pdfPath: outside },
    ],
  });

  await harness.worker.runAvailable();
  assert.deepEqual(harness.failures, [
    { id: "missing", errorCode: "PDF_INVALID" },
    { id: "unsafe", errorCode: "PDF_INVALID" },
  ]);
  assert.deepEqual(harness.completedTaskIds, []);
});

test("worker rejects a private-upload symlink that resolves outside storage", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-worker-symlink-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const uploadDir = path.join(dataDir, "uploads");
  const outsidePdf = path.join(dataDir, "outside.pdf");
  const linkedPdf = path.join(uploadDir, "linked.pdf");
  await mkdir(uploadDir, { recursive: true });
  await writeFile(outsidePdf, "%PDF-1.7");
  try {
    await symlink(outsidePdf, linkedPdf, "file");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      t.skip("Creating test symlinks requires Windows developer privileges.");
      return;
    }
    throw error;
  }

  const failures: Array<{ id: string; errorCode: string }> = [];
  let opened = false;
  const worker = new TaskWorker({
    dataDir,
    gateway: {} as never,
    repository: {
      recoverInterrupted() {},
      claimNext() {
        const task = failures.length === 0
          ? {
              id: "linked",
              fileName: "linked.pdf",
              fileSize: 8,
              fileType: "application/pdf",
              pdfPath: linkedPdf,
            }
          : null;
        return task;
      },
      updateProgress() {},
      complete() {},
      fail(input) {
        failures.push({ id: input.id, errorCode: input.errorCode });
      },
      findExpiredPdfTasks() { return []; },
      markPdfDeleted() { return false; },
      claimOrphanPdfDeletion() { return false; },
      findPendingPdfDeletions() { return []; },
      markPendingPdfDeleted() {},
    },
    openPdf: async () => {
      opened = true;
      return {
        pageCount: 1,
        renderPage: async () => new Blob(),
        renderRegion: async () => new Blob(),
        destroy: async () => {},
      };
    },
  });

  await worker.runAvailable();
  assert.equal(opened, false);
  assert.deepEqual(failures, [{ id: "linked", errorCode: "PDF_INVALID" }]);
});

test("default PDF reader passes exact bytes to the opener and closes its handle", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-worker-bytes-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const uploadDir = path.join(dataDir, "uploads");
  const pdfPath = path.join(uploadDir, "stored.pdf");
  const expected = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255]);
  await mkdir(uploadDir, { recursive: true });
  await writeFile(pdfPath, expected);

  let claimed = false;
  let received: Uint8Array | undefined;
  const worker = new TaskWorker({
    dataDir,
    gateway: {} as never,
    repository: {
      recoverInterrupted() {},
      claimNext() {
        if (claimed) return null;
        claimed = true;
        return {
          id: "stored",
          fileName: "stored.pdf",
          fileSize: expected.byteLength,
          fileType: "application/pdf",
          pdfPath,
        };
      },
      updateProgress() {},
      complete() {},
      fail() {},
      findExpiredPdfTasks() { return []; },
      markPdfDeleted() { return false; },
      claimOrphanPdfDeletion() { return false; },
      findPendingPdfDeletions() { return []; },
      markPendingPdfDeleted() {},
    },
    openPdf: async (bytes) => {
      received = bytes;
      return {
        pageCount: 1,
        renderPage: async () => new Blob(),
        renderRegion: async () => new Blob(),
        destroy: async () => {},
      };
    },
    runPipeline: async () => finalResult,
  });

  await worker.runAvailable();
  assert.deepEqual(received, expected);
  await rm(pdfPath);
});

test("worker validates the final result before completion", async () => {
  const harness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 1,
    async processTask() {
      return { outcome: "passed" } as never;
    },
  });

  await harness.worker.runAvailable();
  assert.deepEqual(harness.completedTaskIds, []);
  assert.deepEqual(harness.failures, [
    { id: "task-1", errorCode: "INVALID_MODEL_OUTPUT" },
  ]);
  assert.deepEqual(harness.destroyedTaskIds, ["task-1"]);
});

test("worker maps known PDF and model failures to safe persistence codes", async () => {
  const cases: Array<[Error, string]> = [
    [new ServerPdfError("PDF_ENCRYPTED"), "PDF_ENCRYPTED"],
    [new ServerPdfError("PDF_UNSUPPORTED"), "PDF_INVALID"],
    [new ServerPdfError("PDF_IMAGE_TOO_LARGE"), "PDF_RENDER_FAILED"],
    [new BailianClientError("UPSTREAM_ERROR", "private upstream detail"), "MODEL_UNAVAILABLE"],
    [new BailianClientError("INVALID_MODEL_OUTPUT", "raw model response"), "INVALID_MODEL_OUTPUT"],
  ];

  for (const [failure, expectedCode] of cases) {
    const harness = makeTestWorker({
      concurrency: 1,
      queuedTaskCount: 1,
      async processTask() {
        throw failure;
      },
    });
    await harness.worker.runAvailable();
    assert.equal(harness.failures[0]?.errorCode, expectedCode);
  }
});

test("worker logs diagnostics without paths or untrusted payloads", async () => {
  const logEntries: unknown[] = [];
  const harness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 1,
    logger: {
      error(message, context) {
        logEntries.push({ message, context });
      },
    },
    async processTask() {
      throw new Error("C:\\private\\input.pdf data:image/png;base64,SECRET raw model response");
    },
  });

  await harness.worker.runAvailable();
  const serialized = JSON.stringify(logEntries);
  assert.match(serialized, /task-1/);
  assert.match(serialized, /INTERNAL_ERROR/);
  assert.doesNotMatch(serialized, /private|data:image|SECRET|raw model response/i);
});

test("worker persists a failed task even when diagnostics logging throws", async () => {
  const harness = makeTestWorker({
    concurrency: 1,
    queuedTaskCount: 1,
    logger: {
      error() {
        throw new Error("logger unavailable");
      },
    },
    async processTask() {
      throw new Error("audit failed");
    },
  });

  await harness.worker.runAvailable();
  assert.deepEqual(harness.failures, [
    { id: "task-1", errorCode: "INTERNAL_ERROR" },
  ]);
});

test("stopped or completed workers reject later start calls without reinitializing", async () => {
  const stopped = makeTestWorker({ concurrency: 1, queuedTaskCount: 0 });
  await stopped.worker.stop();
  await assert.rejects(
    stopped.worker.start(new AbortController().signal),
    /cannot be started again/,
  );
  assert.equal(stopped.recoveryCount, 0);
  assert.equal(stopped.cleanupCount, 0);
  assert.equal(stopped.claimCount, 0);

  const completed = makeTestWorker({ concurrency: 1, queuedTaskCount: 0 });
  const controller = new AbortController();
  const firstStart = completed.worker.start(controller.signal);
  await waitFor(() => completed.cleanupCount === 1);
  controller.abort("test complete");
  await firstStart;
  const recoveryCount = completed.recoveryCount;
  const cleanupCount = completed.cleanupCount;
  await assert.rejects(
    completed.worker.start(new AbortController().signal),
    /cannot be started again/,
  );
  assert.equal(completed.recoveryCount, recoveryCount);
  assert.equal(completed.cleanupCount, cleanupCount);
});

test("stopped or completed workers reject manual drains without reinitializing", async () => {
  const stopped = makeTestWorker({ concurrency: 1, queuedTaskCount: 0 });
  await stopped.worker.stop();
  await assert.rejects(stopped.worker.runAvailable(), /cannot run again/);
  assert.equal(stopped.recoveryCount, 0);
  assert.equal(stopped.cleanupCount, 0);
  assert.equal(stopped.claimCount, 0);

  const completed = makeTestWorker({ concurrency: 1, queuedTaskCount: 0 });
  const controller = new AbortController();
  const started = completed.worker.start(controller.signal);
  await waitFor(() => completed.cleanupCount === 1);
  controller.abort("test complete");
  await started;
  const recoveryCount = completed.recoveryCount;
  const cleanupCount = completed.cleanupCount;
  const claimCount = completed.claimCount;
  await assert.rejects(completed.worker.runAvailable(), /cannot run again/);
  assert.equal(completed.recoveryCount, recoveryCount);
  assert.equal(completed.cleanupCount, cleanupCount);
  assert.equal(completed.claimCount, claimCount);
});
