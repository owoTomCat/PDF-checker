import { env as cloudflareEnv } from "cloudflare:workers";
import type {
  AuditTaskDetail,
  AuditTaskSummary,
  ExtractionSummary,
  TaskStatus,
} from "@/lib/types";

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results?: T[] }>;
  run: () => Promise<unknown>;
};

type D1DatabaseLike = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown[]>;
};

type R2ObjectLike = {
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type R2BucketLike = {
  put: (
    key: string,
    value: ArrayBuffer | ReadableStream,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  get: (key: string) => Promise<R2ObjectLike | null>;
};

type RuntimeBindings = {
  DB?: D1DatabaseLike;
  PDF_BUCKET?: R2BucketLike;
};

type TaskRecord = {
  id: string;
  file_name: string;
  file_size: number;
  file_type: string | null;
  object_key: string;
  status: TaskStatus;
  progress: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  report_json: string | null;
  report_text: string | null;
  extracted_summary_json: string | null;
};

let schemaReady: Promise<void> | null = null;

function getBindings() {
  return cloudflareEnv as unknown as RuntimeBindings;
}

export function getDatabase() {
  const db = getBindings().DB;
  if (!db) throw new Error("D1 数据库绑定不可用。");
  return db;
}

export function getPdfBucket() {
  const bucket = getBindings().PDF_BUCKET;
  if (!bucket) throw new Error("PDF 文件存储绑定不可用。");
  return bucket;
}

export async function ensureSchema() {
  if (!schemaReady) {
    const db = getDatabase();
    schemaReady = db
      .batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS audit_tasks (
            id TEXT PRIMARY KEY,
            file_name TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_type TEXT,
            object_key TEXT NOT NULL,
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            error_message TEXT,
            report_json TEXT,
            report_text TEXT,
            extracted_summary_json TEXT
          )`,
        ),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS audit_tasks_created_at_idx ON audit_tasks (created_at)",
        ),
        db.prepare(
          "CREATE INDEX IF NOT EXISTS audit_tasks_status_idx ON audit_tasks (status)",
        ),
      ])
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  await schemaReady;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toSummary(row: TaskRecord): AuditTaskSummary {
  const report = parseJson<{ report?: { issues?: unknown[] } }>(row.report_json);
  return {
    id: row.id,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileType: row.file_type,
    status: row.status,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    issueCount: Array.isArray(report?.report?.issues)
      ? report.report.issues.length
      : null,
    summary: parseJson<ExtractionSummary>(row.extracted_summary_json),
  };
}

function toDetail(row: TaskRecord): AuditTaskDetail {
  const stored = parseJson<{
    report?: AuditTaskDetail["report"];
    summary?: ExtractionSummary;
  }>(row.report_json);
  return {
    ...toSummary(row),
    reportText: row.report_text,
    report: stored?.report ?? null,
    summary:
      parseJson<ExtractionSummary>(row.extracted_summary_json) ??
      stored?.summary ??
      null,
  };
}

export async function listTasks(limit = 50) {
  await ensureSchema();
  const db = getDatabase();
  const { results = [] } = await db
    .prepare(
      `SELECT id, file_name, file_size, file_type, object_key, status, progress,
        created_at, updated_at, started_at, completed_at, error_message,
        report_json, report_text, extracted_summary_json
       FROM audit_tasks
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<TaskRecord>();
  return results.map(toSummary);
}

export async function getTask(id: string) {
  await ensureSchema();
  const db = getDatabase();
  const row = await db
    .prepare(
      `SELECT id, file_name, file_size, file_type, object_key, status, progress,
        created_at, updated_at, started_at, completed_at, error_message,
        report_json, report_text, extracted_summary_json
       FROM audit_tasks
       WHERE id = ?`,
    )
    .bind(id)
    .first<TaskRecord>();
  return row ? toDetail(row) : null;
}

export async function getTaskRecord(id: string) {
  await ensureSchema();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, file_name, file_size, file_type, object_key, status, progress,
        created_at, updated_at, started_at, completed_at, error_message,
        report_json, report_text, extracted_summary_json
       FROM audit_tasks
       WHERE id = ?`,
    )
    .bind(id)
    .first<TaskRecord>();
}

export async function createTask(input: {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string | null;
  objectKey: string;
}) {
  await ensureSchema();
  const now = new Date().toISOString();
  const db = getDatabase();
  await db
    .prepare(
      `INSERT INTO audit_tasks
        (id, file_name, file_size, file_type, object_key, status, progress,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 5, ?, ?)`,
    )
    .bind(
      input.id,
      input.fileName,
      input.fileSize,
      input.fileType,
      input.objectKey,
      now,
      now,
    )
    .run();
  const task = await getTask(input.id);
  if (!task) throw new Error("任务创建失败。");
  return task;
}

export async function markTaskProcessing(id: string) {
  await ensureSchema();
  const now = new Date().toISOString();
  await getDatabase()
    .prepare(
      `UPDATE audit_tasks
       SET status = 'processing', progress = 35, started_at = COALESCE(started_at, ?),
           updated_at = ?, error_message = NULL
       WHERE id = ?`,
    )
    .bind(now, now, id)
    .run();
}

export async function completeTask(
  id: string,
  reportText: string,
  reportJson: unknown,
  summary: ExtractionSummary,
) {
  await ensureSchema();
  const now = new Date().toISOString();
  await getDatabase()
    .prepare(
      `UPDATE audit_tasks
       SET status = 'completed', progress = 100, completed_at = ?, updated_at = ?,
           report_text = ?, report_json = ?, extracted_summary_json = ?,
           error_message = NULL
       WHERE id = ?`,
    )
    .bind(
      now,
      now,
      reportText,
      JSON.stringify(reportJson),
      JSON.stringify(summary),
      id,
    )
    .run();
}

export async function failTask(id: string, message: string) {
  await ensureSchema();
  const now = new Date().toISOString();
  await getDatabase()
    .prepare(
      `UPDATE audit_tasks
       SET status = 'failed', progress = 100, updated_at = ?, completed_at = ?,
           error_message = ?
       WHERE id = ?`,
    )
    .bind(now, now, message, id)
    .run();
}
