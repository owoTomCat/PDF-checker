import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { MAX_PDF_BYTES } from "../ai/contracts";

const PDF_MAGIC = new TextEncoder().encode("%PDF-");
const UPLOAD_SUFFIX = ".uploading";
const ONE_HOUR_MS = 60 * 60 * 1_000;
export const ORPHAN_CLAIM_LEASE_MS = 30 * 60 * 1_000;
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TaskFileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TaskFileError";
  }
}

export type TaskDataPaths = {
  dataDir: string;
  uploadDir: string;
};

export type CleanupRepository = {
  findExpiredPdfTasks: (now: string) => Array<{ id: string; pdfPath: string | null }>;
  markPdfDeleted: (id: string, now: string) => boolean;
  claimOrphanPdfDeletion: (pdfPath: string, now: string) => boolean;
  releaseOrphanPdfDeletionClaim: (pdfPath: string) => void;
  pruneStaleOrphanPdfDeletionClaims: (staleBefore: string) => number;
  findPendingPdfDeletions: () => string[];
  markPendingPdfDeleted: (pdfPath: string) => void;
};

export type TaskFileOperations = {
  mkdir: (target: string, options: { recursive: true; mode: number }) => Promise<string | undefined>;
  chmod: (target: string, mode: number) => Promise<void>;
  writeFile: (target: string, data: Uint8Array, options: { mode: number; flag: "wx" }) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (target: string, options: { force: boolean }) => Promise<void>;
  readdir: (target: string, options: { withFileTypes: true }) => Promise<Dirent<string>[]>;
  stat: (target: string) => Promise<Stats>;
  unlink: (target: string) => Promise<void>;
};

export const defaultTaskFileOperations: TaskFileOperations = {
  mkdir: async (target, options) => mkdir(target, options),
  chmod: async (target, mode) => chmod(target, mode),
  writeFile: async (target, data, options) => writeFile(target, data, options),
  rename: async (oldPath, newPath) => rename(oldPath, newPath),
  rm: async (target, options) => rm(target, options),
  readdir: async (target, options) => readdir(target, options) as Promise<Dirent<string>[]>,
  stat: async (target) => stat(target),
  unlink: async (target) => unlink(target),
};

export type CleanupResult = {
  deletedTaskPdfs: number;
  deletedOrphanPdfs: number;
  deletedUploadingFiles: number;
  deletedPendingPdfs: number;
};

export function resolveTaskDataPaths(dataDir: string): TaskDataPaths {
  const resolvedDataDir = path.resolve(dataDir);
  return {
    dataDir: resolvedDataDir,
    uploadDir: path.join(resolvedDataDir, "uploads"),
  };
}

function isInsideUploadDir(candidate: string, uploadDir: string): boolean {
  const relative = path.relative(path.resolve(uploadDir), path.resolve(candidate));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertInsideUploadDir(candidate: string, uploadDir: string) {
  if (!isInsideUploadDir(candidate, uploadDir)) {
    throw new TaskFileError("UNSAFE_PDF_PATH", "PDF 存储路径无效。");
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isOldEnough(mtimeMs: number, now: string): boolean {
  const cutoff = Date.parse(now) - ONE_HOUR_MS;
  return Number.isFinite(cutoff) && mtimeMs < cutoff;
}

function isUuidPdfFileName(fileName: string): boolean {
  if (!fileName.endsWith(".pdf")) return false;
  return TASK_ID_PATTERN.test(fileName.slice(0, -".pdf".length));
}

async function ensureUploadDir(
  uploadDir: string,
  operations: TaskFileOperations,
): Promise<void> {
  try {
    await operations.mkdir(uploadDir, { recursive: true, mode: 0o700 });
    await operations.chmod(uploadDir, 0o700);
  } catch {
    throw new TaskFileError("UPLOAD_DIRECTORY_SETUP_FAILED", "无法准备 PDF 存储。");
  }
}

export function validatePdfBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    throw new TaskFileError("INVALID_PDF_UPLOAD", "PDF 文件为空。");
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new TaskFileError("PDF_TOO_LARGE", "PDF 文件超过 20 MiB 限制。");
  }
  if (!hasPdfMagic(bytes)) {
    throw new TaskFileError("INVALID_PDF_UPLOAD", "PDF 文件内容无效。");
  }
  return bytes;
}

export async function persistPdf(input: {
  dataDir: string;
  taskId: string;
  bytes: Uint8Array;
  fileOperations?: TaskFileOperations;
}): Promise<string> {
  if (!TASK_ID_PATTERN.test(input.taskId)) {
    throw new TaskFileError("INVALID_TASK_ID", "任务标识无效。");
  }
  const operations = input.fileOperations ?? defaultTaskFileOperations;
  const { uploadDir } = resolveTaskDataPaths(input.dataDir);
  await ensureUploadDir(uploadDir, operations);
  const pdfPath = path.join(uploadDir, `${input.taskId}.pdf`);
  const temporaryPath = `${pdfPath}${UPLOAD_SUFFIX}`;
  assertInsideUploadDir(pdfPath, uploadDir);
  assertInsideUploadDir(temporaryPath, uploadDir);
  try {
    await operations.writeFile(temporaryPath, input.bytes, { mode: 0o600, flag: "wx" });
    await operations.chmod(temporaryPath, 0o600);
    await operations.rename(temporaryPath, pdfPath);
    return pdfPath;
  } catch {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new TaskFileError("PDF_PERSIST_FAILED", "无法保存 PDF 文件。");
  }
}

export async function deleteTaskPdf(
  pdfPath: string,
  uploadDir: string,
  operations: TaskFileOperations = defaultTaskFileOperations,
): Promise<void> {
  assertInsideUploadDir(pdfPath, uploadDir);
  try {
    await operations.unlink(pdfPath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw new TaskFileError("PDF_DELETE_FAILED", "无法删除 PDF 文件。");
  }
}

async function removeStaleFiles(input: {
  repository: CleanupRepository;
  uploadDir: string;
  now: string;
  operations: TaskFileOperations;
}): Promise<Pick<CleanupResult, "deletedOrphanPdfs" | "deletedUploadingFiles">> {
  let entries: Dirent<string>[];
  try {
    entries = await input.operations.readdir(input.uploadDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { deletedOrphanPdfs: 0, deletedUploadingFiles: 0 };
    throw new TaskFileError("UPLOAD_DIRECTORY_READ_FAILED", "无法清理 PDF 存储。");
  }

  let deletedOrphanPdfs = 0;
  let deletedUploadingFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = path.join(input.uploadDir, entry.name);
    assertInsideUploadDir(candidate, input.uploadDir);
    let details: Stats;
    try {
      details = await input.operations.stat(candidate);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw new TaskFileError("UPLOAD_FILE_STAT_FAILED", "无法清理 PDF 存储。");
    }
    if (!isOldEnough(details.mtimeMs, input.now)) continue;
    if (entry.name.endsWith(UPLOAD_SUFFIX)) {
      await deleteTaskPdf(candidate, input.uploadDir, input.operations);
      deletedUploadingFiles += 1;
      continue;
    }
    if (isUuidPdfFileName(entry.name) && input.repository.claimOrphanPdfDeletion(candidate, input.now)) {
      let deletionError: unknown;
      try {
        await deleteTaskPdf(candidate, input.uploadDir, input.operations);
      } catch (error) {
        deletionError = error;
      }
      try {
        input.repository.releaseOrphanPdfDeletionClaim(candidate);
      } catch {
        throw new TaskFileError(
          "ORPHAN_CLAIM_RELEASE_FAILED",
          "无法清理 PDF 存储。",
        );
      }
      if (deletionError) throw deletionError;
      deletedOrphanPdfs += 1;
    }
  }
  return { deletedOrphanPdfs, deletedUploadingFiles };
}

export async function cleanupTaskFiles(input: {
  repository: CleanupRepository;
  dataDir: string;
  now: string;
  fileOperations?: TaskFileOperations;
}): Promise<CleanupResult> {
  const operations = input.fileOperations ?? defaultTaskFileOperations;
  const { uploadDir } = resolveTaskDataPaths(input.dataDir);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new TaskFileError("INVALID_CLEANUP_TIME", "PDF cleanup time is invalid.");
  }
  input.repository.pruneStaleOrphanPdfDeletionClaims(
    new Date(nowMs - ORPHAN_CLAIM_LEASE_MS).toISOString(),
  );
  let deletedTaskPdfs = 0;
  let deletedPendingPdfs = 0;
  for (const pdfPath of input.repository.findPendingPdfDeletions()) {
    if (!isInsideUploadDir(pdfPath, uploadDir)) continue;
    try {
      await deleteTaskPdf(pdfPath, uploadDir, operations);
      input.repository.markPendingPdfDeleted(pdfPath);
      deletedPendingPdfs += 1;
    } catch { /* retain durable pending intent */ }
  }
  for (const task of input.repository.findExpiredPdfTasks(input.now)) {
    if (task.pdfPath === null) continue;
    if (!isInsideUploadDir(task.pdfPath, uploadDir)) continue;
    try {
      await deleteTaskPdf(task.pdfPath, uploadDir, operations);
    } catch {
      // Keep the DB reference when the file was not removed so a later cleanup can retry.
      continue;
    }
    if (input.repository.markPdfDeleted(task.id, input.now)) deletedTaskPdfs += 1;
  }
  const stale = await removeStaleFiles({
    repository: input.repository,
    uploadDir,
    now: input.now,
    operations,
  });
  return { deletedTaskPdfs, deletedPendingPdfs, ...stale };
}
