import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { StrictFinalAuditResponseSchema } from "../ai/contracts";
import type { AuditStageGateway, RenderedPdfDocument } from "../audit/gateway";
import {
  runAuditPipeline,
  type PipelineProgress,
} from "../audit/pipeline";
import { createBailianAuditGateway } from "./bailian-audit-gateway";
import {
  BailianClientError,
  createBailianClient,
} from "./bailian-client";
import { openServerPdf, ServerPdfError } from "./pdf-renderer";
import {
  cleanupTaskFiles,
  resolveTaskDataPaths,
  type CleanupRepository,
} from "./task-files";
import type {
  CompleteTaskInput,
  FailTaskInput,
  TaskFailureCode,
  UpdateProgressInput,
  WorkerTask,
} from "./task-repository";
import type { TaskRepository } from "./task-repository";

export const TASK_FILE_CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 1_000;

type Awaitable<T> = T | Promise<T>;
type ClaimedTask = Pick<
  WorkerTask,
  "id" | "fileName" | "fileSize" | "fileType" | "pdfPath"
>;

export type TaskWorkerRepository = CleanupRepository & {
  recoverInterrupted: (now: string) => void;
  claimNext: (now: string) => ClaimedTask | null;
  updateProgress: (input: UpdateProgressInput) => Awaitable<unknown>;
  complete: (input: CompleteTaskInput) => Awaitable<unknown>;
  fail: (input: FailTaskInput) => Awaitable<unknown>;
  requeueClaimAfterShutdown: (id: string, now: string) => Awaitable<boolean>;
};

type WorkerLogger = {
  error: (message: string, context: Record<string, unknown>) => void;
};

type RunPipeline = typeof runAuditPipeline;
type OpenPdf = (bytes: Uint8Array) => Promise<RenderedPdfDocument>;
type ReadPdfBytes = (pdfPath: string, dataDir: string) => Promise<Uint8Array>;

export type TaskWorkerOptions = {
  repository: TaskWorkerRepository;
  dataDir: string;
  concurrency?: number;
  pollIntervalMs?: number;
  cleanupIntervalMs?: number;
  gateway: AuditStageGateway;
  openPdf?: OpenPdf;
  readPdfBytes?: ReadPdfBytes;
  runPipeline?: RunPipeline;
  cleanup?: () => Promise<unknown>;
  now?: () => string;
  logger?: WorkerLogger;
};

export class TaskWorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskWorkerConfigurationError";
  }
}

class TaskProcessingError extends Error {
  constructor(readonly code: TaskFailureCode) {
    super(code);
    this.name = "TaskProcessingError";
  }
}

export function parseTaskWorkerConcurrency(
  value: string | number | undefined,
): number {
  if (value === undefined) return 3;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new TaskWorkerConfigurationError(
      "PDF_AUDIT_WORKER_CONCURRENCY must be an integer from 1 through 3.",
    );
  }
  return parsed;
}

export function parseTaskWorkerPollInterval(
  value: string | number | undefined,
): number {
  if (value === undefined) return DEFAULT_QUEUE_POLL_INTERVAL_MS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new TaskWorkerConfigurationError(
      "PDF_AUDIT_WORKER_POLL_MS must be an integer from 100 through 60000.",
    );
  }
  return parsed;
}

export function requireDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = env.PDF_AUDIT_DATA_DIR?.trim();
  if (!dataDir) {
    throw new TaskWorkerConfigurationError("PDF_AUDIT_DATA_DIR is required.");
  }
  return dataDir;
}

function isChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function readPrivateTaskPdf(
  pdfPath: string,
  dataDir: string,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const uploadDir = resolveTaskDataPaths(dataDir).uploadDir;
    const [uploadRealPath, details] = await Promise.all([
      realpath(uploadDir),
      lstat(pdfPath),
    ]);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new TaskProcessingError("PDF_INVALID");
    }

    const pdfRealPath = await realpath(pdfPath);
    if (!isChildPath(pdfRealPath, uploadRealPath)) {
      throw new TaskProcessingError("PDF_INVALID");
    }

    const noFollow =
      typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(pdfRealPath, fsConstants.O_RDONLY | noFollow);
    const openedDetails = await handle.stat();
    if (
      !openedDetails.isFile() ||
      openedDetails.dev !== details.dev ||
      openedDetails.ino !== details.ino
    ) {
      throw new TaskProcessingError("PDF_INVALID");
    }
    return new Uint8Array(await handle.readFile());
  } catch (error) {
    if (error instanceof TaskProcessingError) throw error;
    throw new TaskProcessingError("PDF_INVALID");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeWorkerFailure(error: unknown): TaskFailureCode {
  if (error instanceof TaskProcessingError) return error.code;
  if (error instanceof ServerPdfError) {
    switch (error.code) {
      case "PDF_ENCRYPTED":
      case "PDF_INVALID":
      case "PDF_RENDER_FAILED":
        return error.code;
      case "PDF_UNSUPPORTED":
        return "PDF_INVALID";
      case "PDF_IMAGE_TOO_LARGE":
        return "PDF_RENDER_FAILED";
    }
  }
  if (error instanceof BailianClientError) {
    return error.code === "INVALID_MODEL_OUTPUT"
      ? "INVALID_MODEL_OUTPUT"
      : "MODEL_UNAVAILABLE";
  }
  return "INTERNAL_ERROR";
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, durationMs);
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function asFatalWorkerError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("任务执行器发生未知致命错误。");
}

export class TaskWorker {
  private readonly repository: TaskWorkerRepository;
  private readonly dataDir: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly gateway: AuditStageGateway;
  private readonly openPdf: OpenPdf;
  private readonly readPdfBytes: ReadPdfBytes;
  private readonly runPipeline: RunPipeline;
  private readonly cleanup: () => Promise<unknown>;
  private readonly now: () => string;
  private readonly logger: WorkerLogger;
  private readonly controller = new AbortController();
  private readonly activeRuns = new Set<Promise<void>>();
  private initialization: Promise<void> | undefined;
  private currentRun: Promise<void> | undefined;
  private service: Promise<void> | undefined;
  private pollLoopPromise: Promise<void> | undefined;
  private cleanupLoopPromise: Promise<void> | undefined;
  private serviceFatal: Error | undefined;
  private lifecycle: "new" | "running" | "stopped" | "completed" = "new";

  constructor(options: TaskWorkerOptions) {
    this.repository = options.repository;
    this.dataDir = options.dataDir;
    this.concurrency = parseTaskWorkerConcurrency(options.concurrency);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS;
    this.cleanupIntervalMs =
      options.cleanupIntervalMs ?? TASK_FILE_CLEANUP_INTERVAL_MS;
    this.gateway = options.gateway;
    this.openPdf = options.openPdf ?? openServerPdf;
    this.readPdfBytes = options.readPdfBytes ?? readPrivateTaskPdf;
    this.runPipeline = options.runPipeline ?? runAuditPipeline;
    this.cleanup =
      options.cleanup ??
      (() =>
        cleanupTaskFiles({
          repository: this.repository,
          dataDir: this.dataDir,
          now: this.now(),
        }));
    this.now = options.now ?? (() => new Date().toISOString());
    this.logger = options.logger ?? console;

    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new TaskWorkerConfigurationError("Worker poll interval must be positive.");
    }
    if (!Number.isFinite(this.cleanupIntervalMs) || this.cleanupIntervalMs <= 0) {
      throw new TaskWorkerConfigurationError("Worker cleanup interval must be positive.");
    }
  }

  runAvailable(): Promise<void> {
    if (this.lifecycle === "stopped" || this.lifecycle === "completed") {
      return Promise.reject(
        new TaskWorkerConfigurationError("A worker cannot run again."),
      );
    }
    if (this.currentRun) return this.currentRun;
    const running = this.runAvailableInternal();
    this.currentRun = running;
    this.activeRuns.add(running);
    void running.then(
      () => this.finishRun(running),
      () => this.finishRun(running),
    );
    return running;
  }

  start(signal: AbortSignal): Promise<void> {
    if (this.lifecycle === "running" && this.service) return this.service;
    if (this.lifecycle !== "new") {
      return Promise.reject(
        new TaskWorkerConfigurationError("A worker cannot be started again."),
      );
    }
    this.lifecycle = "running";
    const forwardAbort = () => this.controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });

    const service = (async () => {
      try {
        await this.ensureInitialized();
        if (this.controller.signal.aborted) return;
        this.pollLoopPromise = this.observeLoop(this.pollLoop());
        this.cleanupLoopPromise = this.observeLoop(this.cleanupLoop());
        const results = await Promise.allSettled([
          this.pollLoopPromise,
          this.cleanupLoopPromise,
        ]);
        if (this.serviceFatal) throw this.serviceFatal;
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw asFatalWorkerError(failure.reason);
      } finally {
        signal.removeEventListener("abort", forwardAbort);
        if (this.lifecycle === "running") this.lifecycle = "completed";
      }
    })();
    this.service = service;
    return service;
  }

  async stop(): Promise<void> {
    if (this.lifecycle === "new" || this.lifecycle === "running") {
      this.lifecycle = "stopped";
    }
    this.controller.abort("worker stopped");
    await Promise.allSettled([
      ...(this.service ? [this.service] : []),
      ...(this.pollLoopPromise ? [this.pollLoopPromise] : []),
      ...(this.cleanupLoopPromise ? [this.cleanupLoopPromise] : []),
      ...this.activeRuns,
    ]);
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= (async () => {
      this.repository.recoverInterrupted(this.now());
      await this.runCleanup();
    })();
    await this.initialization;
  }

  private finishRun(running: Promise<void>): void {
    this.activeRuns.delete(running);
    if (this.currentRun === running) this.currentRun = undefined;
  }

  private async runCleanup(): Promise<void> {
    try {
      await this.cleanup();
    } catch {
      this.logError("Audit worker cleanup failed.", {
        stage: "cleanup",
        code: "INTERNAL_ERROR",
      });
    }
  }

  private async runAvailableInternal(): Promise<void> {
    await this.ensureInitialized();
    if (this.controller.signal.aborted) return;
    const state: { hasFatal: boolean; fatalError: Error | undefined } = {
      hasFatal: false,
      fatalError: undefined,
    };
    const results = await Promise.allSettled(
      Array.from({ length: this.concurrency }, () => this.runSlot(state)),
    );
    if (state.hasFatal) throw state.fatalError!;
    const failure = results.find((result): result is PromiseRejectedResult =>
      result.status === "rejected",
    );
    if (failure) throw asFatalWorkerError(failure.reason);
  }

  private async runSlot(state: {
    hasFatal: boolean;
    fatalError: Error | undefined;
  }): Promise<void> {
    try {
      while (!this.controller.signal.aborted && !state.hasFatal) {
        const task = this.repository.claimNext(this.now());
        if (task === null) return;
        await this.processTask(task);
      }
    } catch (error) {
      if (!state.hasFatal) {
        state.hasFatal = true;
        state.fatalError = asFatalWorkerError(error);
      }
    }
  }

  private async processTask(task: ClaimedTask): Promise<void> {
    let pdf: RenderedPdfDocument | undefined;
    let stage = "opening_pdf";
    try {
      if (task.pdfPath === null) {
        throw new TaskProcessingError("PDF_INVALID");
      }
      const bytes = await this.readPdfBytes(task.pdfPath, this.dataDir);
      pdf = await this.openPdf(bytes);
      const result = await this.runPipeline({
        fileName: task.fileName,
        fileSize: task.fileSize,
        fileType: task.fileType,
        pdf,
        gateway: this.gateway,
        signal: this.controller.signal,
        onProgress: async (progress: PipelineProgress) => {
          stage = progress.stage;
          await this.repository.updateProgress({
            id: task.id,
            status: progress.stage,
            progress: progress.progress,
            processedPages: progress.processedPages,
            totalPages: progress.totalPages,
            now: this.now(),
          });
        },
      });
      const parsedResult = StrictFinalAuditResponseSchema.safeParse(result);
      if (!parsedResult.success) {
        throw new TaskProcessingError("INVALID_MODEL_OUTPUT");
      }
      if (this.controller.signal.aborted) {
        throw this.controller.signal.reason;
      }
      stage = "completing";
      await this.repository.complete({
        id: task.id,
        result: parsedResult.data,
        now: this.now(),
      });
    } catch (error) {
      if (this.controller.signal.aborted) {
        await this.repository.requeueClaimAfterShutdown(task.id, this.now());
        return;
      }
      const code = normalizeWorkerFailure(error);
      try {
        await this.repository.fail({
          id: task.id,
          errorCode: code,
          now: this.now(),
        });
      } finally {
        this.logError("Audit task failed.", { taskId: task.id, stage, code });
      }
    } finally {
      await pdf?.destroy().catch(() => {
        this.logError("Audit PDF cleanup failed.", {
          taskId: task.id,
          stage: "pdf_cleanup",
          code: "PDF_RENDER_FAILED",
        });
      });
    }
  }

  private logError(message: string, context: Record<string, unknown>): void {
    try {
      this.logger.error(message, context);
    } catch {
      // Diagnostic sinks must never change the durable task result.
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      if (this.controller.signal.aborted) return;
      await this.runAvailable();
      if (this.controller.signal.aborted) return;
      await abortableDelay(this.pollIntervalMs, this.controller.signal);
    }
  }

  private async cleanupLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      await abortableDelay(this.cleanupIntervalMs, this.controller.signal);
      if (this.controller.signal.aborted) return;
      await this.runCleanup();
    }
  }

  private async observeLoop(loop: Promise<void>): Promise<void> {
    try {
      await loop;
    } catch (error) {
      throw this.recordServiceFatal(error);
    }
  }

  private recordServiceFatal(reason: unknown): Error {
    this.serviceFatal ??= asFatalWorkerError(reason);
    if (!this.controller.signal.aborted) {
      this.controller.abort(this.serviceFatal);
    }
    return this.serviceFatal;
  }
}

export function createTaskWorkerFromEnv(
  repository: TaskRepository,
  env: NodeJS.ProcessEnv = process.env,
): TaskWorker {
  const dataDir = requireDataDir(env);
  const concurrency = parseTaskWorkerConcurrency(
    env.PDF_AUDIT_WORKER_CONCURRENCY,
  );
  const pollIntervalMs = parseTaskWorkerPollInterval(
    env.PDF_AUDIT_WORKER_POLL_MS,
  );
  const client = createBailianClient({
    apiKey: env.DASHSCOPE_API_KEY ?? "",
    baseUrl: env.DASHSCOPE_BASE_URL ?? "",
    model: env.QWEN_MODEL ?? "qwen3.7-plus",
  });
  return new TaskWorker({
    repository,
    dataDir,
    concurrency,
    pollIntervalMs,
    gateway: createBailianAuditGateway(client),
  });
}
