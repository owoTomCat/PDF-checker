import type { DatabaseSync } from "node:sqlite";
import {
  StrictAuditReportSchema,
  StrictExtractionSummarySchema,
  StrictFinalAuditResponseSchema,
  type StrictFinalAuditResponse,
} from "../ai/contracts";
import type {
  AuditTaskDetail,
  AuditTaskSummary,
  TaskStatus,
} from "../task-contracts";

type TaskRow = {
  id: string;
  owner_email: string;
  file_name: string;
  file_size: number;
  file_type: string | null;
  pdf_path: string | null;
  pdf_expires_at: string | null;
  pdf_deleted_at: string | null;
  status: TaskStatus;
  progress: number;
  processed_pages: number;
  total_pages: number | null;
  outcome: AuditTaskDetail["outcome"];
  model: AuditTaskDetail["model"];
  issue_count: number | null;
  summary_json: string | null;
  report_json: string | null;
  report_text: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

const ACTIVE_STATUSES = [
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
] as const;

export type WorkerTask = AuditTaskDetail & {
  ownerEmail: string;
  pdfPath: string | null;
  attemptCount: number;
};

export type CreateTaskInput = {
  id: string;
  ownerEmail: string;
  fileName: string;
  fileSize: number;
  fileType: string | null;
  pdfPath: string;
  pdfExpiresAt: string;
  now: string;
};

export type TaskListOptions = {
  query?: string;
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
  limit: number;
};

export type UpdateProgressInput = {
  id: string;
  status: Extract<TaskStatus, (typeof ACTIVE_STATUSES)[number]>;
  progress: number;
  processedPages: number;
  totalPages: number;
  now: string;
};

export type CompleteTaskInput = {
  id: string;
  result: unknown;
  now: string;
};

export type FailTaskInput = {
  id: string;
  errorCode: string;
  errorMessage: string;
  now: string;
};

function parseJson<T>(value: string | null, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(JSON.parse(value));
}

function mapTaskDetail(row: TaskRow): AuditTaskDetail {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileType: row.file_type,
    status: row.status,
    outcome: row.outcome,
    model: row.model,
    progress: row.progress,
    processedPages: row.processed_pages,
    totalPages: row.total_pages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    issueCount: row.issue_count,
    summary: parseJson(row.summary_json, StrictExtractionSummarySchema.parse),
    pdfExpiresAt: row.pdf_expires_at,
    pdfAvailable: row.pdf_path !== null && row.pdf_deleted_at === null,
    reportText: row.report_text,
    report: parseJson(row.report_json, StrictAuditReportSchema.parse),
  };
}

function mapTaskSummary(row: TaskRow): AuditTaskSummary {
  const { report: _report, reportText: _reportText, ...summary } = mapTaskDetail(row);
  return summary;
}

function mapWorkerTask(row: TaskRow): WorkerTask {
  return {
    ...mapTaskDetail(row),
    ownerEmail: row.owner_email,
    pdfPath: row.pdf_path,
    attemptCount: row.attempt_count,
  };
}

function changedRows(result: { changes: number | bigint }): boolean {
  return typeof result.changes === "bigint"
    ? result.changes !== BigInt(0)
    : result.changes !== 0;
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateTaskInput): AuditTaskDetail {
    this.db.prepare(`
      INSERT INTO audit_tasks (
        id, owner_email, file_name, file_size, file_type, pdf_path, pdf_expires_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      input.id,
      input.ownerEmail,
      input.fileName,
      input.fileSize,
      input.fileType,
      input.pdfPath,
      input.pdfExpiresAt,
      input.now,
      input.now,
    );
    const row = this.db.prepare("SELECT * FROM audit_tasks WHERE id = ?").get(input.id) as TaskRow;
    return mapTaskDetail(row);
  }

  list(ownerEmail: string, options: TaskListOptions): { items: AuditTaskSummary[]; nextCursor: string | null } {
    const cursor = options.cursor
      ? this.db.prepare("SELECT created_at, id FROM audit_tasks WHERE id = ? AND owner_email = ?").get(options.cursor, ownerEmail) as Pick<TaskRow, "created_at" | "id"> | undefined
      : undefined;
    const rows = this.db.prepare(`
      SELECT * FROM audit_tasks
      WHERE owner_email = ?
        AND (? IS NULL OR file_name LIKE '%' || ? || '%' COLLATE NOCASE)
        AND (? IS NULL OR created_at >= ?)
        AND (? IS NULL OR created_at <= ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ownerEmail,
      options.query ?? null,
      options.query ?? null,
      options.createdFrom ?? null,
      options.createdFrom ?? null,
      options.createdTo ?? null,
      options.createdTo ?? null,
      cursor?.created_at ?? null,
      cursor?.created_at ?? null,
      cursor?.created_at ?? null,
      cursor?.id ?? null,
      options.limit + 1,
    ) as TaskRow[];
    const hasMore = rows.length > options.limit;
    const items = rows.slice(0, options.limit).map(mapTaskSummary);
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  getOwned(ownerEmail: string, id: string): AuditTaskDetail | null {
    const row = this.db.prepare(
      "SELECT * FROM audit_tasks WHERE id = ? AND owner_email = ?",
    ).get(id, ownerEmail) as TaskRow | undefined;
    return row ? mapTaskDetail(row) : null;
  }

  claimNext(now: string): WorkerTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT * FROM audit_tasks
        WHERE status = 'queued' AND attempt_count < 3
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get() as TaskRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(`
        UPDATE audit_tasks
        SET status = 'rendering', progress = 1, processed_pages = 0,
            started_at = COALESCE(started_at, ?), updated_at = ?,
            completed_at = NULL, error_code = NULL, error_message = NULL,
            attempt_count = attempt_count + 1
        WHERE id = ? AND status = 'queued'
      `).run(now, now, row.id);
      const claimed = this.db.prepare("SELECT * FROM audit_tasks WHERE id = ?").get(row.id) as TaskRow;
      this.db.exec("COMMIT");
      return mapWorkerTask(claimed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateProgress(input: UpdateProgressInput): AuditTaskDetail | null {
    const result = this.db.prepare(`
      UPDATE audit_tasks
      SET status = ?, progress = ?, processed_pages = ?, total_pages = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')
    `).run(
      input.status,
      input.progress,
      input.processedPages,
      input.totalPages,
      input.now,
      input.id,
    );
    if (!changedRows(result)) return null;
    const row = this.db.prepare("SELECT * FROM audit_tasks WHERE id = ?").get(input.id) as TaskRow;
    return mapTaskDetail(row);
  }

  complete(input: CompleteTaskInput): AuditTaskDetail | null {
    const finalResult = StrictFinalAuditResponseSchema.parse(input.result);
    const result = this.db.prepare(`
      UPDATE audit_tasks
      SET status = 'completed', progress = 100, outcome = ?, model = ?, issue_count = ?,
          summary_json = ?, report_json = ?, report_text = ?, error_code = NULL,
          error_message = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')
    `).run(
      finalResult.outcome,
      finalResult.model,
      finalResult.report.issues.length,
      JSON.stringify(finalResult.summary),
      JSON.stringify(finalResult.report),
      finalResult.reportText,
      input.now,
      input.now,
      input.id,
    );
    if (!changedRows(result)) return null;
    const row = this.db.prepare("SELECT * FROM audit_tasks WHERE id = ?").get(input.id) as TaskRow;
    return mapTaskDetail(row);
  }

  fail(input: FailTaskInput): AuditTaskDetail | null {
    const result = this.db.prepare(`
      UPDATE audit_tasks
      SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')
    `).run(input.errorCode, input.errorMessage, input.now, input.now, input.id);
    if (!changedRows(result)) return null;
    const row = this.db.prepare("SELECT * FROM audit_tasks WHERE id = ?").get(input.id) as TaskRow;
    return mapTaskDetail(row);
  }

  recoverInterrupted(now: string, maxAttempts: number): void {
    const activeStatuses = ACTIVE_STATUSES.map(() => "?").join(", ");
    this.db.prepare(`
      UPDATE audit_tasks
      SET status = 'queued', progress = 0, processed_pages = 0,
          updated_at = ?, completed_at = NULL, error_code = NULL, error_message = NULL
      WHERE status IN (${activeStatuses}) AND attempt_count < ?
    `).run(now, ...ACTIVE_STATUSES, maxAttempts);
    this.db.prepare(`
      UPDATE audit_tasks
      SET status = 'failed', updated_at = ?, completed_at = ?,
          error_code = 'WORKER_RETRY_EXHAUSTED',
          error_message = 'Worker retry limit exhausted.'
      WHERE status IN (${activeStatuses}) AND attempt_count >= ?
    `).run(now, now, ...ACTIVE_STATUSES, maxAttempts);
  }

  retryOwned(ownerEmail: string, id: string, now: string): AuditTaskDetail | null {
    const result = this.db.prepare(`
      UPDATE audit_tasks
      SET status = 'queued', progress = 0, processed_pages = 0, total_pages = NULL,
          outcome = NULL, model = NULL, issue_count = NULL, summary_json = NULL,
          report_json = NULL, report_text = NULL, error_code = NULL, error_message = NULL,
          attempt_count = 0, started_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND owner_email = ? AND status IN ('completed', 'failed')
        AND pdf_path IS NOT NULL AND pdf_deleted_at IS NULL
        AND (pdf_expires_at IS NULL OR pdf_expires_at > ?)
    `).run(now, id, ownerEmail, now);
    if (!changedRows(result)) return null;
    const row = this.db.prepare(
      "SELECT * FROM audit_tasks WHERE id = ? AND owner_email = ?",
    ).get(id, ownerEmail) as TaskRow;
    return mapTaskDetail(row);
  }

  deleteOwnedTerminal(ownerEmail: string, id: string): WorkerTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT * FROM audit_tasks
        WHERE id = ? AND owner_email = ? AND status IN ('completed', 'failed')
      `).get(id, ownerEmail) as TaskRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(`
        DELETE FROM audit_tasks
        WHERE id = ? AND owner_email = ? AND status IN ('completed', 'failed')
      `).run(id, ownerEmail);
      this.db.exec("COMMIT");
      return mapWorkerTask(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findExpiredPdfTasks(now: string): WorkerTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM audit_tasks
      WHERE status IN ('completed', 'failed')
        AND pdf_path IS NOT NULL AND pdf_deleted_at IS NULL
        AND pdf_expires_at IS NOT NULL AND pdf_expires_at <= ?
    `).all(now) as TaskRow[];
    return rows.map(mapWorkerTask);
  }

  markPdfDeleted(id: string, now: string): boolean {
    return changedRows(this.db.prepare(`
      UPDATE audit_tasks
      SET pdf_path = NULL, pdf_deleted_at = ?, updated_at = ?
      WHERE id = ? AND pdf_deleted_at IS NULL
    `).run(now, now, id));
  }
}

export type { StrictFinalAuditResponse };
