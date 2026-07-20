import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskPollingController,
  mergeTaskByFreshness,
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
