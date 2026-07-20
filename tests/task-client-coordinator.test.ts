import assert from "node:assert/strict";
import test from "node:test";
import {
  SharedUploadQueue,
  TaskViewState,
  TaskPollingController,
  detailFromTaskSummary,
  isActiveTask,
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

test("summary conversion preserves a report only for the identical terminal snapshot", () => {
  const previous = {
    ...task("one", "2026-07-20T00:03:00.000Z", 100),
    reportText: "trusted report",
  };
  const { reportText: _reportText, report: _report, ...sameSummary } = previous;
  void _reportText;
  void _report;
  assert.equal(
    detailFromTaskSummary(sameSummary, previous).reportText,
    "trusted report",
  );
  assert.equal(
    detailFromTaskSummary(
      { ...sameSummary, updatedAt: "2026-07-20T00:04:00.000Z" },
      previous,
    ).reportText,
    null,
  );
  assert.equal(
    detailFromTaskSummary(
      { ...sameSummary, status: "failed", outcome: "failed" },
      previous,
    ).reportText,
    null,
  );
  assert.equal(
    detailFromTaskSummary({ ...sameSummary, id: "other-task" }, previous)
      .reportText,
    null,
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

test("a newer read is authoritative when equal-timestamp responses arrive in reverse order", () => {
  const state = new TaskViewState();
  const failed = {
    ...task("one", "2026-07-20T00:03:00.000Z", 100),
    status: "failed" as const,
    outcome: "failed" as const,
  };
  state.completeList([failed], state.beginList({ limit: 80 }));
  const olderRead = state.beginRead("one");
  const newerRead = state.beginRead("one");
  const queued = {
    ...failed,
    status: "queued" as const,
    outcome: null,
    progress: 0,
    completedAt: null,
  };

  assert.equal(state.applyRead(queued, newerRead), true);
  assert.equal(state.applyRead(failed, olderRead), false);
  assert.equal(state.visibleTasks()[0]?.status, "queued");
  assert.equal(state.visibleTasks()[0]?.progress, 0);
});

test("an old list cannot overwrite a newer detail or polling snapshot", () => {
  const state = new TaskViewState();
  const failed = {
    ...task("one", "2026-07-20T00:03:00.000Z", 100),
    status: "failed" as const,
    outcome: "failed" as const,
  };
  state.completeList([failed], state.beginList({ limit: 80 }));
  const olderList = state.beginList({ limit: 80 });
  const newerRead = state.beginRead("one");
  const queued = {
    ...failed,
    status: "queued" as const,
    outcome: null,
    progress: 0,
    completedAt: null,
  };

  state.applyRead(queued, newerRead);
  state.completeList([failed], olderList);
  assert.equal(state.visibleTasks()[0]?.status, "queued");
  assert.equal(state.visibleTasks()[0]?.progress, 0);
});

test("a newer same-filter list remains authoritative when the older list arrives late", () => {
  const state = new TaskViewState();
  const olderList = state.beginList({ query: "one", limit: 80 });
  const newerList = state.beginList({ query: "one", limit: 80 });
  const failed = {
    ...task("one", "2026-07-20T00:03:00.000Z", 100),
    status: "failed" as const,
    outcome: "failed" as const,
  };
  const queued = {
    ...failed,
    status: "queued" as const,
    outcome: null,
    progress: 0,
    completedAt: null,
  };

  state.completeList([queued], newerList);
  state.completeList([failed], olderList);
  assert.equal(state.visibleTasks()[0]?.status, "queued");
});

test("an action response invalidates reads that started while the action was pending", () => {
  const state = new TaskViewState();
  const failed = {
    ...task("one", "2026-07-20T00:03:00.000Z", 100),
    status: "failed" as const,
    outcome: "failed" as const,
  };
  state.completeList([failed], state.beginList({ limit: 80 }));
  const retry = state.beginAction("one");
  const readDuringRetry = state.beginRead("one");
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

  assert.equal(state.applyRead(failed, readDuringRetry), false);
  assert.equal(state.visibleTasks()[0]?.status, "queued");
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

test("a matching upload keeps an eighty-row view bounded and evicts the oldest active task", () => {
  const state = new TaskViewState();
  const initial = Array.from({ length: 80 }, (_, index) => ({
    ...task(
      `task-${index.toString().padStart(2, "0")}`,
      new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString(),
      40,
    ),
    createdAt: new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString(),
  }));
  state.completeList(initial, state.beginList({ limit: 80 }));
  const newest = {
    ...task("new-upload", "2026-07-20T02:00:00.000Z", 0),
    status: "queued" as const,
    createdAt: "2026-07-20T02:00:00.000Z",
  };
  const upload = state.beginAction(newest.id);
  state.applyAction(newest, upload, true);

  const visible = state.visibleTasks();
  const activeIds = visible.filter(isActiveTask).map((value) => value.id);
  assert.equal(visible.length, 80);
  assert.equal(activeIds.length, 80);
  assert.equal(activeIds.includes("new-upload"), true);
  assert.equal(activeIds.includes("task-00"), false);
  assert.ok(state.task("task-00"), "evicted rows may remain in the cache");
});

test("changing a filter limit bounds the current view before the server responds", () => {
  const state = new TaskViewState();
  const rows = Array.from({ length: 5 }, (_, index) => ({
    ...task(`row-${index}`, `2026-07-20T00:0${index}:00.000Z`, 100),
    createdAt: `2026-07-20T00:0${index}:00.000Z`,
  }));
  state.completeList(rows, state.beginList({ limit: 5 }));
  state.beginList({ limit: 2 });
  assert.deepEqual(
    state.visibleTasks().map((value) => value.id),
    ["row-4", "row-3"],
  );
});

test("a matching upload remains visible when the bounded rows share its creation timestamp", () => {
  const state = new TaskViewState();
  const sameCreatedAt = "2026-07-20T00:01:00.000Z";
  const existing = ["first", "second"].map((id) => ({
    ...task(id, sameCreatedAt, 100),
    createdAt: sameCreatedAt,
  }));
  state.completeList(existing, state.beginList({ limit: 2 }));
  const upload = {
    ...task("new-upload", sameCreatedAt, 0),
    status: "queued" as const,
    createdAt: sameCreatedAt,
  };
  state.applyAction(upload, state.beginAction(upload.id), true);
  assert.equal(state.visibleTasks().length, 2);
  assert.equal(
    state.visibleTasks().some((value) => value.id === "new-upload"),
    true,
  );
});

test("a matching upload remains visible when an older bounded list completes afterward", () => {
  const state = new TaskViewState();
  const sameCreatedAt = "2026-07-20T00:01:00.000Z";
  const pendingList = state.beginList({ limit: 2 });
  const upload = {
    ...task("new-upload", sameCreatedAt, 0),
    status: "queued" as const,
    createdAt: sameCreatedAt,
  };
  state.applyAction(upload, state.beginAction(upload.id), true);
  const serverRows = ["first", "second"].map((id) => ({
    ...task(id, sameCreatedAt, 100),
    createdAt: sameCreatedAt,
  }));
  state.completeList(serverRows, pendingList);
  assert.equal(state.visibleTasks().length, 2);
  assert.equal(
    state.visibleTasks().some((value) => value.id === "new-upload"),
    true,
  );
});

test("local filtering treats percent as the server SQL LIKE multi-character wildcard", () => {
  const state = new TaskViewState();
  state.beginList({ query: "report%2026", limit: 80 });
  const matching = {
    ...task("percent", "2026-07-20T00:01:00.000Z", 100),
    fileName: "report-final-2026.pdf",
  };
  state.applyAction(matching, state.beginAction(matching.id), true);
  assert.deepEqual(state.visibleTasks().map((value) => value.id), ["percent"]);
});

test("local filtering treats underscore as the server SQL LIKE single-character wildcard", () => {
  const state = new TaskViewState();
  state.beginList({ query: "report_2026", limit: 80 });
  const matching = {
    ...task("underscore", "2026-07-20T00:01:00.000Z", 100),
    fileName: "reportA2026.pdf",
  };
  state.applyAction(matching, state.beginAction(matching.id), true);
  assert.deepEqual(state.visibleTasks().map((value) => value.id), ["underscore"]);
});

test("local SQL LIKE filtering treats regex syntax as literal text", () => {
  const state = new TaskViewState();
  state.beginList({ query: "[final]", limit: 80 });
  const literal = {
    ...task("literal", "2026-07-20T00:01:00.000Z", 100),
    fileName: "scan[final].pdf",
  };
  const notLiteral = {
    ...task("not-literal", "2026-07-20T00:02:00.000Z", 100),
    fileName: "scanf.pdf",
  };
  state.applyAction(literal, state.beginAction(literal.id), true);
  state.applyAction(notLiteral, state.beginAction(notLiteral.id), true);
  assert.deepEqual(state.visibleTasks().map((value) => value.id), ["literal"]);
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
