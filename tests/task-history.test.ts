import assert from "node:assert/strict";
import test from "node:test";
import {
  filterHistoryTasks,
  historyFiltersToTaskListFilters,
  removeHistoryTasks,
  upsertHistoryTask,
} from "../lib/client/task-history";
import type { AuditTaskDetail } from "../lib/types";

function task(id: string, fileName: string, createdAt: Date): AuditTaskDetail {
  const timestamp = createdAt.toISOString();
  return {
    id,
    fileName,
    fileSize: 100,
    fileType: "application/pdf",
    status: "completed",
    outcome: "passed",
    model: "qwen3.7-plus",
    progress: 100,
    processedPages: 1,
    totalPages: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    errorCode: null,
    errorMessage: null,
    issueCount: 0,
    summary: null,
    pdfExpiresAt: null,
    pdfAvailable: false,
    reportText: null,
    report: null,
  };
}

const now = new Date(2026, 6, 18, 12, 0, 0);
const tasks = [
  task("today", "Alpha Report.pdf", new Date(2026, 6, 18, 9)),
  task("six-days-ago", "Beta.pdf", new Date(2026, 6, 12, 9)),
  task("custom-end", "Delta.pdf", new Date(2026, 5, 3, 23, 59)),
  task("custom-start", "Gamma.pdf", new Date(2026, 5, 1, 0)),
  task("old", "Archive.pdf", new Date(2026, 4, 1, 9)),
];

test("filters task names without case or surrounding-space sensitivity", () => {
  const filtered = filterHistoryTasks(
    tasks,
    {
      query: "  ALPHA  ",
      dateFilter: "all",
      customStart: "",
      customEnd: "",
    },
    now,
  );

  assert.deepEqual(filtered.map((item) => item.id), ["today"]);
});

test("filters today and the latest seven and thirty calendar days", () => {
  const options = {
    query: "",
    customStart: "",
    customEnd: "",
  };

  assert.deepEqual(
    filterHistoryTasks(tasks, { ...options, dateFilter: "today" }, now).map(
      (item) => item.id,
    ),
    ["today"],
  );
  assert.deepEqual(
    filterHistoryTasks(tasks, { ...options, dateFilter: "7d" }, now).map(
      (item) => item.id,
    ),
    ["today", "six-days-ago"],
  );
  assert.deepEqual(
    filterHistoryTasks(tasks, { ...options, dateFilter: "30d" }, now).map(
      (item) => item.id,
    ),
    ["today", "six-days-ago"],
  );
});

test("combines name search with an inclusive custom date range", () => {
  const filtered = filterHistoryTasks(
    tasks,
    {
      query: ".pdf",
      dateFilter: "custom",
      customStart: "2026-06-01",
      customEnd: "2026-06-03",
    },
    now,
  );

  assert.deepEqual(filtered.map((item) => item.id), [
    "custom-end",
    "custom-start",
  ]);
});

test("treats invalid custom dates as open boundaries", () => {
  assert.equal(
    filterHistoryTasks(
      tasks,
      {
        query: "",
        dateFilter: "custom",
        customStart: "invalid",
        customEnd: "",
      },
      now,
    ).length,
    tasks.length,
  );
});

test("upserts without losing other task updates and sorts newest first", () => {
  const first = task("first", "First.pdf", new Date(2026, 6, 1));
  const second = task("second", "Second.pdf", new Date(2026, 6, 2));
  const updatedSecond = {
    ...second,
    status: "failed" as const,
    createdAt: new Date(2026, 6, 3).toISOString(),
  };

  const next = upsertHistoryTask([first, second], updatedSecond);

  assert.deepEqual(next.map((item) => item.id), ["second", "first"]);
  assert.equal(next[0]?.status, "failed");
});

test("upsert caps history at eighty tasks", () => {
  const many = Array.from({ length: 81 }, (_, index) =>
    task(String(index), `${index}.pdf`, new Date(2026, 0, index + 1)),
  );

  assert.equal(upsertHistoryTask(many.slice(1), many[0]).length, 80);
});

test("removes only requested task IDs and ignores missing IDs", () => {
  const next = removeHistoryTasks(
    tasks,
    new Set(["six-days-ago", "missing"]),
  );

  assert.deepEqual(next.map((item) => item.id), [
    "today",
    "custom-end",
    "custom-start",
    "old",
  ]);
});

test("converts local calendar filters into bounded server query timestamps", () => {
  assert.deepEqual(
    historyFiltersToTaskListFilters(
      {
        query: "  Alpha  ",
        dateFilter: "7d",
        customStart: "",
        customEnd: "",
      },
      now,
    ),
    {
      query: "Alpha",
      createdFrom: new Date(2026, 6, 12).toISOString(),
      createdTo: new Date(2026, 6, 19).toISOString(),
      limit: 80,
    },
  );
});
