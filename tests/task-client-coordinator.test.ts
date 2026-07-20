import assert from "node:assert/strict";
import test from "node:test";
import {
  SharedUploadQueue,
  TaskViewState,
  TaskPollingController,
  mergeTaskByFreshness,
  removeCheckedTaskId,
  runReleasingUploadQueue,
  type PollingEnvironment,
} from "../lib/client/task-coordinator";
import type { AuditTaskDetail } from "../lib/types";

function task(id: string, updatedAt: string, progress: number): AuditTaskDetail {
  return {
    id,
    fileName: `${id}.pdf`,
    fileSize: 1,
    fileType: "application/pdf",
    status: progress === 100 ? "completed" : "rendering",
    outcome: progress === 100 ? "passed" : null,
    model: "qwen3.7-plus",
    progress,
    processedPages: 0,
    totalPages: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt,
    startedAt: null,
    completedAt: progress === 100 ? updatedAt : null,
    errorCode: null,
    errorMessage: null,
    issueCount: progress === 100 ? 0 : null,
    summary: null,
    pdfExpiresAt: null,
    pdfAvailable: false,
    reportText: null,
    report: null,
  };
}

test("upload queue caps requests at three and releases each item as it settles", async () => {
  const files = [1, 2, 3, 4, 5];
  const releases: Array<() => void> = [];
  const released: number[] = [];
  let active = 0;
  let peak = 0;
  const running = runReleasingUploadQueue(
    files,
    3,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value;
    },
    (index) => released.push(index),
  );

  await waitFor(() => releases.length === 3);
  assert.equal(peak, 3);
  releases.splice(0).forEach((release) => release());
  await waitFor(() => released.length === 3 && releases.length === 2);
  assert.deepEqual(released.slice().sort(), [0, 1, 2]);
  releases.splice(0).forEach((release) => release());
  await running;
  assert.equal(peak, 3);
  assert.deepEqual(released.slice().sort(), [0, 1, 2, 3, 4]);
});

test("freshness merge prevents older polling responses from reverting task state", () => {
  const current = task("one", "2026-07-20T00:02:00.000Z", 100);
  const stale = task("one", "2026-07-20T00:01:00.000Z", 40);
  assert.equal(mergeTaskByFreshness(current, stale), current);
  assert.equal(
    mergeTaskByFreshness(current, task("one", "2026-07-20T00:03:00.000Z", 100)).updatedAt,
    "2026-07-20T00:03:00.000Z",
  );
});

test("polling uses foreground/background cadence and ignores work after cleanup", async () => {
  let visibility: DocumentVisibilityState = "visible";
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Set<() => void>();
  const environment: PollingEnvironment = {
    getVisibility: () => visibility,
    setTimer(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    addVisibilityListener(listener) { listeners.add(listener); },
    removeVisibilityListener(listener) { listeners.delete(listener); },
  };
  let resolveFetch!: (value: AuditTaskDetail) => void;
  const applied: string[] = [];
  const controller = new TaskPollingController({
    taskIds: ["one"],
    environment,
    fetchTask: async () => new Promise<AuditTaskDetail>((resolve) => { resolveFetch = resolve; }),
    onTask: (value) => applied.push(value.id),
  });

  controller.start();
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [2_000]);
  visibility = "hidden";
  listeners.forEach((listener) => listener());
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [5_000]);
  const timer = [...timers.values()][0];
  timer?.callback();
  await waitFor(() => typeof resolveFetch === "function");
  controller.stop();
  resolveFetch(task("one", "2026-07-20T00:03:00.000Z", 100));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(applied, []);
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

test("one shared upload queue caps interleaved batches and stays busy until all settle", async () => {
  const queue = new SharedUploadQueue<{ id: number }, number>(3);
  const resolvers = new Map<number, () => void>();
  const released: number[] = [];
  let peak = 0;
  const worker = async (file: { id: number }) => {
    peak = Math.max(peak, queue.snapshot().active);
    await new Promise<void>((resolve) => resolvers.set(file.id, resolve));
    return file.id;
  };

  const first = queue.enqueue(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    worker,
    (file) => released.push(file.id),
  );
  const second = queue.enqueue(
    [{ id: 4 }, { id: 5 }, { id: 6 }],
    worker,
    (file) => released.push(file.id),
  );

  await waitFor(() => resolvers.size === 3);
  assert.deepEqual(queue.snapshot(), { active: 3, pending: 3, outstanding: 6, busy: true });
  resolvers.get(1)?.();
  await waitFor(() => released.includes(1) && resolvers.has(4));
  assert.equal(queue.snapshot().active, 3);
  assert.equal(queue.snapshot().busy, true);
  resolvers.get(2)?.();
  resolvers.get(3)?.();
  await first;
  assert.equal(queue.snapshot().busy, true, "the second batch still owns work");
  assert.deepEqual(released.slice().sort(), [1, 2, 3]);
  resolvers.get(4)?.();
  resolvers.get(5)?.();
  resolvers.get(6)?.();
  await second;
  assert.equal(peak, 3);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, outstanding: 0, busy: false });
  assert.deepEqual(released.slice().sort(), [1, 2, 3, 4, 5, 6]);
});

test("aborting the shared upload queue releases pending and active items and settles every batch", async () => {
  const queue = new SharedUploadQueue<{ id: number }, number>(2);
  const released: number[] = [];
  const batch = queue.enqueue(
    Array.from({ length: 5 }, (_, index) => ({ id: index + 1 })),
    async (_file, signal) =>
      new Promise<number>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
    (file) => released.push(file.id),
  );
  await waitFor(() => queue.snapshot().active === 2);
  queue.abort();
  const results = await batch;
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.deepEqual(released.slice().sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, outstanding: 0, busy: false });
});

test("an async read started before retry cannot overwrite queued state with the same timestamp", () => {
  const state = new TaskViewState();
  const failed = { ...task("one", "2026-07-20T00:03:00.000Z", 100), status: "failed" as const, outcome: "failed" as const };
  const initial = state.beginList({ limit: 80 });
  state.completeList([failed], initial);

  const oldRead = state.beginRead("one");
  const retry = state.beginAction("one");
  const queued = {
    ...failed,
    status: "queued" as const,
    outcome: null,
    progress: 0,
    completedAt: null,
  };
  assert.equal(state.applyAction(queued, retry, true), true);
  assert.equal(state.applyRead(failed, oldRead), false);
  assert.equal(state.visibleTasks()[0]?.status, "queued");
  assert.equal(isActive(state.visibleTasks()[0]), true);
});

test("stale list rows and deleted tombstones cannot resurrect pre-action state", () => {
  const state = new TaskViewState();
  const failed = { ...task("one", "2026-07-20T00:03:00.000Z", 100), status: "failed" as const, outcome: "failed" as const };
  state.completeList([failed], state.beginList({ limit: 80 }));

  const staleList = state.beginList({ limit: 80 });
  const retry = state.beginAction("one");
  state.applyAction({ ...failed, status: "queued", outcome: null, progress: 0, completedAt: null }, retry, true);
  state.completeList([failed], staleList);
  assert.equal(state.visibleTasks()[0]?.status, "queued");

  const beforeDelete = state.beginList({ limit: 80 });
  const deletion = state.beginAction("one");
  assert.equal(state.markDeleted("one", deletion), true);
  state.completeList([failed], beforeDelete);
  assert.deepEqual(state.visibleTasks(), []);
});

test("a list started during retry cannot replace the later queued response", () => {
  const state = new TaskViewState();
  const failed = {
    ...task("one", "2026-07-20T00:03:00.000Z", 100),
    status: "failed" as const,
    outcome: "failed" as const,
  };
  state.completeList([failed], state.beginList({ limit: 80 }));

  const retry = state.beginAction("one");
  const listDuringRetry = state.beginList({ limit: 80 });
  state.applyAction(
    {
      ...failed,
      status: "queued",
      outcome: null,
      progress: 0,
      completedAt: null,
    },
    retry,
    false,
  );
  state.completeList([failed], listDuringRetry);

  assert.equal(state.visibleTasks()[0]?.status, "queued");
  assert.equal(state.visibleTasks()[0]?.progress, 0);
});

test("server-filtered view keeps nonmatching local actions hidden and ignores superseded filters", () => {
  const state = new TaskViewState();
  const alpha = { ...task("alpha", "2026-07-20T00:03:00.000Z", 100), fileName: "Alpha.pdf" };
  const beta = { ...task("beta", "2026-07-20T00:03:00.000Z", 100), fileName: "Beta.pdf" };
  state.completeList([alpha], state.beginList({ query: "Alpha", limit: 80 }));

  const betaUpload = state.beginAction("beta");
  state.applyAction(beta, betaUpload, true);
  assert.deepEqual(state.visibleTasks().map((value) => value.id), ["alpha"]);

  const staleAlpha = state.beginList({ query: "Alpha", limit: 80 });
  const betaRequest = state.beginList({ query: "Beta", limit: 80 });
  assert.deepEqual(state.visibleTasks(), []);
  state.completeList([beta], betaRequest);
  state.completeList([alpha], staleAlpha);
  assert.deepEqual(state.visibleTasks().map((value) => value.id), ["beta"]);

  const hiddenRead = state.beginRead("alpha");
  state.applyRead(alpha, hiddenRead);
  assert.deepEqual(state.visibleTasks().map((value) => value.id), ["beta"]);
});

function isActive(value: AuditTaskDetail | undefined) {
  return value?.status === "queued" || value?.status === "rendering";
}

test("retry selection cleanup removes only the retried task", () => {
  const current = new Set(["retry-me", "keep-me"]);
  const next = removeCheckedTaskId(current, "retry-me");
  assert.deepEqual([...next], ["keep-me"]);
  assert.deepEqual([...current], ["retry-me", "keep-me"]);
});
