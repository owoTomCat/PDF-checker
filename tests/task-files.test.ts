import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskDatabase } from "../lib/server/task-database";
import { TaskRepository } from "../lib/server/task-repository";
import {
  cleanupTaskFiles,
  deleteTaskPdf,
  persistPdf,
  resolveTaskDataPaths,
  validatePdfUpload,
} from "../lib/server/task-files";

const expiredAt = "2026-07-17T00:00:00.000Z";
const cleanupNow = "2026-07-20T00:00:00.000Z";
const terminalId = "8ce916b4-7297-4f7f-aac5-2e6e84de2032";
const activeId = "72e916b4-7297-4f7f-aac5-2e6e84de2032";
const orphanId = "9ce916b4-7297-4f7f-aac5-2e6e84de2032";

test("validates magic bytes and persists a private UUID-named PDF", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = new File([new TextEncoder().encode("%PDF-1.7\nbody")], "../../case.pdf", {
    type: "application/pdf",
  });

  const bytes = await validatePdfUpload(file);
  const pdfPath = await persistPdf({ dataDir: root, taskId: terminalId, bytes });

  assert.equal(path.basename(pdfPath), `${terminalId}.pdf`);
  if (process.platform !== "win32") {
    assert.equal((await stat(pdfPath)).mode & 0o777, 0o600);
    assert.equal((await stat(resolveTaskDataPaths(root).uploadDir)).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readFile(pdfPath), Buffer.from(bytes));
});

test("rejects renamed non-PDF content", async () => {
  const file = new File(["not a pdf"], "case.pdf", { type: "application/pdf" });
  await assert.rejects(validatePdfUpload(file), /PDF 文件内容无效/);
});

test("cleanup removes expired terminal and stale unreferenced files without deleting active PDFs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-cleanup-files-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const { uploadDir } = resolveTaskDataPaths(root);
  const terminalPath = await persistPdf({
    dataDir: root,
    taskId: terminalId,
    bytes: new TextEncoder().encode("%PDF-terminal"),
  });
  const activePath = await persistPdf({
    dataDir: root,
    taskId: activeId,
    bytes: new TextEncoder().encode("%PDF-active"),
  });
  const orphanPath = path.join(uploadDir, `${orphanId}.pdf`);
  const uploadingPath = path.join(uploadDir, `${orphanId}.uploading`);
  await writeFile(orphanPath, "%PDF-orphan", { mode: 0o600 });
  await writeFile(uploadingPath, "%PDF-uploading", { mode: 0o600 });
  const stale = new Date("2026-07-19T22:00:00.000Z");
  await utimes(orphanPath, stale, stale);
  await utimes(uploadingPath, stale, stale);

  repository.create({
    id: terminalId,
    ownerEmail: "a@example.com",
    fileName: "original-terminal.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: terminalPath,
    pdfExpiresAt: expiredAt,
    now: "2026-07-16T00:00:00.000Z",
  });
  repository.fail({ id: terminalId, errorCode: "PDF_INVALID", now: "2026-07-16T00:01:00.000Z" });
  repository.create({
    id: activeId,
    ownerEmail: "a@example.com",
    fileName: "original-active.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: activePath,
    pdfExpiresAt: expiredAt,
    now: "2026-07-16T00:00:00.000Z",
  });

  const result = await cleanupTaskFiles({ repository, dataDir: root, now: cleanupNow });

  await assert.rejects(access(terminalPath));
  await access(activePath);
  await assert.rejects(access(orphanPath));
  await assert.rejects(access(uploadingPath));
  assert.equal(repository.getOwned("a@example.com", terminalId)?.pdfAvailable, false);
  assert.equal(repository.getOwned("a@example.com", activeId)?.status, "queued");
  assert.deepEqual(result, {
    deletedTaskPdfs: 1,
    deletedOrphanPdfs: 1,
    deletedUploadingFiles: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /\.pdf|uploading|[A-Fa-f0-9]{8}-/);
});

test("refuses to delete a PDF candidate outside the private upload directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-safe-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsidePath = path.join(root, "outside.pdf");
  await writeFile(outsidePath, "%PDF-outside", { mode: 0o600 });

  await assert.rejects(
    deleteTaskPdf(outsidePath, resolveTaskDataPaths(root).uploadDir),
    /PDF 存储路径无效/,
  );
  await access(outsidePath);
});

test("cleanup skips an expired task whose stored path is outside private storage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-safe-cleanup-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsidePath = path.join(root, "outside.pdf");
  await writeFile(outsidePath, "%PDF-outside", { mode: 0o600 });
  repository.create({
    id: terminalId,
    ownerEmail: "a@example.com",
    fileName: "original.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: outsidePath,
    pdfExpiresAt: expiredAt,
    now: "2026-07-16T00:00:00.000Z",
  });
  repository.fail({ id: terminalId, errorCode: "PDF_INVALID", now: "2026-07-16T00:01:00.000Z" });

  const result = await cleanupTaskFiles({ repository, dataDir: root, now: cleanupNow });

  await access(outsidePath);
  assert.equal(result.deletedTaskPdfs, 0);
  assert.equal(repository.findExpiredPdfTasks(cleanupNow).length, 1);
});
