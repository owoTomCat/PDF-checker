import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskDatabase } from "../lib/server/task-database";
import { TaskRepository, type FailTaskInput } from "../lib/server/task-repository";

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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    repository.claimNext(`2026-07-20T00:0${attempt}:00.000Z`);
    repository.recoverInterrupted(`2026-07-20T00:0${attempt}:30.000Z`, 3);
  }
  const task = repository.getOwned("a@example.com", "retry-me");
  assert.equal(task?.status, "failed");
  assert.equal(task?.errorCode, "WORKER_RETRY_EXHAUSTED");
});

test("cleanup cannot reserve an expired PDF after its owner retries it", async (t) => {
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
    pdfExpiresAt: "2026-07-20T00:00:00.000Z",
    now: "2026-07-19T00:00:00.000Z",
  });
  repository.fail({
    id: "retry-race",
    errorCode: "PDF_INVALID",
    errorMessage: "C:\\private\\retry-race.pdf",
    now: "2026-07-19T00:01:00.000Z",
  } as unknown as FailTaskInput);

  const candidate = repository.findExpiredPdfTasks("2026-07-21T00:00:00.000Z")[0];
  assert.equal(candidate?.id, "retry-race");
  assert.equal(
    repository.retryOwned("a@example.com", "retry-race", "2026-07-19T12:00:00.000Z")?.status,
    "queued",
  );
  assert.equal(repository.markPdfDeleted(candidate!.id, "2026-07-21T00:00:00.000Z"), false);
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

test("failure persistence uses a stable message instead of caller-supplied details", async (t) => {
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
    errorCode: "PDF_INVALID",
    errorMessage: "C:\\private\\safe-error.pdf: parser stack trace",
    now: "2026-07-20T00:01:00.000Z",
  } as unknown as FailTaskInput);

  const task = repository.getOwned("a@example.com", "safe-error");
  assert.equal(task?.errorCode, "PDF_INVALID");
  assert.equal(task?.errorMessage, "The PDF could not be processed.");
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
