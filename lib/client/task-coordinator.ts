import { runWithConcurrency } from "./concurrency";
import type { AuditTaskDetail } from "../types";

export const ACTIVE_TASK_STATUSES = new Set<AuditTaskDetail["status"]>([
  "queued",
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
]);

export function isActiveTask(task: Pick<AuditTaskDetail, "status">) {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

export function mergeTaskByFreshness(
  current: AuditTaskDetail | undefined,
  incoming: AuditTaskDetail,
) {
  if (!current) return incoming;
  const currentTime = Date.parse(current.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (Number.isFinite(currentTime) && Number.isFinite(incomingTime)) {
    if (incomingTime < currentTime) return current;
    if (incomingTime > currentTime) return incoming;
  }
  if (!isActiveTask(current) && isActiveTask(incoming)) return current;
  if (incoming.progress < current.progress) return current;
  return incoming;
}

export function runReleasingUploadQueue<T, R>(
  input: Iterable<T>,
  concurrency: number,
  upload: (item: T, index: number) => Promise<R>,
  onRelease: (index: number) => void = () => undefined,
) {
  const slots: Array<T | null> = Array.from(input);
  const indexes = slots.map((_, index) => index);
  return runWithConcurrency(indexes, concurrency, async (index) => {
    const item = slots[index];
    if (item === null) throw new Error("上传队列条目已释放。");
    try {
      return await upload(item, index);
    } finally {
      slots[index] = null;
      onRelease(index);
    }
  });
}

export type PollingEnvironment = {
  getVisibility(): DocumentVisibilityState;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(id: number): void;
  addVisibilityListener(listener: () => void): void;
  removeVisibilityListener(listener: () => void): void;
};

type TaskPollingControllerOptions = {
  taskIds: readonly string[];
  environment: PollingEnvironment;
  fetchTask(id: string, signal: AbortSignal): Promise<AuditTaskDetail>;
  onTask(task: AuditTaskDetail): void;
  onError?(error: unknown): void;
};

export class TaskPollingController {
  private readonly options: TaskPollingControllerOptions;
  private timerId: number | null = null;
  private requestController: AbortController | null = null;
  private generation = 0;
  private running = false;

  constructor(options: TaskPollingControllerOptions) {
    this.options = options;
  }

  start() {
    if (this.running || this.options.taskIds.length === 0) return;
    this.running = true;
    this.options.environment.addVisibilityListener(this.handleVisibility);
    this.schedule();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    if (this.timerId !== null) {
      this.options.environment.clearTimer(this.timerId);
      this.timerId = null;
    }
    this.requestController?.abort();
    this.requestController = null;
    this.options.environment.removeVisibilityListener(this.handleVisibility);
  }

  private readonly handleVisibility = () => {
    if (!this.running) return;
    this.generation += 1;
    if (this.timerId !== null) {
      this.options.environment.clearTimer(this.timerId);
      this.timerId = null;
    }
    this.requestController?.abort();
    this.requestController = null;
    this.schedule();
  };

  private schedule() {
    if (!this.running || this.timerId !== null) return;
    const delay = this.options.environment.getVisibility() === "hidden" ? 5_000 : 2_000;
    this.timerId = this.options.environment.setTimer(() => {
      if (this.timerId !== null) {
        this.options.environment.clearTimer(this.timerId);
        this.timerId = null;
      }
      void this.tick();
    }, delay);
  }

  private async tick() {
    if (!this.running) return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.requestController = controller;
    await Promise.all(
      this.options.taskIds.map(async (id) => {
        try {
          const task = await this.options.fetchTask(id, controller.signal);
          if (this.running && generation === this.generation && !controller.signal.aborted) {
            this.options.onTask(task);
          }
        } catch (error) {
          if (this.running && generation === this.generation && !controller.signal.aborted) {
            this.options.onError?.(error);
          }
        }
      }),
    );
    if (this.requestController === controller) this.requestController = null;
    if (this.running && generation === this.generation) this.schedule();
  }
}

export function browserPollingEnvironment(): PollingEnvironment {
  return {
    getVisibility: () => document.visibilityState,
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (id) => window.clearTimeout(id),
    addVisibilityListener: (listener) => document.addEventListener("visibilitychange", listener),
    removeVisibilityListener: (listener) => document.removeEventListener("visibilitychange", listener),
  };
}
