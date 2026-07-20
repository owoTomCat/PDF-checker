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
import type { Dirent } from "node:fs";
import path from "node:path";
import { MAX_PDF_BYTES } from "../ai/contracts";

const PDF_MAGIC = new TextEncoder().encode("%PDF-");
const UPLOAD_SUFFIX = ".uploading";
const ONE_HOUR_MS = 60 * 60 * 1_000;
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
  isPdfPathReferenced: (pdfPath: string) => boolean;
};

export type CleanupResult = {
  deletedTaskPdfs: number;
  deletedOrphanPdfs: number;
  deletedUploadingFiles: number;
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

function isPdfUpload(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
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

async function ensureUploadDir(uploadDir: string): Promise<void> {
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  await chmod(uploadDir, 0o700);
}

export async function validatePdfUpload(file: File): Promise<Uint8Array> {
  if (!(file instanceof File) || !isPdfUpload(file)) {
    throw new TaskFileError("INVALID_PDF_UPLOAD", "仅支持 PDF 文件。");
  }
  if (file.size === 0) {
    throw new TaskFileError("INVALID_PDF_UPLOAD", "PDF 文件为空。");
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new TaskFileError("PDF_TOO_LARGE", "PDF 文件超过 20 MiB 限制。");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasPdfMagic(bytes)) {
    throw new TaskFileError("INVALID_PDF_UPLOAD", "PDF 文件内容无效。");
  }
  return bytes;
}

export async function persistPdf(input: {
  dataDir: string;
  taskId: string;
  bytes: Uint8Array;
}): Promise<string> {
  if (!TASK_ID_PATTERN.test(input.taskId)) {
    throw new TaskFileError("INVALID_TASK_ID", "任务标识无效。");
  }
  const { uploadDir } = resolveTaskDataPaths(input.dataDir);
  await ensureUploadDir(uploadDir);
  const pdfPath = path.join(uploadDir, `${input.taskId}.pdf`);
  const temporaryPath = `${pdfPath}${UPLOAD_SUFFIX}`;
  assertInsideUploadDir(pdfPath, uploadDir);
  assertInsideUploadDir(temporaryPath, uploadDir);
  try {
    await writeFile(temporaryPath, input.bytes, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, pdfPath);
    await chmod(pdfPath, 0o600);
    return pdfPath;
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new TaskFileError("PDF_PERSIST_FAILED", "无法保存 PDF 文件。");
  }
}

export async function deleteTaskPdf(pdfPath: string, uploadDir: string): Promise<void> {
  assertInsideUploadDir(pdfPath, uploadDir);
  try {
    await unlink(pdfPath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw new TaskFileError("PDF_DELETE_FAILED", "无法删除 PDF 文件。");
  }
}

async function removeStaleFiles(input: {
  repository: CleanupRepository;
  uploadDir: string;
  now: string;
}): Promise<Pick<CleanupResult, "deletedOrphanPdfs" | "deletedUploadingFiles">> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(input.uploadDir, { withFileTypes: true });
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
    const details = await stat(candidate);
    if (!isOldEnough(details.mtimeMs, input.now)) continue;
    if (entry.name.endsWith(UPLOAD_SUFFIX)) {
      await deleteTaskPdf(candidate, input.uploadDir);
      deletedUploadingFiles += 1;
      continue;
    }
    if (isUuidPdfFileName(entry.name) && !input.repository.isPdfPathReferenced(candidate)) {
      await deleteTaskPdf(candidate, input.uploadDir);
      deletedOrphanPdfs += 1;
    }
  }
  return { deletedOrphanPdfs, deletedUploadingFiles };
}

export async function cleanupTaskFiles(input: {
  repository: CleanupRepository;
  dataDir: string;
  now: string;
}): Promise<CleanupResult> {
  const { uploadDir } = resolveTaskDataPaths(input.dataDir);
  let deletedTaskPdfs = 0;
  for (const task of input.repository.findExpiredPdfTasks(input.now)) {
    if (task.pdfPath === null) continue;
    if (!isInsideUploadDir(task.pdfPath, uploadDir)) continue;
    if (!input.repository.markPdfDeleted(task.id, input.now)) continue;
    await deleteTaskPdf(task.pdfPath, uploadDir);
    deletedTaskPdfs += 1;
  }
  const stale = await removeStaleFiles({
    repository: input.repository,
    uploadDir,
    now: input.now,
  });
  return { deletedTaskPdfs, ...stale };
}
