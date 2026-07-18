import type { AuditTaskDetail } from "../types";

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
