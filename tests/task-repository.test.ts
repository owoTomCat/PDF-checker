import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFinalAuditResult } from "../lib/audit-result";
import { openTaskDatabase } from "../lib/server/task-database";
import {
  MAX_TASK_ATTEMPTS,
  TaskRepository,
  type FailTaskInput,
} from "../lib/server/task-repository";
import { strictFinalizeRequest } from "./strict-fixtures";

test("repository isolates owners and atomically claims oldest queued work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-db-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);

  repository.create({
    id: "older",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "older.pdf"),
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });
  repository.create({
    id: "newer",
    ownerEmail: "b@example.com",
    fileName: "b.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "newer.pdf"),
    pdfExpiresAt: "2026-07-23T00:01:00.000Z",
    now: "2026-07-20T00:01:00.000Z",
  });

  assert.deepEqual(repository.list("a@example.com", { limit: 80 }).items.map((item) => item.id), ["older"]);
  assert.equal(repository.claimNext("2026-07-20T00:02:00.000Z")?.id, "older");
  assert.equal(repository.claimNext("2026-07-20T00:02:01.000Z")?.id, "newer");
  assert.equal(repository.claimNext("2026-07-20T00:02:02.000Z"), null);
});

test("restart recovery requeues twice and fails the third interrupted claim", async (t) => {
  assert.equal(MAX_TASK_ATTEMPTS, 3);
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-recovery-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "retry-me",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "retry-me.pdf"),
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });

  for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
    repository.claimNext(`2026-07-20T00:0${attempt}:00.000Z`);
    repository.recoverInterrupted(`2026-07-20T00:0${attempt}:30.000Z`);
  }
  const task = repository.getOwned("a@example.com", "retry-me");
  assert.equal(task?.status, "failed");
  assert.equal(task?.errorCode, "WORKER_RETRY_EXHAUSTED");
});

test("cooperative shutdown requeues only its active claim without consuming an attempt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-shutdown-requeue-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "shutdown-task",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "shutdown-task.pdf"),
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });
  repository.claimNext("2026-07-20T00:01:00.000Z");
  assert.equal(repository.requeueClaimAfterShutdown("shutdown-task", "2026-07-20T00:02:00.000Z"), true);
  const task = repository.getOwnedWorker("a@example.com", "shutdown-task");
  assert.equal(task?.status, "queued");
  assert.equal(task?.progress, 0);
  assert.equal(task?.processedPages, 0);
  assert.equal(task?.errorCode, null);
  assert.equal(task?.attemptCount, 0);
  assert.equal(repository.requeueClaimAfterShutdown("shutdown-task", "2026-07-20T00:03:00.000Z"), false);
});

test("cleanup never reserves queued work after its retained PDF expires", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-cleanup-race-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "retry-race",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "retry-race.pdf"),
    pdfExpiresAt: "2000-01-01T00:00:00.000Z",
    now: "1999-12-30T00:00:00.000Z",
  });
  repository.complete({
    id: "retry-race",
    result: buildFinalAuditResult(strictFinalizeRequest),
    now: "1999-12-30T00:01:00.000Z",
  });
  assert.equal(
    repository.retryOwned("a@example.com", "retry-race", "1999-12-31T12:00:00.000Z")?.status,
    "queued",
  );
  assert.equal(repository.markPdfDeleted("retry-race", "2000-01-02T00:00:00.000Z"), false);
  const task = repository.getOwned("a@example.com", "retry-race");
  assert.equal(task?.status, "queued");
  assert.equal(task?.pdfAvailable, false);
});

test("cleanup reserves an unchanged expired terminal PDF", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-cleanup-reserve-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "expired-terminal",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "expired-terminal.pdf"),
    pdfExpiresAt: "2026-07-20T00:00:00.000Z",
    now: "2026-07-19T00:00:00.000Z",
  });
  repository.fail({
    id: "expired-terminal",
    errorCode: "PDF_INVALID",
    errorMessage: "C:\\private\\expired-terminal.pdf",
    now: "2026-07-19T00:01:00.000Z",
  } as unknown as FailTaskInput);

  const candidate = repository.findExpiredPdfTasks("2026-07-21T00:00:00.000Z")[0];
  assert.equal(candidate?.id, "expired-terminal");
  assert.equal(repository.markPdfDeleted(candidate!.id, "2026-07-21T00:00:00.000Z"), true);
  assert.equal(repository.findExpiredPdfTasks("2026-07-21T00:00:00.000Z").length, 0);
});

test("failure persistence normalizes unknown codes and excludes caller-supplied details", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-safe-errors-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "safe-error",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "safe-error.pdf"),
    pdfExpiresAt: "2099-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });
  repository.fail({
    id: "safe-error",
    errorCode: "UNTRUSTED_WORKER_EXCEPTION",
    errorMessage: "C:\\private\\safe-error.pdf: parser stack trace",
    now: "2026-07-20T00:01:00.000Z",
  } as unknown as FailTaskInput);

  const task = repository.getOwned("a@example.com", "safe-error");
  assert.equal(task?.errorCode, "INTERNAL_ERROR");
  assert.equal(task?.errorMessage, "The audit could not be completed.");
  assert.doesNotMatch(task?.errorMessage ?? "", /private|stack trace/i);
});

test("rejects invalid final results before mutating a task", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-final-result-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "invalid-final",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "invalid-final.pdf"),
    pdfExpiresAt: "2099-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });

  assert.throws(() => repository.complete({
    id: "invalid-final",
    result: { outcome: "passed" },
    now: "2026-07-20T00:01:00.000Z",
  }));
  assert.equal(repository.getOwned("a@example.com", "invalid-final")?.status, "queued");
});

test("expired PDFs are unavailable before cleanup runs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-expired-availability-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  repository.create({
    id: "expired-availability",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "expired-availability.pdf"),
    pdfExpiresAt: "2000-01-01T00:00:00.000Z",
    now: "1999-12-31T00:00:00.000Z",
  });

  assert.equal(repository.getOwned("a@example.com", "expired-availability")?.pdfAvailable, false);
});

test("orphan deletion claims arbitrate atomically with task creation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-orphan-claims-"));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TaskRepository(db);
  const createWinsPath = path.join(root, "uploads", "create-wins.pdf");
  const claimWinsPath = path.join(root, "uploads", "claim-wins.pdf");
  const now = "2026-07-20T00:00:00.000Z";

  repository.create({
    id: "create-wins",
    ownerEmail: "a@example.com",
    fileName: "original.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: createWinsPath,
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now,
  });
  assert.equal(repository.claimOrphanPdfDeletion(createWinsPath, now), false);

  assert.equal(repository.claimOrphanPdfDeletion(claimWinsPath, now), true);
  assert.equal(repository.claimOrphanPdfDeletion(claimWinsPath, now), false);
  assert.throws(() => repository.create({
    id: "claim-wins",
    ownerEmail: "a@example.com",
    fileName: "original.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: claimWinsPath,
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now,
  }), /PDF storage is unavailable/);
  assert.equal(repository.getOwned("a@example.com", "claim-wins"), null);
});
