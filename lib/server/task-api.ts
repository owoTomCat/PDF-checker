import { access } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BatchDeleteRequestSchema,
  AuditTaskDetailSchema,
  AuditTaskSummarySchema,
  TaskImportRequestSchema,
  TaskListQuerySchema,
} from "../task-contracts";
import { RequestGuardError } from "./request-guards";
import {
  TaskFileError,
  type TaskFileOperations,
  deleteTaskPdf,
  persistPdf,
  resolveTaskDataPaths,
  validatePdfUpload,
} from "./task-files";
import { openTaskDatabase } from "./task-database";
import { InvalidTaskCursorError, TASK_FAILURE_MESSAGES, TaskRepository } from "./task-repository";
import { taskOwnerFromRequest } from "./task-owner";

const PDF_RETENTION_MS = 72 * 60 * 60 * 1_000;

class TaskApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function taskApiErrorResponse(error: unknown): Response {
  if (error instanceof InvalidTaskCursorError) {
    return Response.json({ error: { code: "INVALID_CURSOR", message: "The task cursor is invalid." } }, { status: 400 });
  }
  if (error instanceof TaskApiError || error instanceof RequestGuardError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof TaskFileError) {
    const fileError = error.code === "PDF_TOO_LARGE"
      ? new TaskApiError("PDF_TOO_LARGE", 413, TASK_FAILURE_MESSAGES.PDF_TOO_LARGE)
      : error.code === "INVALID_PDF_UPLOAD"
        ? new TaskApiError("INVALID_PDF_UPLOAD", 422, TASK_FAILURE_MESSAGES.INVALID_PDF_UPLOAD)
        : new TaskApiError("INTERNAL_ERROR", 500, TASK_FAILURE_MESSAGES.INTERNAL_ERROR);
    return taskApiErrorResponse(fileError);
  }
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: TASK_FAILURE_MESSAGES.INTERNAL_ERROR } },
    { status: 500 },
  );
}

function invalidInput() {
  return new TaskApiError("INVALID_INPUT", 422, "The task request is invalid.");
}

function taskNotFound() {
  return new TaskApiError("TASK_NOT_FOUND", 404, TASK_FAILURE_MESSAGES.TASK_NOT_FOUND);
}

function taskActive() {
  return new TaskApiError("TASK_ACTIVE", 409, TASK_FAILURE_MESSAGES.TASK_ACTIVE);
}

function pdfUnavailable() {
  return new TaskApiError("PDF_UNAVAILABLE", 409, "The retained PDF is no longer available.");
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

function safeUploadedFileName(name: string): string {
  const normalized = name.replace(/^.*[\\/]/, "").trim();
  if (!normalized || normalized.length > 255) throw invalidInput();
  return normalized;
}

function isPrivatePdfPath(pdfPath: string, dataDir: string): boolean {
  const uploadDir = resolveTaskDataPaths(dataDir).uploadDir;
  const relative = path.relative(path.resolve(uploadDir), path.resolve(pdfPath));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type TaskApiFactoryOptions = {
  requireAuth?: boolean;
  env?: NodeJS.ProcessEnv;
  createId?: () => string;
  fileOperations?: TaskFileOperations;
};

export class TaskApi {
  constructor(
    readonly repository: TaskRepository,
    private readonly dataDir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly database?: DatabaseSync,
    private readonly createId: () => string = randomUUID,
    private readonly fileOperations?: TaskFileOperations,
  ) {}

  dispose(): void {
    this.database?.close();
  }

  async create(request: Request): Promise<Response> {
    let pdfPath: string | null = null;
    let committed = false;
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw invalidInput();
      }
      const values = form.getAll("pdf");
      if (values.length !== 1 || !(values[0] instanceof File)) throw invalidInput();
      const file = values[0];
      const fileName = safeUploadedFileName(file.name);
      const bytes = await validatePdfUpload(file);
      const id = this.createId();
      pdfPath = await persistPdf({ dataDir: this.dataDir, taskId: id, bytes });
      const now = new Date();
      const task = this.repository.create({
        id,
        ownerEmail,
        fileName,
        fileSize: file.size,
        fileType: file.type || null,
        pdfPath,
        pdfExpiresAt: new Date(now.getTime() + PDF_RETENTION_MS).toISOString(),
        now: now.toISOString(),
      });
      committed = true;
      return Response.json(AuditTaskSummarySchema.parse(this.summary(task)), { status: 202 });
    } catch (error) {
      if (pdfPath !== null && !committed) {
        try {
          await this.deletePrivatePdf(pdfPath);
        } catch {
          this.repository.releaseOrphanPdfDeletionClaim(pdfPath);
          return taskApiErrorResponse(
            new TaskApiError("INTERNAL_ERROR", 500, TASK_FAILURE_MESSAGES.INTERNAL_ERROR),
          );
        }
      }
      return taskApiErrorResponse(error);
    }
  }

  async list(request: Request): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const rawQuery = Object.fromEntries(new URL(request.url).searchParams.entries());
      const parsed = TaskListQuerySchema.safeParse(rawQuery);
      if (!parsed.success) throw invalidInput();
      const result = this.repository.list(ownerEmail, parsed.data);
      return Response.json({ ...result, items: result.items.map((item) => AuditTaskSummarySchema.parse(item)) });
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async getOne(request: Request, id: string): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const task = this.repository.getOwned(ownerEmail, id);
      if (!task) throw taskNotFound();
      return Response.json(AuditTaskDetailSchema.parse(task));
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async remove(request: Request, id: string): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const removed = this.repository.deleteOwnedTerminalPending(ownerEmail, [id], new Date().toISOString());
      if (removed.active) throw taskActive();
      if (!removed.tasks.length) throw taskNotFound();
      for (const task of removed.tasks) await this.deletePendingPdf(task.pdfPath);
      return new Response(null, { status: 204 });
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async retry(request: Request, id: string): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const existing = this.repository.getOwnedWorker(ownerEmail, id);
      if (!existing) throw taskNotFound();
      if (!isTerminal(existing.status)) throw taskActive();
      if (!existing.pdfAvailable || existing.pdfPath === null || !isPrivatePdfPath(existing.pdfPath, this.dataDir)) {
        throw pdfUnavailable();
      }
      try {
        await access(existing.pdfPath);
      } catch {
        throw pdfUnavailable();
      }
      const retried = this.repository.retryOwned(ownerEmail, id, new Date().toISOString());
      if (!retried) throw pdfUnavailable();
      return Response.json(AuditTaskSummarySchema.parse(this.summary(retried)), { status: 202 });
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async batchRemove(request: Request): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const parsed = BatchDeleteRequestSchema.safeParse(await this.requestJson(request));
      if (!parsed.success) throw invalidInput();
      const removed = this.repository.deleteOwnedTerminalPending(ownerEmail, parsed.data.ids, new Date().toISOString());
      if (removed.active) throw taskActive();
      for (const task of removed.tasks) await this.deletePendingPdf(task.pdfPath);
      return Response.json({ deleted: removed.tasks.map((task) => task.id) });
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async importLegacy(request: Request): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const parsed = TaskImportRequestSchema.safeParse(await this.requestJson(request));
      if (!parsed.success) throw invalidInput();
      const tasks = parsed.data.tasks.map((task) => ({
        ...task,
        id: `legacy-${createHash("sha256").update(`${ownerEmail}\0${task.id}`).digest("hex")}`,
        fileName: safeUploadedFileName(task.fileName),
        createdAt: new Date(task.createdAt).toISOString(),
        updatedAt: new Date(task.updatedAt).toISOString(),
        startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
        completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
      }));
      return Response.json({ imported: this.repository.importOwnedTerminal(ownerEmail, tasks) });
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  private summary(task: ReturnType<TaskRepository["getOwned"]> extends infer T ? Exclude<T, null> : never) {
    const { report: _report, reportText: _reportText, ...summary } = task;
    void _report;
    void _reportText;
    return summary;
  }

  private async requestJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      throw invalidInput();
    }
  }

  private async deletePrivatePdf(pdfPath: string | null): Promise<void> {
    if (pdfPath === null || !isPrivatePdfPath(pdfPath, this.dataDir)) return;
    await deleteTaskPdf(
      pdfPath,
      resolveTaskDataPaths(this.dataDir).uploadDir,
      this.fileOperations,
    );
  }

  private async deletePendingPdf(pdfPath: string | null): Promise<void> {
    if (pdfPath === null) return;
    try {
      await this.deletePrivatePdf(pdfPath);
      this.repository.markPendingPdfDeleted(pdfPath);
    } catch { /* durable pending cleanup retries later */ }
  }
}

export function createTaskApiForDataDir(dataDir: string, options: TaskApiFactoryOptions = {}): TaskApi {
  const database = openTaskDatabase(dataDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    ...(options.requireAuth === undefined
      ? {}
      : { PDF_AUDIT_REQUIRE_AUTH: options.requireAuth ? "true" : "false" }),
  };
  const repository = new TaskRepository(database);
  return new TaskApi(
    repository,
    dataDir,
    env,
    database,
    options.createId,
    options.fileOperations,
  );
}

let processTaskApi: TaskApi | undefined;

export function taskApiFromEnv(env: NodeJS.ProcessEnv = process.env): TaskApi {
  if (!processTaskApi) {
    const configured = env.PDF_AUDIT_DATA_DIR?.trim();
    if (env.NODE_ENV === "production" && !configured) throw new Error("PDF_AUDIT_DATA_DIR is required in production.");
    const dataDir = configured || path.join(process.cwd(), ".pdf-audit");
    processTaskApi = createTaskApiForDataDir(dataDir, { env });
  }
  return processTaskApi;
}

export { taskOwnerFromRequest, taskApiErrorResponse };
