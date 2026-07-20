import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditTaskDetailSchema,
  BatchDeleteRequestSchema,
  TaskImportRequestSchema,
  TaskListQuerySchema,
} from "../lib/task-contracts";

test("task list query bounds pagination and normalizes filters", () => {
  assert.deepEqual(
    TaskListQuerySchema.parse({ query: "  report ", limit: "80" }),
    { query: "report", limit: 80 },
  );
  assert.throws(() => TaskListQuerySchema.parse({ limit: "201" }));
});

test("batch delete accepts at most one hundred unique task ids", () => {
  assert.deepEqual(
    BatchDeleteRequestSchema.parse({ ids: ["a", "a", "b"] }),
    { ids: ["a", "b"] },
  );
  assert.throws(() =>
    BatchDeleteRequestSchema.parse({
      ids: Array.from({ length: 101 }, (_, index) => `task-${index}`),
    }),
  );
});

test("legacy import accepts terminal tasks only", () => {
  const queued = {
    id: "legacy-1",
    fileName: "case.pdf",
    fileSize: 12,
    fileType: "application/pdf",
    status: "queued",
    outcome: null,
    model: null,
    progress: 0,
    processedPages: 0,
    totalPages: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    issueCount: null,
    summary: null,
    pdfExpiresAt: null,
    pdfAvailable: false,
    reportText: null,
    report: null,
  };
  assert.throws(() => TaskImportRequestSchema.parse({ tasks: [queued] }));
  assert.throws(() => AuditTaskDetailSchema.parse({ ...queued, status: "unknown" }));
  const completed = {
    ...queued,
    status: "completed",
    outcome: "passed",
    progress: 100,
    completedAt: "2026-07-20T00:01:00.000Z",
  };
  assert.deepEqual(TaskImportRequestSchema.parse({ tasks: [completed] }), {
    tasks: [completed],
  });
});
