import { access } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BatchDeleteRequestSchema,
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
import { TASK_FAILURE_MESSAGES, TaskRepository } from "./task-repository";
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
  return normalized || "upload.pdf";
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
      const bytes = await validatePdfUpload(file);
      const id = this.createId();
      pdfPath = await persistPdf({ dataDir: this.dataDir, taskId: id, bytes });
      const now = new Date();
      const task = this.repository.create({
        id,
        ownerEmail,
        fileName: safeUploadedFileName(file.name),
        fileSize: file.size,
        fileType: file.type || null,
        pdfPath,
        pdfExpiresAt: new Date(now.getTime() + PDF_RETENTION_MS).toISOString(),
        now: now.toISOString(),
      });
      return Response.json(this.summary(task), { status: 202 });
    } catch (error) {
      if (pdfPath !== null) {
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
      return Response.json(this.repository.list(ownerEmail, parsed.data));
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async getOne(request: Request, id: string): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const task = this.repository.getOwned(ownerEmail, id);
      if (!task) throw taskNotFound();
      return Response.json(task);
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async remove(request: Request, id: string): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const token = randomUUID();
      const reservation = this.repository.reserveOwnedTerminalDeletion(ownerEmail, id, token);
      if (reservation.state === "not_found") throw taskNotFound();
      if (reservation.state === "active") throw taskActive();
      if (reservation.state !== "reserved") {
        throw new TaskApiError("INTERNAL_ERROR", 500, TASK_FAILURE_MESSAGES.INTERNAL_ERROR);
      }
      try {
        await this.deletePrivatePdf(reservation.task.pdfPath);
      } catch (error) {
        this.repository.releaseOwnedTerminalDeletion(ownerEmail, id, token);
        throw error;
      }
      if (!this.repository.deleteReservedOwnedTerminal(ownerEmail, id, token)) {
        this.repository.releaseOwnedTerminalDeletion(ownerEmail, id, token);
        throw new TaskApiError("INTERNAL_ERROR", 500, TASK_FAILURE_MESSAGES.INTERNAL_ERROR);
      }
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
      return Response.json(this.summary(retried), { status: 202 });
    } catch (error) {
      return taskApiErrorResponse(error);
    }
  }

  async batchRemove(request: Request): Promise<Response> {
    try {
      const ownerEmail = taskOwnerFromRequest(request, this.env);
      const parsed = BatchDeleteRequestSchema.safeParse(await this.requestJson(request));
      if (!parsed.success) throw invalidInput();
      const token = randomUUID();
      const reservation = this.repository.reserveOwnedTerminalDeletionBatch(
        ownerEmail,
        parsed.data.ids,
        token,
      );
      if (reservation.active) throw taskActive();
      try {
        for (const task of reservation.tasks) await this.deletePrivatePdf(task.pdfPath);
      } catch (error) {
        for (const task of reservation.tasks) {
          this.repository.releaseOwnedTerminalDeletion(ownerEmail, task.id, token);
        }
        throw error;
      }
      try {
        this.repository.deleteReservedOwnedTerminalBatch(ownerEmail, parsed.data.ids, token);
      } catch (error) {
        for (const task of reservation.tasks) {
          this.repository.releaseOwnedTerminalDeletion(ownerEmail, task.id, token);
        }
        throw error;
      }
      return Response.json({ deleted: reservation.tasks.map((task) => task.id) });
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
        fileName: safeUploadedFileName(task.fileName),
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
  repository.releaseAllDeletionReservations();
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
    const dataDir = env.PDF_AUDIT_DATA_DIR?.trim() || path.join(process.cwd(), ".pdf-audit");
    processTaskApi = createTaskApiForDataDir(dataDir, { env });
  }
  return processTaskApi;
}

export { taskOwnerFromRequest, taskApiErrorResponse };
