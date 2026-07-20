import assert from "node:assert/strict";
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
  parseTaskWorkerConcurrency,
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
    openPdf: async (pdfPath: string) => {
      const taskId = path.basename(pdfPath, ".pdf");
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

test("runAvailable waits for sibling slots before reporting a repository failure", async () => {
  let release!: () => void;
  let siblingStarted = false;
  const harness = makeTestWorker({
    concurrency: 2,
    queuedTaskCount: 2,
    async failTask(input) {
      if (input.id === "task-1") throw new Error("repository unavailable");
    },
    async processTask(task) {
      if (task.id === "task-1") throw new Error("audit failed");
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
  release();
  await assert.rejects(running, /repository unavailable/);
  assert.deepEqual(harness.completedTaskIds, ["task-2"]);
});

test("missing and unsafe PDF paths fail without opening a file", async () => {
  const outside = path.join(os.tmpdir(), "not-private.pdf");
  const harness = makeTestWorker({
    concurrency: 1,
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
