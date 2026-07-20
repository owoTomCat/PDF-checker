import * as z from "zod";
import {
  AuditTaskDetailSchema,
  AuditTaskSummarySchema,
  TaskApiErrorSchema,
  TaskListQuerySchema,
} from "../task-contracts";
import type { AuditTaskDetail, AuditTaskSummary } from "../types";

export type TaskFetch = typeof fetch;
export type TaskListFilters = Partial<z.output<typeof TaskListQuerySchema>>;

const INVALID_DATA_MESSAGE = "任务服务返回了无效数据。";
const SERVICE_UNAVAILABLE_MESSAGE = "任务服务暂时不可用，请稍后重试。";

const TaskListResponseSchema = z.object({
  items: z.array(AuditTaskSummarySchema),
  nextCursor: z.string().nullable(),
});
const BatchDeleteResponseSchema = z.object({
  deleted: z.array(z.string().min(1).max(200)),
});
const ImportResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
});

export class TaskApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "TaskApiClientError";
    this.code = code;
    this.status = status;
  }
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, init);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: TaskFetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new TaskApiClientError("SERVICE_UNAVAILABLE", 0, SERVICE_UNAVAILABLE_MESSAGE);
  }
  if (response.ok) return response;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TaskApiClientError("SERVICE_UNAVAILABLE", response.status, SERVICE_UNAVAILABLE_MESSAGE);
  }
  const parsed = TaskApiErrorSchema.safeParse(body);
  if (!parsed.success) {
    throw new TaskApiClientError("SERVICE_UNAVAILABLE", response.status, SERVICE_UNAVAILABLE_MESSAGE);
  }
  throw new TaskApiClientError(
    parsed.data.error.code,
    response.status,
    parsed.data.error.message,
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  fetchImpl: TaskFetch,
): Promise<T> {
  const response = await request(url, init, fetchImpl);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TaskApiClientError("INVALID_RESPONSE", response.status, INVALID_DATA_MESSAGE);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new TaskApiClientError("INVALID_RESPONSE", response.status, INVALID_DATA_MESSAGE);
  }
  return parsed.data;
}

function taskPath(id: string) {
  return `/api/tasks/${encodeURIComponent(id)}`;
}

export function uploadTask(
  file: File,
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
): Promise<AuditTaskSummary> {
  const form = new FormData();
  form.set("pdf", file);
  return requestJson(
    "/api/tasks",
    { method: "POST", body: form, signal },
    AuditTaskSummarySchema,
    fetchImpl,
  );
}

export function listTasks(
  filters: TaskListFilters = {},
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return requestJson(
    query ? `/api/tasks?${query}` : "/api/tasks",
    { method: "GET", signal },
    TaskListResponseSchema,
    fetchImpl,
  );
}

export function getTask(
  id: string,
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
): Promise<AuditTaskDetail> {
  return requestJson(
    taskPath(id),
    { method: "GET", signal },
    AuditTaskDetailSchema,
    fetchImpl,
  );
}

export function retryTask(
  id: string,
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
): Promise<AuditTaskSummary> {
  return requestJson(
    `${taskPath(id)}/retry`,
    { method: "POST", signal },
    AuditTaskSummarySchema,
    fetchImpl,
  );
}

export async function deleteTask(
  id: string,
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
) {
  await request(taskPath(id), { method: "DELETE", signal }, fetchImpl);
}

export async function deleteTasks(
  ids: string[],
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
) {
  const result = await requestJson(
    "/api/tasks/batch-delete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
      signal,
    },
    BatchDeleteResponseSchema,
    fetchImpl,
  );
  return result.deleted;
}

export async function importLegacyTasks(
  tasks: AuditTaskDetail[],
  fetchImpl: TaskFetch = defaultFetch,
  signal?: AbortSignal,
) {
  const result = await requestJson(
    "/api/tasks/import",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
      signal,
    },
    ImportResponseSchema,
    fetchImpl,
  );
  return result.imported;
}
