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
  defaultTaskFileOperations,
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
  await utimes(activePath, stale, stale);
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
    deletedPendingPdfs: 0,
    deletedOrphanPdfs: 1,
    deletedUploadingFiles: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /\.pdf|uploading|[A-Fa-f0-9]{8}-/);
});

test("cleanup preserves a stale expired PDF while its task is rendering", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-rendering-cleanup-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = await persistPdf({ dataDir: root, taskId: activeId, bytes: new TextEncoder().encode("%PDF-active") });
  await utimes(pdfPath, new Date("2026-07-19T22:00:00.000Z"), new Date("2026-07-19T22:00:00.000Z"));
  repository.create({ id: activeId, ownerEmail: "a@example.com", fileName: "active.pdf", fileSize: 10, fileType: "application/pdf", pdfPath, pdfExpiresAt: expiredAt, now: "2026-07-16T00:00:00.000Z" });
  assert.equal(repository.claimNext("2026-07-16T00:01:00.000Z")?.status, "rendering");
  await cleanupTaskFiles({ repository, dataDir: root, now: cleanupNow });
  await access(pdfPath);
  assert.equal(repository.getOwned("a@example.com", activeId)?.status, "rendering");
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

test("persistence rolls back before rename when private-file chmod fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-chmod-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let chmodCalls = 0;
  const operations = {
    ...defaultTaskFileOperations,
    chmod: async (target: string, mode: number) => {
      chmodCalls += 1;
      if (chmodCalls === 2) {
        throw Object.assign(new Error(`chmod failed for ${target}`), { code: "EACCES" });
      }
      await defaultTaskFileOperations.chmod(target, mode);
    },
  };

  await assert.rejects(
    persistPdf({
      dataDir: root,
      taskId: terminalId,
      bytes: new TextEncoder().encode("%PDF-failure"),
      fileOperations: operations,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PDF_PERSIST_FAILED");
      assert.doesNotMatch((error as Error).message, /chmod failed|uploads|[A-Fa-f0-9]{8}-/);
      return true;
    },
  );

  const { uploadDir } = resolveTaskDataPaths(root);
  assert.equal(chmodCalls, 2);
  await assert.rejects(access(path.join(uploadDir, `${terminalId}.pdf`)));
  await assert.rejects(access(path.join(uploadDir, `${terminalId}.pdf.uploading`)));
});

test("cleanup treats a disappearing stale candidate as idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-stat-enoent-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const { uploadDir } = resolveTaskDataPaths(root);
  await defaultTaskFileOperations.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const stalePath = path.join(uploadDir, `${orphanId}.uploading`);
  await writeFile(stalePath, "%PDF-temp", { mode: 0o600 });
  const stale = new Date("2026-07-19T22:00:00.000Z");
  await utimes(stalePath, stale, stale);

  const result = await cleanupTaskFiles({
    repository,
    dataDir: root,
    now: cleanupNow,
    fileOperations: {
      ...defaultTaskFileOperations,
      stat: async () => {
        throw Object.assign(new Error("missing stale file"), { code: "ENOENT" });
      },
    },
  });

  assert.deepEqual(result, {
    deletedTaskPdfs: 0,
    deletedPendingPdfs: 0,
    deletedOrphanPdfs: 0,
    deletedUploadingFiles: 0,
  });
});

test("cleanup releases an orphan claim after an unlink failure so the next pass can delete it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-orphan-claim-retry-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const { uploadDir } = resolveTaskDataPaths(root);
  await defaultTaskFileOperations.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const orphanPath = path.join(uploadDir, `${orphanId}.pdf`);
  await writeFile(orphanPath, "%PDF-orphan", { mode: 0o600 });
  await utimes(orphanPath, new Date("2026-07-19T22:00:00.000Z"), new Date("2026-07-19T22:00:00.000Z"));

  await assert.rejects(
    cleanupTaskFiles({
      repository,
      dataDir: root,
      now: cleanupNow,
      fileOperations: {
        ...defaultTaskFileOperations,
        unlink: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "PDF_DELETE_FAILED",
  );

  const claimAfterFailure = db.prepare(
    "SELECT COUNT(*) AS count FROM pdf_orphan_deletion_claims WHERE pdf_path = ?",
  ).get(orphanPath) as { count: number };
  assert.equal(claimAfterFailure.count, 0);

  const secondPass = await cleanupTaskFiles({ repository, dataDir: root, now: cleanupNow });
  assert.equal(secondPass.deletedOrphanPdfs, 1);
  await assert.rejects(access(orphanPath));
  const claimAfterSuccess = db.prepare(
    "SELECT COUNT(*) AS count FROM pdf_orphan_deletion_claims WHERE pdf_path = ?",
  ).get(orphanPath) as { count: number };
  assert.equal(claimAfterSuccess.count, 0);
});

test("cleanup surfaces an orphan-claim release failure ahead of the stale-file failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-orphan-release-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { uploadDir } = resolveTaskDataPaths(root);
  await defaultTaskFileOperations.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const orphanPath = path.join(uploadDir, `${orphanId}.pdf`);
  await writeFile(orphanPath, "%PDF-orphan", { mode: 0o600 });
  await utimes(orphanPath, new Date("2026-07-19T22:00:00.000Z"), new Date("2026-07-19T22:00:00.000Z"));
  let releases = 0;

  await assert.rejects(
    cleanupTaskFiles({
      repository: {
        findExpiredPdfTasks() { return []; },
        markPdfDeleted() { return false; },
        claimOrphanPdfDeletion() { return true; },
        releaseOrphanPdfDeletionClaim() {
          releases += 1;
          throw new Error("database unavailable");
        },
        findPendingPdfDeletions() { return []; },
        markPendingPdfDeleted() {},
      },
      dataDir: root,
      now: cleanupNow,
      fileOperations: {
        ...defaultTaskFileOperations,
        unlink: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "ORPHAN_CLAIM_RELEASE_FAILED",
  );
  assert.equal(releases, 1);
  await access(orphanPath);
});

test("cleanup retains an expired terminal task reference when unlink fails and retries later", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-expired-retry-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = await persistPdf({
    dataDir: root,
    taskId: terminalId,
    bytes: new TextEncoder().encode("%PDF-terminal"),
  });
  repository.create({
    id: terminalId,
    ownerEmail: "a@example.com",
    fileName: "terminal.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath,
    pdfExpiresAt: expiredAt,
    now: "2026-07-16T00:00:00.000Z",
  });
  repository.fail({ id: terminalId, errorCode: "PDF_INVALID", now: "2026-07-16T00:01:00.000Z" });

  const failedPass = await cleanupTaskFiles({
    repository,
    dataDir: root,
    now: cleanupNow,
    fileOperations: {
      ...defaultTaskFileOperations,
      unlink: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    },
  });
  assert.equal(failedPass.deletedTaskPdfs, 0);
  const retained = repository.getOwnedWorker("a@example.com", terminalId);
  assert.equal(retained?.pdfPath, pdfPath);
  assert.equal(repository.findExpiredPdfTasks(cleanupNow).map((task) => task.id).includes(terminalId), true);
  await access(pdfPath);

  const successfulPass = await cleanupTaskFiles({ repository, dataDir: root, now: cleanupNow });
  assert.equal(successfulPass.deletedTaskPdfs, 1);
  assert.equal(repository.getOwnedWorker("a@example.com", terminalId)?.pdfPath, null);
  await assert.rejects(access(pdfPath));
});

test("storage setup and stale stat failures have path-free public errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-safe-errors-"));
  const db = openTaskDatabase(root);
  const repository = new TaskRepository(db);
  t.after(() => db.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    persistPdf({
      dataDir: root,
      taskId: terminalId,
      bytes: new TextEncoder().encode("%PDF-setup"),
      fileOperations: {
        ...defaultTaskFileOperations,
        mkdir: async () => {
          throw new Error("C:\\private\\uploads setup failed");
        },
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UPLOAD_DIRECTORY_SETUP_FAILED");
      assert.doesNotMatch((error as Error).message, /private|uploads/i);
      return true;
    },
  );

  const { uploadDir } = resolveTaskDataPaths(root);
  await defaultTaskFileOperations.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const stalePath = path.join(uploadDir, `${orphanId}.uploading`);
  await writeFile(stalePath, "%PDF-temp", { mode: 0o600 });
  await assert.rejects(
    cleanupTaskFiles({
      repository,
      dataDir: root,
      now: cleanupNow,
      fileOperations: {
        ...defaultTaskFileOperations,
        stat: async () => {
          throw new Error(`failed stat ${stalePath}`);
        },
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UPLOAD_FILE_STAT_FAILED");
      assert.doesNotMatch((error as Error).message, /stat|uploads|[A-Fa-f0-9]{8}-/i);
      return true;
    },
  );
});
