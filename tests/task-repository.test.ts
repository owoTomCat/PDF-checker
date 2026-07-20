import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskDatabase } from "../lib/server/task-database";
import { TaskRepository } from "../lib/server/task-repository";

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
