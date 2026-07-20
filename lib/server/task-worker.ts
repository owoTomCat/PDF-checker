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
const MAX_TASK_ATTEMPTS = 3;

type Awaitable<T> = T | Promise<T>;
type ClaimedTask = Pick<
  WorkerTask,
  "id" | "fileName" | "fileSize" | "fileType" | "pdfPath"
>;

export type TaskWorkerRepository = CleanupRepository & {
  recoverInterrupted: (now: string, maxAttempts: number) => void;
  claimNext: (now: string) => ClaimedTask | null;
  updateProgress: (input: UpdateProgressInput) => Awaitable<unknown>;
  complete: (input: CompleteTaskInput) => Awaitable<unknown>;
  fail: (input: FailTaskInput) => Awaitable<unknown>;
};

type WorkerLogger = {
  error: (message: string, context: Record<string, unknown>) => void;
};

type RunPipeline = typeof runAuditPipeline;
type OpenPdf = (pdfPath: string) => Promise<RenderedPdfDocument>;

export type TaskWorkerOptions = {
  repository: TaskWorkerRepository;
  dataDir: string;
  concurrency?: number;
  pollIntervalMs?: number;
  cleanupIntervalMs?: number;
  maxAttempts?: number;
  gateway: AuditStageGateway;
  openPdf?: OpenPdf;
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

export function requireDataDir(env: NodeJS.ProcessEnv): string {
  const dataDir = env.PDF_AUDIT_DATA_DIR?.trim();
  if (!dataDir) {
    throw new TaskWorkerConfigurationError("PDF_AUDIT_DATA_DIR is required.");
  }
  return dataDir;
}

function isPrivatePdfPath(pdfPath: string, dataDir: string): boolean {
  const uploadDir = resolveTaskDataPaths(dataDir).uploadDir;
  const relative = path.relative(path.resolve(uploadDir), path.resolve(pdfPath));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
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

export class TaskWorker {
  private readonly repository: TaskWorkerRepository;
  private readonly dataDir: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly gateway: AuditStageGateway;
  private readonly openPdf: OpenPdf;
  private readonly runPipeline: RunPipeline;
  private readonly cleanup: () => Promise<unknown>;
  private readonly now: () => string;
  private readonly logger: WorkerLogger;
  private readonly controller = new AbortController();
  private readonly activeRuns = new Set<Promise<void>>();
  private initialization: Promise<void> | undefined;
  private currentRun: Promise<void> | undefined;
  private service: Promise<void> | undefined;

  constructor(options: TaskWorkerOptions) {
    this.repository = options.repository;
    this.dataDir = options.dataDir;
    this.concurrency = parseTaskWorkerConcurrency(options.concurrency);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS;
    this.cleanupIntervalMs =
      options.cleanupIntervalMs ?? TASK_FILE_CLEANUP_INTERVAL_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_TASK_ATTEMPTS;
    this.gateway = options.gateway;
    this.openPdf = options.openPdf ?? openServerPdf;
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
    if (this.service) return this.service;
    const forwardAbort = () => this.controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });

    const service = (async () => {
      try {
        await this.ensureInitialized();
        if (this.controller.signal.aborted) return;
        await Promise.all([this.pollLoop(), this.cleanupLoop()]);
      } finally {
        signal.removeEventListener("abort", forwardAbort);
      }
    })();
    this.service = service;
    return service;
  }

  async stop(): Promise<void> {
    this.controller.abort("worker stopped");
    await Promise.allSettled([
      ...(this.service ? [this.service] : []),
      ...this.activeRuns,
    ]);
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= (async () => {
      this.repository.recoverInterrupted(this.now(), this.maxAttempts);
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
      this.logger.error("Audit worker cleanup failed.", {
        stage: "cleanup",
        code: "INTERNAL_ERROR",
      });
    }
  }

  private async runAvailableInternal(): Promise<void> {
    await this.ensureInitialized();
    if (this.controller.signal.aborted) return;
    const results = await Promise.allSettled(
      Array.from({ length: this.concurrency }, () => this.runSlot()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  private async runSlot(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const task = this.repository.claimNext(this.now());
      if (task === null) return;
      await this.processTask(task);
    }
  }

  private async processTask(task: ClaimedTask): Promise<void> {
    let pdf: RenderedPdfDocument | undefined;
    let stage = "opening_pdf";
    try {
      if (task.pdfPath === null || !isPrivatePdfPath(task.pdfPath, this.dataDir)) {
        throw new TaskProcessingError("PDF_INVALID");
      }
      pdf = await this.openPdf(task.pdfPath);
      const result = await this.runPipeline({
        fileName: task.fileName,
        fileSize: task.fileSize,
        fileType: task.fileType,
        pdf,
        gateway: this.gateway,
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
      stage = "completing";
      await this.repository.complete({
        id: task.id,
        result: parsedResult.data,
        now: this.now(),
      });
    } catch (error) {
      const code = normalizeWorkerFailure(error);
      this.logger.error("Audit task failed.", { taskId: task.id, stage, code });
      await this.repository.fail({ id: task.id, errorCode: code, now: this.now() });
    } finally {
      await pdf?.destroy().catch(() => {
        this.logger.error("Audit PDF cleanup failed.", {
          taskId: task.id,
          stage: "pdf_cleanup",
          code: "PDF_RENDER_FAILED",
        });
      });
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
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
}

export function createTaskWorkerFromEnv(
  repository: TaskRepository,
  env: NodeJS.ProcessEnv = process.env,
): TaskWorker {
  const dataDir = requireDataDir(env);
  const concurrency = parseTaskWorkerConcurrency(
    env.PDF_AUDIT_WORKER_CONCURRENCY,
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
    gateway: createBailianAuditGateway(client),
  });
}
