import { AuditTaskDetailSchema } from "../task-contracts";
import type { AuditTaskDetail } from "../types";

export const LEGACY_TASK_STORAGE_KEY = "pdf-audit-workspace.tasks.v4";
export const LEGACY_MIGRATION_MARKER_KEY =
  "pdf-audit-workspace.tasks.v4.server-migrated";
export const MAX_LEGACY_STORAGE_BYTES = 1_000_000;

export type LegacyStorage = Pick<Storage, "getItem" | "setItem">;

export type HistoryDateFilter =
  | "all"
  | "today"
  | "7d"
  | "30d"
  | "custom";

export type HistoryFilterOptions = {
  query: string;
  dateFilter: HistoryDateFilter;
  customStart: string;
  customEnd: string;
};

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function parseLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function dateBounds(
  options: HistoryFilterOptions,
  now: Date,
): { start: Date | null; endExclusive: Date | null } {
  const today = startOfLocalDay(now);
  if (options.dateFilter === "all") {
    return { start: null, endExclusive: null };
  }
  if (options.dateFilter === "today") {
    return { start: today, endExclusive: addLocalDays(today, 1) };
  }
  if (options.dateFilter === "7d") {
    return { start: addLocalDays(today, -6), endExclusive: addLocalDays(today, 1) };
  }
  if (options.dateFilter === "30d") {
    return {
      start: addLocalDays(today, -29),
      endExclusive: addLocalDays(today, 1),
    };
  }

  const start = parseLocalDate(options.customStart);
  const end = parseLocalDate(options.customEnd);
  return {
    start,
    endExclusive: end ? addLocalDays(end, 1) : null,
  };
}

export function historyFiltersToTaskListFilters(
  options: HistoryFilterOptions,
  now = new Date(),
) {
  const { start, endExclusive } = dateBounds(options, now);
  const query = options.query.trim();
  return {
    ...(query ? { query } : {}),
    ...(start ? { createdFrom: start.toISOString() } : {}),
    ...(endExclusive ? { createdTo: endExclusive.toISOString() } : {}),
    limit: 80,
  };
}

export function filterHistoryTasks(
  tasks: AuditTaskDetail[],
  options: HistoryFilterOptions,
  now = new Date(),
) {
  const query = options.query.trim().toLocaleLowerCase();
  const { start, endExclusive } = dateBounds(options, now);

  return tasks.filter((task) => {
    if (query && !task.fileName.toLocaleLowerCase().includes(query)) {
      return false;
    }
    if (!start && !endExclusive) return true;
    const createdAt = new Date(task.createdAt);
    if (Number.isNaN(createdAt.getTime())) return false;
    if (start && createdAt < start) return false;
    if (endExclusive && createdAt >= endExclusive) return false;
    return true;
  });
}

export function upsertHistoryTask(
  tasks: AuditTaskDetail[],
  task: AuditTaskDetail,
  limit = 80,
) {
  return [task, ...tasks.filter((item) => item.id !== task.id)]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )
    .slice(0, Math.max(0, limit));
}

export function removeHistoryTasks(
  tasks: AuditTaskDetail[],
  ids: ReadonlySet<string>,
) {
  return tasks.filter((task) => !ids.has(task.id));
}

function terminalLegacyTask(value: unknown): AuditTaskDetail | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.status !== "completed" && source.status !== "failed") return null;
  if (
    typeof source.id !== "string" ||
    typeof source.fileName !== "string" ||
    typeof source.fileSize !== "number" ||
    typeof source.createdAt !== "string"
  ) {
    return null;
  }
  const fileName = source.fileName.replaceAll("\\", "/").split("/").at(-1)?.slice(0, 255);
  if (!fileName) return null;
  const outcome =
    source.outcome === "passed" ||
    source.outcome === "issues_found" ||
    source.outcome === "needs_review" ||
    source.outcome === "failed"
      ? source.outcome
      : source.status === "failed"
        ? "failed"
        : null;
  const errorCode =
    typeof source.errorCode === "string" && /^[A-Z0-9_]{1,100}$/.test(source.errorCode)
      ? source.errorCode
      : source.status === "failed"
        ? "INTERNAL_ERROR"
        : null;
  const candidate = {
    id: source.id.slice(0, 200),
    fileName,
    fileSize: source.fileSize,
    fileType: typeof source.fileType === "string" ? source.fileType.slice(0, 255) : null,
    status: source.status,
    outcome,
    model: source.model === "qwen3.7-plus" ? source.model : null,
    progress: 100,
    processedPages: source.processedPages,
    totalPages: source.totalPages ?? null,
    createdAt: source.createdAt,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : source.createdAt,
    startedAt: typeof source.startedAt === "string" ? source.startedAt : null,
    completedAt: typeof source.completedAt === "string" ? source.completedAt : null,
    errorCode,
    errorMessage: source.status === "failed" ? "历史任务处理失败。" : null,
    issueCount: source.issueCount ?? null,
    summary: source.summary ?? null,
    pdfExpiresAt: null,
    pdfAvailable: false,
    reportText: typeof source.reportText === "string" ? source.reportText : null,
    report: source.report ?? null,
  };
  const parsed = AuditTaskDetailSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type LegacyMigrationResult = {
  status: "already-migrated" | "skipped" | "imported";
  imported: number;
};

export async function migrateLegacyTaskHistory(
  storage: LegacyStorage,
  importTasks: (tasks: AuditTaskDetail[]) => Promise<number>,
): Promise<LegacyMigrationResult> {
  if (storage.getItem(LEGACY_MIGRATION_MARKER_KEY)) {
    return { status: "already-migrated", imported: 0 };
  }
  const raw = storage.getItem(LEGACY_TASK_STORAGE_KEY);
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_LEGACY_STORAGE_BYTES) {
    storage.setItem(LEGACY_MIGRATION_MARKER_KEY, new Date().toISOString());
    return { status: "skipped", imported: 0 };
  }

  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    storage.setItem(LEGACY_MIGRATION_MARKER_KEY, new Date().toISOString());
    return { status: "skipped", imported: 0 };
  }
  if (!Array.isArray(values)) {
    storage.setItem(LEGACY_MIGRATION_MARKER_KEY, new Date().toISOString());
    return { status: "skipped", imported: 0 };
  }
  const tasks: AuditTaskDetail[] = [];
  for (const value of values) {
    const task = terminalLegacyTask(value);
    if (task) tasks.push(task);
    if (tasks.length === 80) break;
  }
  if (tasks.length === 0) {
    storage.setItem(LEGACY_MIGRATION_MARKER_KEY, new Date().toISOString());
    return { status: "skipped", imported: 0 };
  }

  const imported = await importTasks(tasks);
  storage.setItem(LEGACY_MIGRATION_MARKER_KEY, new Date().toISOString());
  return { status: "imported", imported };
}
