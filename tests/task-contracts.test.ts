import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalAuditResult } from "../lib/audit-result";
import {
  AuditTaskDetailSchema,
  BatchDeleteRequestSchema,
  TaskImportRequestSchema,
  TaskListQuerySchema,
} from "../lib/task-contracts";
import { strictFinalizeRequest } from "./strict-fixtures";

const finalResult = buildFinalAuditResult(strictFinalizeRequest);

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
    outcome: finalResult.outcome,
    model: finalResult.model,
    progress: 100,
    processedPages: finalResult.summary.pageCount,
    totalPages: finalResult.summary.pageCount,
    completedAt: "2026-07-20T00:01:00.000Z",
    issueCount: finalResult.report.issues.length,
    summary: finalResult.summary,
    reportText: finalResult.reportText,
    report: finalResult.report,
  };
  assert.deepEqual(TaskImportRequestSchema.parse({ tasks: [completed] }), {
    tasks: [completed],
  });
  assert.throws(() => TaskImportRequestSchema.parse({
    tasks: [{ ...completed, summary: null, reportText: null, report: null, issueCount: null }],
  }));
  assert.throws(() => TaskImportRequestSchema.parse({
    tasks: [{ ...completed, issueCount: completed.issueCount + 1 }],
  }));
  assert.throws(() => TaskImportRequestSchema.parse({
    tasks: [{ ...completed, processedPages: completed.processedPages - 1 }],
  }));
  assert.deepEqual(TaskImportRequestSchema.parse({
    tasks: [{
      ...queued,
      status: "failed",
      outcome: "failed",
      progress: 100,
      completedAt: "2026-07-20T00:01:00.000Z",
      errorCode: "PDF_INVALID",
      errorMessage: "The PDF could not be processed.",
    }],
  }).tasks[0]?.status, "failed");
});
