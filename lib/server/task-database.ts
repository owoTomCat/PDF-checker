import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_tasks (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_type TEXT,
  pdf_path TEXT,
  pdf_expires_at TEXT,
  pdf_deleted_at TEXT,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  processed_pages INTEGER NOT NULL DEFAULT 0,
  total_pages INTEGER,
  outcome TEXT,
  model TEXT,
  issue_count INTEGER,
  summary_json TEXT,
  report_json TEXT,
  report_text TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS audit_tasks_owner_created
  ON audit_tasks(owner_email, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_tasks_queue
  ON audit_tasks(status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS audit_tasks_pdf_expiry
  ON audit_tasks(pdf_expires_at, pdf_deleted_at);
`;

export function openTaskDatabase(dataDir: string): DatabaseSync {
  const databaseDir = path.join(dataDir, "data");
  mkdirSync(databaseDir, { recursive: true });

  const database = new DatabaseSync(path.join(databaseDir, "pdf-checker.sqlite"), {
    timeout: 5_000,
  });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const migration = database
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(1);
    if (!migration) {
      database.exec(INITIAL_SCHEMA);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    }
    const orphanClaimMigration = database
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(2);
    if (!orphanClaimMigration) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS pdf_orphan_deletion_claims (
          pdf_path TEXT PRIMARY KEY,
          claimed_at TEXT NOT NULL
        ) STRICT;
      `);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(2, new Date().toISOString());
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  return database;
}
