import { runWithConcurrency } from "./concurrency";
import type { AuditTaskDetail, AuditTaskSummary } from "../types";

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

export function detailFromTaskSummary(
  summary: AuditTaskSummary,
  previous?: AuditTaskDetail,
): AuditTaskDetail {
  const sameTerminalSnapshot =
    previous !== undefined &&
    previous.id === summary.id &&
    !isActiveTask(previous) &&
    !isActiveTask(summary) &&
    previous.status === summary.status &&
    previous.outcome === summary.outcome &&
    previous.updatedAt === summary.updatedAt;
  return {
    ...summary,
    reportText: sameTerminalSnapshot ? previous.reportText : null,
    report: sameTerminalSnapshot ? previous.report : null,
  };
}

export function removeCheckedTaskId(ids: ReadonlySet<string>, id: string) {
  const next = new Set(ids);
  next.delete(id);
  return next;
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

export type UploadQueueSnapshot = {
  active: number;
  pending: number;
  outstanding: number;
  busy: boolean;
};

type UploadQueueEntry<T, R> = {
  item: T | null;
  worker: (item: T, signal: AbortSignal) => Promise<R>;
  release: (item: T) => void;
  resolve(value: R): void;
  reject(reason: unknown): void;
};

export class SharedUploadQueue<T, R> {
  private readonly concurrency: number;
  private readonly controller = new AbortController();
  private readonly entries: Array<UploadQueueEntry<T, R>> = [];
  private readonly listeners = new Set<(snapshot: UploadQueueSnapshot) => void>();
  private active = 0;

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("并发数必须是大于等于 1 的整数。");
    }
    this.concurrency = concurrency;
  }

  snapshot(): UploadQueueSnapshot {
    const pending = this.entries.length;
    const outstanding = pending + this.active;
    return { active: this.active, pending, outstanding, busy: outstanding > 0 };
  }

  subscribe(listener: (snapshot: UploadQueueSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  enqueue(
    items: Iterable<T>,
    worker: (item: T, signal: AbortSignal) => Promise<R>,
    release: (item: T) => void = () => undefined,
  ): Promise<PromiseSettledResult<R>[]> {
    const promises = Array.from(items, (item) =>
      new Promise<R>((resolve, reject) => {
        if (this.controller.signal.aborted) {
          release(item);
          reject(this.controller.signal.reason);
          return;
        }
        this.entries.push({ item, worker, release, resolve, reject });
      }),
    );
    this.notify();
    this.pump();
    return Promise.allSettled(promises);
  }

  abort(reason: unknown = new DOMException("aborted", "AbortError")) {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    const pending = this.entries.splice(0);
    for (const entry of pending) {
      const item = entry.item;
      entry.item = null;
      if (item !== null) entry.release(item);
      entry.reject(reason);
    }
    this.notify();
  }

  private pump() {
    while (
      !this.controller.signal.aborted &&
      this.active < this.concurrency &&
      this.entries.length > 0
    ) {
      const entry = this.entries.shift();
      if (!entry || entry.item === null) continue;
      const item = entry.item;
      entry.item = null;
      this.active += 1;
      this.notify();
      void entry.worker(item, this.controller.signal).then(
        entry.resolve,
        entry.reject,
      ).finally(() => {
        entry.release(item);
        this.active -= 1;
        this.notify();
        this.pump();
      });
    }
  }

  private notify() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

export type VisibleTaskFilters = {
  query?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
};

export type TaskReadToken = {
  id: string;
  generation: number;
  readSequence: number;
};

export type TaskActionToken = {
  id: string;
  generation: number;
};

export type TaskListRead = {
  epoch: number;
  readSequence: number;
  stateVersion: number;
  generations: Map<string, number>;
  filters: VisibleTaskFilters;
};

const REGEX_SPECIAL_CHARACTERS = new Set([
  "\\",
  "^",
  "$",
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
]);

function matchesServerLikeSubstring(value: string, query: string) {
  let source = "";
  for (const character of query) {
    if (character === "%") {
      if (!source.endsWith(".*")) source += ".*";
    } else if (character === "_") {
      source += ".";
    } else {
      source += REGEX_SPECIAL_CHARACTERS.has(character)
        ? `\\${character}`
        : character;
    }
  }
  return new RegExp(source, "isu").test(value);
}

function taskMatchesFilters(
  task: Pick<AuditTaskDetail, "fileName" | "createdAt">,
  filters: VisibleTaskFilters,
) {
  const query = filters.query?.trim();
  if (query && !matchesServerLikeSubstring(task.fileName, query)) return false;
  const createdAt = Date.parse(task.createdAt);
  if (!Number.isFinite(createdAt)) return false;
  if (filters.createdFrom && createdAt < Date.parse(filters.createdFrom)) return false;
  if (filters.createdTo && createdAt > Date.parse(filters.createdTo)) return false;
  return true;
}

export class TaskViewState {
  private readonly cache = new Map<string, AuditTaskDetail>();
  private readonly generations = new Map<string, number>();
  private readonly lastAppliedReadSequences = new Map<string, number>();
  private readonly mutationVersions = new Map<string, number>();
  private readonly tombstones = new Set<string>();
  private visibleIds: string[] = [];
  private filters: VisibleTaskFilters = { limit: 80 };
  private epoch = 0;
  private readSequence = 0;
  private stateVersion = 0;

  beginRead(id: string): TaskReadToken {
    return {
      id,
      generation: this.currentGeneration(id),
      readSequence: ++this.readSequence,
    };
  }

  beginAction(id: string): TaskActionToken {
    const generation = this.currentGeneration(id) + 1;
    this.generations.set(id, generation);
    this.mutationVersions.set(id, ++this.stateVersion);
    return { id, generation };
  }

  beginList(filters: VisibleTaskFilters): TaskListRead {
    this.filters = { ...filters };
    this.visibleIds = this.visibleIds.filter((id) => {
      const task = this.cache.get(id);
      return task ? taskMatchesFilters(task, this.filters) : false;
    });
    this.normalizeVisible();
    return {
      epoch: ++this.epoch,
      readSequence: ++this.readSequence,
      stateVersion: this.stateVersion,
      generations: new Map(this.generations),
      filters: { ...this.filters },
    };
  }

  applyRead(task: AuditTaskDetail, token: TaskReadToken) {
    if (task.id !== token.id || !this.accepts(task.id, token.generation)) {
      return false;
    }
    if (
      token.readSequence <
      (this.lastAppliedReadSequences.get(task.id) ?? 0)
    ) {
      return false;
    }
    this.cache.set(task.id, task);
    this.lastAppliedReadSequences.set(task.id, token.readSequence);
    if (this.visibleIds.includes(task.id)) {
      if (taskMatchesFilters(task, this.filters)) this.normalizeVisible();
      else this.visibleIds = this.visibleIds.filter((id) => id !== task.id);
    }
    return true;
  }

  applyAction(task: AuditTaskDetail, token: TaskActionToken, allowAdd: boolean) {
    if (task.id !== token.id || this.currentGeneration(task.id) !== token.generation) {
      return false;
    }
    this.tombstones.delete(task.id);
    this.cache.set(task.id, task);
    this.generations.set(task.id, token.generation + 1);
    this.mutationVersions.set(task.id, ++this.stateVersion);
    const wasVisible = this.visibleIds.includes(task.id);
    const matches = taskMatchesFilters(task, this.filters);
    if (matches && (wasVisible || allowAdd)) {
      if (!wasVisible) this.visibleIds.unshift(task.id);
      this.normalizeVisible();
    } else if (wasVisible) {
      this.visibleIds = this.visibleIds.filter((id) => id !== task.id);
    }
    return true;
  }

  completeList(tasks: AuditTaskDetail[], read: TaskListRead) {
    if (read.epoch !== this.epoch) return this.visibleTasks();
    const nextIds: string[] = [];
    for (const task of tasks) {
      const mutationVersion = this.mutationVersions.get(task.id) ?? 0;
      if (mutationVersion > read.stateVersion) continue;
      const generation = read.generations.get(task.id) ?? 0;
      if (!this.accepts(task.id, generation)) continue;
      if (
        (this.lastAppliedReadSequences.get(task.id) ?? 0) >
        read.readSequence
      ) {
        const current = this.cache.get(task.id);
        if (current && taskMatchesFilters(current, read.filters)) {
          nextIds.push(task.id);
        }
        continue;
      }
      this.cache.set(task.id, task);
      this.lastAppliedReadSequences.set(task.id, read.readSequence);
      if (taskMatchesFilters(task, read.filters)) nextIds.push(task.id);
    }
    for (const [id, mutationVersion] of this.mutationVersions) {
      if (mutationVersion <= read.stateVersion || this.tombstones.has(id)) continue;
      const task = this.cache.get(id);
      if (task && taskMatchesFilters(task, read.filters) && !nextIds.includes(id)) {
        nextIds.unshift(id);
      }
    }
    this.visibleIds = nextIds;
    this.normalizeVisible();
    return this.visibleTasks();
  }

  markDeleted(id: string, token: TaskActionToken) {
    if (id !== token.id || this.currentGeneration(id) !== token.generation) return false;
    this.tombstones.add(id);
    this.cache.delete(id);
    this.generations.set(id, token.generation + 1);
    this.mutationVersions.set(id, ++this.stateVersion);
    this.visibleIds = this.visibleIds.filter((visibleId) => visibleId !== id);
    return true;
  }

  visibleTasks() {
    return this.visibleIds.flatMap((id) => {
      const task = this.cache.get(id);
      return task ? [task] : [];
    });
  }

  task(id: string) {
    return this.cache.get(id);
  }

  private currentGeneration(id: string) {
    return this.generations.get(id) ?? 0;
  }

  private accepts(id: string, generation: number) {
    return !this.tombstones.has(id) && this.currentGeneration(id) === generation;
  }

  private normalizeVisible() {
    this.visibleIds.sort((leftId, rightId) => {
      const left = this.cache.get(leftId);
      const right = this.cache.get(rightId);
      return Date.parse(right?.createdAt ?? "") - Date.parse(left?.createdAt ?? "");
    });
    const requestedLimit = this.filters.limit;
    const limit =
      Number.isSafeInteger(requestedLimit) && (requestedLimit ?? 0) > 0
        ? requestedLimit!
        : 80;
    this.visibleIds = this.visibleIds.slice(0, limit);
  }
}

export type PollingEnvironment = {
  getVisibility(): DocumentVisibilityState;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(id: number): void;
  addVisibilityListener(listener: () => void): void;
  removeVisibilityListener(listener: () => void): void;
};

type TaskPollingControllerOptions<T> = {
  taskIds: readonly string[];
  environment: PollingEnvironment;
  fetchTask(id: string, signal: AbortSignal): Promise<T>;
  onTask(task: T): void;
  onError?(error: unknown): void;
};

export class TaskPollingController<T = AuditTaskDetail> {
  private readonly options: TaskPollingControllerOptions<T>;
  private timerId: number | null = null;
  private requestController: AbortController | null = null;
  private generation = 0;
  private running = false;

  constructor(options: TaskPollingControllerOptions<T>) {
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
