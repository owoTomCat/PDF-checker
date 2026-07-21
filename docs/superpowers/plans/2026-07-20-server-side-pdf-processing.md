# Server-side PDF Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload original PDFs to private server storage, process them in a durable three-slot background worker, persist task state and results in SQLite, and remove browser-side PDF parsing.

**Architecture:** The web process accepts and validates one PDF per request, atomically persists it under `/var/lib/pdf-checker`, and records a queued task in SQLite. A separate systemd worker process claims up to three tasks, renders PDFs with PDF.js and `@napi-rs/canvas`, calls the existing Bailian stages directly, and writes progress and results back to SQLite. The browser becomes an upload, polling, history, and result client.

**Tech Stack:** TypeScript 5.9, Node.js 22.13+ (`node:sqlite`), Node.js 24 in production, Next.js 16, vinext, React 19, Zod 4, PDF.js 6.1.200, `@napi-rs/canvas` 1.0.2, systemd, Nginx, Alibaba Bailian `qwen3.7-plus`.

## Global Constraints

- Original PDFs are private server data, never Git data, and expire 72 hours after upload; queued or active PDFs are not deleted mid-process.
- Persisted rendered pages, crops, raw model responses, API keys, authentication headers, and absolute paths must never appear in public responses.
- The server processes at most three tasks concurrently, regardless of how many browser uploads are active.
- A worker restart requeues non-terminal tasks from the beginning and fails a task after three crash-recovery claims.
- All task reads, retries, imports, and deletes are owner-scoped. Authenticated deployments use `oai-authenticated-user-email`; an auth-disabled single-tenant deployment must set `PDF_AUDIT_SINGLE_TENANT_OWNER` explicitly and ignores any caller-supplied identity header. Only non-production mode may fall back to `local-development`.
- All model calls remain `qwen3.7-plus`, `enable_thinking: false`, JSON mode, with no `max_tokens`.
- Model output remains untrusted and must pass the existing Zod schemas before persistence or finalization.
- Active tasks cannot be deleted. A retained terminal PDF can be retried; an expired PDF requires a new upload.
- Each behavior change starts with a failing test and ends with focused tests plus an atomic commit.

---

### Task 0: Use a Node Runtime That Supports `node:sqlite`

**Files:**
- Verify only; do not modify repository files.

**Interfaces:**
- Produces: a shell where `node` is Node.js 24.x and `node:sqlite` imports successfully.

- [ ] **Step 1: Verify the current runtime before writing implementation code**

Run:

```powershell
node --version
node -e "import('node:sqlite').then(() => console.log('node:sqlite available'))"
```

Expected on the current default PATH: Node `v22.11.0`; the import fails with `ERR_UNKNOWN_BUILTIN_MODULE`. This is a prerequisite failure, not an application failure.

- [ ] **Step 2: Put the bundled Node 24 runtime first on PATH for this shell**

Run in the current Codex desktop workspace:

```powershell
$env:PATH='C:\Users\10794\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
node --version
node -e "import('node:sqlite').then(() => console.log('node:sqlite available'))"
```

Expected: Node `v24.14.0` and `node:sqlite available`. An experimental warning is acceptable. Re-run this PATH setup in every new implementation shell. Production continues to use `/usr/local/bin/node` and must report Node 24.x before rollout.

---

## File Structure

### Shared contracts

- Create `lib/task-contracts.ts`: task status, summary/detail, list/import/batch-delete schemas, and API error schema.
- Modify `lib/types.ts`: re-export the Zod-inferred task types so existing UI imports remain stable.
- Modify `AGENTS.md`: replace the obsolete browser-only original-PDF rule with the approved private 72-hour server-retention rule.
- Modify `.env.example`: document data directory, retention, worker concurrency, and polling configuration.

### Persistence and files

- Create `lib/server/task-database.ts`: open/configure/migrate SQLite.
- Create `lib/server/task-repository.ts`: owner-scoped CRUD, queue claims, recovery, progress, completion, failure, retry, and cleanup queries.
- Create `lib/server/task-files.ts`: path resolution, PDF validation, atomic writes, safe deletion, and orphan cleanup.
- Create `lib/server/task-owner.ts`: same-origin/auth guard plus owner resolution.

### Task API

- Create `lib/server/task-api.ts`: dependency-injected request handlers and public error mapping.
- Create `app/api/tasks/route.ts`: `POST` upload and `GET` filtered list.
- Create `app/api/tasks/[id]/route.ts`: `GET` detail and `DELETE` terminal task.
- Create `app/api/tasks/[id]/retry/route.ts`: retry retained terminal PDF.
- Create `app/api/tasks/batch-delete/route.ts`: delete up to 100 terminal tasks.
- Create `app/api/tasks/import/route.ts`: one-time bounded legacy history import.

### Audit execution

- Move `lib/client/audit-pipeline.ts` to `lib/audit/pipeline.ts`: environment-neutral orchestration.
- Create `lib/audit/gateway.ts`: typed stage gateway and rendered-document interfaces.
- Create `lib/server/bailian-audit-gateway.ts`: direct Bailian adapter and deterministic finalization.
- Create `lib/server/pdf-renderer.ts`: Node PDF.js and canvas renderer.
- Modify the six `app/api/audit/*/route.ts` modules: reuse the server gateway validation paths.

### Worker

- Create `lib/server/task-worker.ts`: recovery, three-slot queue loop, progress, cleanup, and error handling.
- Create `worker/audit-worker.ts`: production worker entry point.
- Create `vite.worker.config.ts`: emit `dist/audit-worker.mjs` without deleting the web build.
- Modify `package.json` and `package-lock.json`: explicit canvas dependency and worker build/start scripts.

### Browser

- Create `lib/client/task-api.ts`: typed upload/list/detail/retry/delete/import calls.
- Create `app/useAuditTasks.ts`: server-authoritative task state, polling, upload, retry, deletion, and one-time migration.
- Modify `app/AuditConsole.tsx`: presentation uses the hook and never invokes PDF.js.
- Delete `lib/client/pdf-renderer.ts`: remove browser renderer and worker asset import.
- Retain `lib/client/pdf-renderer-core.ts`: shared render calculations used by the Node renderer tests.

### Deployment and tests

- Create `deploy/pdf-checker-worker.service`.
- Modify `deploy/pdf-checker.service` and `deploy/nginx-pdf-checker.conf` only where required for private writable data and upload behavior.
- Modify `README.md` and deployment docs with storage, worker, recovery, and operational commands.
- Add focused tests named in each task below.

---

### Task 1: Define Server-authoritative Task Contracts and Security Boundary

**Files:**
- Create: `lib/task-contracts.ts`
- Modify: `lib/types.ts`
- Modify: `AGENTS.md`
- Modify: `.env.example`
- Test: `tests/task-contracts.test.ts`

**Interfaces:**
- Produces: `TaskStatusSchema`, `AuditTaskSummarySchema`, `AuditTaskDetailSchema`, `TaskListQuerySchema`, `TaskImportRequestSchema`, `BatchDeleteRequestSchema`, `TaskApiErrorSchema`.
- Produces: inferred `TaskStatus`, `AuditTaskSummary`, and `AuditTaskDetail` re-exported by `lib/types.ts`.

- [ ] **Step 1: Write the failing contract tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditTaskDetailSchema,
  BatchDeleteRequestSchema,
  TaskImportRequestSchema,
  TaskListQuerySchema,
} from "../lib/task-contracts";

test("task list query bounds pagination and normalizes filters", () => {
  assert.deepEqual(
    TaskListQuerySchema.parse({ query: "  report ", limit: "80" }),
    { query: "report", limit: 80 },
  );
  assert.throws(() => TaskListQuerySchema.parse({ limit: "201" }));
});

test("batch delete accepts at most one hundred unique task ids", () => {
  assert.deepEqual(
    BatchDeleteRequestSchema.parse({ ids: ["a", "a", "b"] }),
    { ids: ["a", "b"] },
  );
  assert.throws(() =>
    BatchDeleteRequestSchema.parse({
      ids: Array.from({ length: 101 }, (_, index) => `task-${index}`),
    }),
  );
});

test("legacy import accepts terminal tasks only", () => {
  const queued = {
    id: "legacy-1",
    fileName: "case.pdf",
    fileSize: 12,
    fileType: "application/pdf",
    status: "queued",
    outcome: null,
    model: null,
    progress: 0,
    processedPages: 0,
    totalPages: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    issueCount: null,
    summary: null,
    reportText: null,
    report: null,
  };
  assert.throws(() => TaskImportRequestSchema.parse({ tasks: [queued] }));
  assert.throws(() => AuditTaskDetailSchema.parse({ ...queued, status: "unknown" }));
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --import tsx --test tests/task-contracts.test.ts`

Expected: FAIL with `Cannot find module '../lib/task-contracts'`.

- [ ] **Step 3: Implement the Zod schemas and stable type re-exports**

Use these exact status values:

```ts
export const TaskStatusSchema = z.enum([
  "queued",
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
  "completed",
  "failed",
]);

export const ActiveTaskStatusSchema = z.enum([
  "queued",
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
]);

export const TaskListQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(80),
}).transform((value) => ({
  ...value,
  query: value.query || undefined,
}));

export const BatchDeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(101),
}).transform(({ ids }) => ({ ids: [...new Set(ids)] })).pipe(
  z.object({ ids: z.array(z.string()).min(1).max(100) }),
);
```

Build `AuditTaskSummarySchema` and `AuditTaskDetailSchema` from the exact fields currently defined in `lib/types.ts`, adding `errorCode: string | null`, `pdfExpiresAt: string | null`, and `pdfAvailable: boolean`. Define `TaskImportRequestSchema` as at most 80 `AuditTaskDetailSchema` values refined to `completed` or `failed`. Replace hand-written task types in `lib/types.ts` with `z.infer` re-exports.

- [ ] **Step 4: Update the repository boundary and environment template**

Replace the browser-only PDF rule in `AGENTS.md` with:

```markdown
- 原始 PDF 只能保存到服务器私有数据目录或经批准的 OSS 私有 Bucket，不得进入 Git、日志或公开 URL；服务器本地副本默认保留 72 小时，并且不得在任务处理中删除。
```

Append to `.env.example`:

```dotenv
PDF_AUDIT_DATA_DIR=
PDF_AUDIT_PDF_RETENTION_HOURS=72
PDF_AUDIT_WORKER_CONCURRENCY=3
PDF_AUDIT_WORKER_POLL_MS=1000
PDF_AUDIT_SINGLE_TENANT_OWNER=
```

- [ ] **Step 5: Run contract tests, typecheck, and lint**

Run:

```bash
node --import tsx --test tests/task-contracts.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add AGENTS.md .env.example lib/task-contracts.ts lib/types.ts tests/task-contracts.test.ts
git commit -m "feat: define server task contracts"
```

---

### Task 2: Add SQLite Migrations and Task Repository

**Files:**
- Create: `lib/server/task-database.ts`
- Create: `lib/server/task-repository.ts`
- Test: `tests/task-repository.test.ts`

**Interfaces:**
- Consumes: `AuditTaskDetail`, `TaskStatus`, and final-result schemas from Task 1.
- Produces: `openTaskDatabase(dataDir: string): DatabaseSync`.
- Produces: `TaskRepository` methods `create`, `list`, `getOwned`, `claimNext`, `updateProgress`, `complete`, `fail`, `recoverInterrupted`, `retryOwned`, `deleteOwnedTerminal`, `findExpiredPdfTasks`, and `markPdfDeleted`.

- [ ] **Step 1: Write repository tests against a temporary database**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskDatabase } from "../lib/server/task-database";
import { TaskRepository } from "../lib/server/task-repository";

test("repository isolates owners and atomically claims oldest queued work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  const repository = new TaskRepository(db);

  repository.create({
    id: "older",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "older.pdf"),
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });
  repository.create({
    id: "newer",
    ownerEmail: "b@example.com",
    fileName: "b.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "newer.pdf"),
    pdfExpiresAt: "2026-07-23T00:01:00.000Z",
    now: "2026-07-20T00:01:00.000Z",
  });

  assert.deepEqual(repository.list("a@example.com", { limit: 80 }).items.map((item) => item.id), ["older"]);
  assert.equal(repository.claimNext("2026-07-20T00:02:00.000Z")?.id, "older");
  assert.equal(repository.claimNext("2026-07-20T00:02:01.000Z")?.id, "newer");
  assert.equal(repository.claimNext("2026-07-20T00:02:02.000Z"), null);
});

test("restart recovery requeues twice and fails the third interrupted claim", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = openTaskDatabase(root);
  t.after(() => db.close());
  const repository = new TaskRepository(db);
  repository.create({
    id: "retry-me",
    ownerEmail: "a@example.com",
    fileName: "a.pdf",
    fileSize: 10,
    fileType: "application/pdf",
    pdfPath: path.join(root, "retry-me.pdf"),
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    repository.claimNext(`2026-07-20T00:0${attempt}:00.000Z`);
    repository.recoverInterrupted(`2026-07-20T00:0${attempt}:30.000Z`, 3);
  }
  const task = repository.getOwned("a@example.com", "retry-me");
  assert.equal(task?.status, "failed");
  assert.equal(task?.errorCode, "WORKER_RETRY_EXHAUSTED");
});
```

- [ ] **Step 2: Run the repository test and verify it fails**

Run: `node --import tsx --test tests/task-repository.test.ts`

Expected: FAIL because `task-database.ts` and `task-repository.ts` do not exist.

- [ ] **Step 3: Implement database opening and idempotent migration**

`openTaskDatabase` must create `<dataDir>/data`, open `pdf-checker.sqlite`, and execute:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

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
```

Use `new DatabaseSync(databasePath, { timeout: 5000 })` and a version-1 migration transaction. Never interpolate request values into SQL; bind every value with prepared statements.

- [ ] **Step 4: Implement row mapping and repository state transitions**

Define the claim transaction as one synchronous function:

```ts
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
```

`complete` must parse the final result with `StrictFinalAuditResponseSchema` before serializing it. `getOwned` and every user mutation must include both `id = ?` and `owner_email = ?`. `recoverInterrupted` must reset active statuses to queued when `attempt_count < maxAttempts`, and mark the rest failed with the stable exhaustion code.

- [ ] **Step 5: Run repository and contract tests**

Run:

```bash
node --import tsx --test tests/task-contracts.test.ts tests/task-repository.test.ts
npm run typecheck
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 6: Commit persistence**

```bash
git add lib/server/task-database.ts lib/server/task-repository.ts tests/task-repository.test.ts
git commit -m "feat: persist audit tasks in sqlite"
```

---

### Task 3: Add Private PDF Storage and 72-hour Cleanup

**Files:**
- Create: `lib/server/task-files.ts`
- Test: `tests/task-files.test.ts`

**Interfaces:**
- Produces: `resolveTaskDataPaths(dataDir)`.
- Produces: `validatePdfUpload(file: File): Promise<Uint8Array>`.
- Produces: `persistPdf({ dataDir, taskId, bytes }): Promise<string>`.
- Produces: `deleteTaskPdf(pdfPath, uploadDir): Promise<void>`.
- Produces: `cleanupTaskFiles({ repository, dataDir, now }): Promise<CleanupResult>`.

- [ ] **Step 1: Write upload and cleanup tests**

```ts
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistPdf,
  resolveTaskDataPaths,
  validatePdfUpload,
} from "../lib/server/task-files";

test("validates magic bytes and persists a private UUID-named PDF", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = new File([new TextEncoder().encode("%PDF-1.7\nbody")], "../../case.pdf", {
    type: "application/pdf",
  });
  const bytes = await validatePdfUpload(file);
  const pdfPath = await persistPdf({ dataDir: root, taskId: "8ce916b4-7297-4f7f-aac5-2e6e84de2032", bytes });
  assert.equal(path.basename(pdfPath), "8ce916b4-7297-4f7f-aac5-2e6e84de2032.pdf");
  assert.equal((await stat(pdfPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(pdfPath), Buffer.from(bytes));
});

test("rejects renamed non-PDF content", async () => {
  const file = new File(["not a pdf"], "case.pdf", { type: "application/pdf" });
  await assert.rejects(validatePdfUpload(file), /PDF 文件内容无效/);
});
```

Add cleanup cases that create an expired terminal PDF, an expired active PDF, an old `.uploading` file, and an unreferenced UUID PDF. Assert only the terminal and orphan files are removed.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --import tsx --test tests/task-files.test.ts`

Expected: FAIL because `lib/server/task-files.ts` is missing.

- [ ] **Step 3: Implement strict path and upload validation**

Use these constants and path checks:

```ts
const PDF_MAGIC = new TextEncoder().encode("%PDF-");
const UPLOAD_SUFFIX = ".uploading";
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertInsideUploadDir(candidate: string, uploadDir: string) {
  const relative = path.relative(path.resolve(uploadDir), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TaskFileError("UNSAFE_PDF_PATH", "PDF 存储路径无效。");
  }
}
```

`validatePdfUpload` checks one non-empty `File`, the existing 20 MiB maximum, filename/MIME acceptance, and the five `%PDF-` bytes. `persistPdf` requires a UUID v4 task ID, creates the upload directory as `0700`, writes `<id>.uploading` with `{ mode: 0o600, flag: "wx" }`, renames it atomically, and removes the temporary file in `catch`.

- [ ] **Step 4: Implement idempotent cleanup**

`cleanupTaskFiles` must:

1. query terminal expired rows whose `pdf_deleted_at` is null;
2. delete only paths inside the resolved upload directory;
3. treat `ENOENT` as success and mark the row deleted;
4. skip queued and active task PDFs;
5. remove `.uploading` and unreferenced UUID PDFs older than one hour;
6. return counts without returning filenames or content.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --import tsx --test tests/task-files.test.ts tests/task-repository.test.ts
npm run typecheck
```

Expected: all tests pass.

- [ ] **Step 6: Commit private file storage**

```bash
git add lib/server/task-files.ts tests/task-files.test.ts
git commit -m "feat: store uploaded PDFs privately"
```

---

### Task 4: Implement Owner-scoped Task APIs

**Files:**
- Create: `lib/server/task-owner.ts`
- Create: `lib/server/task-api.ts`
- Create: `app/api/tasks/route.ts`
- Create: `app/api/tasks/[id]/route.ts`
- Create: `app/api/tasks/[id]/retry/route.ts`
- Create: `app/api/tasks/batch-delete/route.ts`
- Create: `app/api/tasks/import/route.ts`
- Test: `tests/task-api.test.ts`

**Interfaces:**
- Consumes: repository and task-file APIs from Tasks 2-3.
- Produces: `taskOwnerFromRequest(request, env)`.
- Produces: dependency-injected `TaskApi` methods used by thin route modules.

- [ ] **Step 1: Write API tests for upload, owner isolation, retry, import, and deletion**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskApiForDataDir } from "../lib/server/task-api";

function authenticatedRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      origin: "https://pdf.example",
      "sec-fetch-site": "same-origin",
      "oai-authenticated-user-email": "owner@example.com",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

test("upload becomes durable before returning 202", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  const form = new FormData();
  form.set("pdf", new File(["%PDF-1.7\nbody"], "case.pdf", { type: "application/pdf" }));
  const response = await api.create(authenticatedRequest("https://pdf.example/api/tasks", { method: "POST", body: form }));
  assert.equal(response.status, 202);
  const task = await response.json();
  assert.equal(task.status, "queued");
  assert.equal(api.repository.getOwned("owner@example.com", task.id)?.id, task.id);
});

test("another owner sees not found instead of task metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  const response = await api.getOne(
    new Request("https://pdf.example/api/tasks/secret", {
      headers: {
        origin: "https://pdf.example",
        "sec-fetch-site": "same-origin",
        "oai-authenticated-user-email": "other@example.com",
      },
    }),
    "secret",
  );
  assert.equal(response.status, 404);
});
```

Add tests proving active delete returns `409 TASK_ACTIVE`, retry rejects a missing/expired PDF, batch delete rejects 101 unique IDs, and legacy import is terminal-only, owner-bound, idempotent, and limited to 80 tasks.

- [ ] **Step 2: Run the API test and verify it fails**

Run: `node --import tsx --test tests/task-api.test.ts`

Expected: FAIL because `lib/server/task-api.ts` is missing.

- [ ] **Step 3: Implement owner resolution and safe public errors**

```ts
export function taskOwnerFromRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const guard = modelRequestGuardOptionsFromEnv(env);
  assertModelRequestAllowed(request, guard);

  if (!guard.requireAuth) {
    const configuredOwner = env.PDF_AUDIT_SINGLE_TENANT_OWNER?.trim().toLowerCase();
    if (configuredOwner) return configuredOwner;
    if (env.NODE_ENV !== "production") return "local-development";
    throw new RequestGuardError("AUTH_REQUIRED", 401, "服务器尚未配置任务所有者。");
  }

  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (email) return email;
  throw new RequestGuardError("AUTH_REQUIRED", 401, "请先登录后再管理任务。");
}
```

Add tests proving an auth-disabled production request uses the explicit single-tenant owner, ignores a spoofed `oai-authenticated-user-email`, and fails closed when `PDF_AUDIT_SINGLE_TENANT_OWNER` is absent.

`taskApiErrorResponse` returns `{ error: { code, message } }`, never stack traces or filesystem paths. Unknown errors return status 500 and `INTERNAL_ERROR`.

- [ ] **Step 4: Implement the dependency-injected Task API service**

`TaskApi.create` must call `request.formData()`, require exactly one `pdf` entry, validate bytes, generate `crypto.randomUUID()`, persist the PDF, create the repository row with `expiresAt = now + 72 hours`, and return `AuditTaskSummarySchema` with status 202. On repository failure it deletes the just-written file.

Implement list filters through `TaskListQuerySchema`, ownership through `taskOwnerFromRequest`, terminal-only delete, retained-file retry, and import through the schemas from Task 1.

- [ ] **Step 5: Add thin Node runtime route modules**

Each route exports `runtime = "nodejs"` and delegates without duplicating logic. For example:

```ts
import { taskApiFromEnv } from "@/lib/server/task-api";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return taskApiFromEnv().create(request);
}

export async function GET(request: Request) {
  return taskApiFromEnv().list(request);
}
```

The dynamic routes await `context.params` and pass only the `id` string to the service.

- [ ] **Step 6: Run API, persistence, and file tests**

Run:

```bash
node --import tsx --test tests/task-api.test.ts tests/task-files.test.ts tests/task-repository.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit task APIs**

```bash
git add lib/server/task-owner.ts lib/server/task-api.ts app/api/tasks tests/task-api.test.ts
git commit -m "feat: add durable task APIs"
```

---

### Task 5: Refactor the Audit Pipeline Behind a Typed Gateway

**Files:**
- Create: `lib/audit/gateway.ts`
- Move: `lib/client/audit-pipeline.ts` -> `lib/audit/pipeline.ts`
- Create: `lib/server/bailian-audit-gateway.ts`
- Modify: `lib/client/pdf-renderer.ts` temporarily for moved type imports
- Modify: `app/api/audit/layout/route.ts`
- Modify: `app/api/audit/recognize-evidence/route.ts`
- Modify: `app/api/audit/review-url/route.ts`
- Modify: `app/api/audit/extract-table/route.ts`
- Modify: `app/api/audit/associate/route.ts`
- Modify: `app/api/audit/finalize/route.ts`
- Rename: `tests/client-pipeline.test.ts` -> `tests/audit-pipeline.test.ts`

**Interfaces:**
- Produces: `RenderedPdfDocument`, `RenderedImage`, and `AuditStageGateway` in `lib/audit/gateway.ts`.
- Produces: `runAuditPipeline(options): Promise<StrictFinalAuditResponse>` in `lib/audit/pipeline.ts`.
- Produces: `createBailianAuditGateway(client): AuditStageGateway`.

- [ ] **Step 1: Convert the pipeline test to a fake typed gateway**

Replace URL/fetch assertions with a fake implementing this interface:

```ts
export interface AuditStageGateway {
  locate(metadata: z.infer<typeof LayoutRequestMetadataSchema>, images: RenderedImage[]): Promise<z.infer<typeof LayoutApiResponseSchema>>;
  recognize(metadata: z.infer<typeof EvidenceRequestMetadataSchema>, images: RenderedImage[]): Promise<z.infer<typeof EvidenceApiResponseSchema>>;
  reviewUrls(metadata: z.infer<typeof UrlReviewRequestMetadataSchema>, images: RenderedImage[]): Promise<z.infer<typeof UrlReviewApiResponseSchema>>;
  extractTable(metadata: z.infer<typeof TableRequestMetadataSchema>, images: RenderedImage[]): Promise<z.infer<typeof TableApiResponseSchema>>;
  associate(input: z.infer<typeof AssociationRequestSchema>): Promise<z.infer<typeof AssociationApiResponseSchema>>;
  finalize(input: StrictFinalizeRequest): Promise<StrictFinalAuditResponse>;
}
```

The strict-order test must still assert this sequence:

```ts
assert.deepEqual(calls, [
  "render:1",
  "locate",
  "crop:certificate:1",
  "crop:rights_screenshot:1",
  "recognize",
  "crop:address_bar:color:600",
  "crop:address_bar:grayscale-contrast:600",
  "reviewUrls",
  "crop:summary_table:1",
  "extractTable",
  "associate",
  "finalize",
]);
```

- [ ] **Step 2: Run the renamed test and verify interface/import failures**

Run: `node --import tsx --test tests/audit-pipeline.test.ts`

Expected: FAIL because `lib/audit/pipeline.ts` and gateway interfaces are not implemented.

- [ ] **Step 3: Move orchestration and replace HTTP boundaries one stage at a time**

Run:

```bash
git mv lib/client/audit-pipeline.ts lib/audit/pipeline.ts
git mv tests/client-pipeline.test.ts tests/audit-pipeline.test.ts
```

Change `runAiAuditPipeline(file, options)` to:

```ts
export async function runAuditPipeline(options: {
  fileName: string;
  fileSize: number;
  fileType: string | null;
  pdf: RenderedPdfDocument;
  gateway: AuditStageGateway;
  onProgress?: (progress: PipelineProgress) => void | Promise<void>;
}): Promise<StrictFinalAuditResponse>
```

Remove `fetchImpl`, `defaultOpenPdf`, `responseJson`, `parseResponse`, and `imageForm`. Replace each `fetchImpl` stage call with the corresponding gateway method and await `onProgress` so the worker can persist progress before continuing. Keep batching, warnings, stage failures, coverage rules, and `pdf.destroy()` behavior unchanged.

- [ ] **Step 4: Implement the direct Bailian gateway**

Convert each `Blob` to a base64 data URL without logging it:

```ts
async function blobDataUrl(blob: Blob) {
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  return `data:${blob.type};base64,${base64}`;
}
```

Map the gateway methods to `locateRegions`, `recognizeEvidence`, `reviewUrls`, `extractTable`, and `associateRows`. Parse every response with its existing API response schema. Implement `finalize` with `StrictFinalizeRequestSchema.parse`, `buildFinalAuditResult`, and `StrictFinalAuditResponseSchema.parse`.

- [ ] **Step 5: Reuse gateway validation in existing audit routes**

Keep request guards and input parsers. Replace route-local Bailian call/response assembly with the equivalent `createBailianAuditGateway(createBailianClientFromEnv())` method. The external JSON and multipart contracts remain unchanged.

- [ ] **Step 6: Run pipeline and existing route tests**

Run:

```bash
node --import tsx --test tests/audit-pipeline.test.ts tests/audit-api.test.ts tests/request-guards.test.ts tests/bailian-client.test.ts
npm run typecheck
npm run lint
```

Expected: all strict pipeline assertions and route contracts pass.

- [ ] **Step 7: Commit the orchestration boundary**

```bash
git add lib/audit lib/server/bailian-audit-gateway.ts lib/client/pdf-renderer.ts app/api/audit tests/audit-pipeline.test.ts
git commit -m "refactor: isolate audit pipeline gateway"
```

---

### Task 6: Render PDFs on the Server

**Files:**
- Create: `lib/server/pdf-renderer.ts`
- Create: `scripts/verify-server-pdf.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `lib/client/pdf-renderer-core.ts` only if a platform-neutral type extraction is required
- Test: `tests/server-pdf-renderer.test.ts`
- Create: `tests/minimal-pdf.ts`

**Interfaces:**
- Consumes: `RenderedPdfDocument` from Task 5.
- Produces: `openServerPdf(pdfPath: string): Promise<RenderedPdfDocument>`.
- Produces: `ServerPdfError` with `PDF_ENCRYPTED`, `PDF_INVALID`, `PDF_UNSUPPORTED`, `PDF_IMAGE_TOO_LARGE`, and `PDF_RENDER_FAILED`.

- [ ] **Step 1: Add the explicit production canvas dependency**

Run: `npm install @napi-rs/canvas@1.0.2 --save`

Expected: `package.json` and `package-lock.json` record `@napi-rs/canvas` as a direct dependency.

- [ ] **Step 2: Add a generated minimal PDF helper and failing renderer tests**

`tests/minimal-pdf.ts` exports `minimalPdfBytes()` that computes object offsets and a valid xref table at runtime. The test writes those bytes to a temporary `.pdf`, opens it, asserts `pageCount === 1`, renders page 1 to a non-empty JPEG Blob, renders a PNG region, and destroys the document. A second test writes `%PDF-1.7\ninvalid` and expects `PDF_INVALID`.

```ts
test("renders a generated PDF page and region in Node", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "one-page.pdf");
  await writeFile(pdfPath, minimalPdfBytes());
  const document = await openServerPdf(pdfPath);
  t.after(() => document.destroy());
  assert.equal(document.pageCount, 1);
  const page = await document.renderPage(1);
  assert.equal(page.type, "image/jpeg");
  assert.ok(page.size > 100);
  const region = await document.renderRegion(
    1,
    { x: 0, y: 0, width: 1, height: 1 },
    { dpi: 200, variant: "grayscale-contrast", mimeType: "image/png" },
  );
  assert.equal(region.type, "image/png");
  assert.ok(region.size > 100);
});
```

- [ ] **Step 3: Run the renderer test and verify it fails**

Run: `node --import tsx --test tests/server-pdf-renderer.test.ts`

Expected: FAIL because `openServerPdf` is missing.

- [ ] **Step 4: Implement Node PDF.js and canvas rendering**

Import `getDocument` from `pdfjs-dist/legacy/build/pdf.mjs` and `createCanvas` from `@napi-rs/canvas`. Read bytes with `readFile`, pass `new Uint8Array(buffer)` to PDF.js, and map PDF.js exception names before returning the document interface.

Use the current constants exactly:

```ts
const MAX_RENDER_EDGE = 1_800;
const MAX_RENDER_SCALE = 2;
const JPEG_QUALITY = 0.84;
```

Encode with:

```ts
const buffer = mimeType === "image/jpeg"
  ? await canvas.encode("jpeg", JPEG_QUALITY * 100)
  : await canvas.encode("png");
return new Blob([buffer], { type: mimeType });
```

Reuse `computeRegionRenderPlan`, `applyGrayscaleContrast`, and `assertRenderBlobSize`. Release page resources and reset canvas dimensions in `finally` blocks. Do not set a browser worker URL.

- [ ] **Step 5: Add a privacy-safe real-PDF verification script**

`scripts/verify-server-pdf.ts` requires `PDF_AUDIT_VERIFY_PDF`, calls `openServerPdf`, renders every page once, destroys resources in `finally`, and prints only this JSON shape:

```ts
{
  fileName: path.basename(pdfPath),
  byteSize: fileStat.size,
  pageCount: document.pageCount,
  renderedImageSizes: renderedPages.map(({ page, blob }) => ({
    page,
    byteSize: blob.size,
    mimeType: blob.type,
  })),
}
```

It must never print extracted text, bytes, data URLs, absolute paths, or PDF metadata.

- [ ] **Step 6: Run renderer, core renderer, typecheck, and build**

Run:

```bash
node --import tsx --test tests/server-pdf-renderer.test.ts tests/pdf-renderer.test.ts
npm run typecheck
npm run build
```

Expected: generated PDF renders successfully and the production build exits 0.

- [ ] **Step 7: Commit server rendering**

```bash
git add package.json package-lock.json lib/server/pdf-renderer.ts lib/client/pdf-renderer-core.ts scripts/verify-server-pdf.ts tests/minimal-pdf.ts tests/server-pdf-renderer.test.ts
git commit -m "feat: render PDFs on the server"
```

---

### Task 7: Add the Durable Three-slot Worker

**Files:**
- Create: `lib/server/task-worker.ts`
- Create: `worker/audit-worker.ts`
- Create: `vite.worker.config.ts`
- Modify: `package.json`
- Modify: `scripts/run-vinext.mjs` only if build exit propagation needs correction
- Test: `tests/task-worker.test.ts`

**Interfaces:**
- Consumes: `TaskRepository`, `openServerPdf`, `runAuditPipeline`, `createBailianAuditGateway`, and cleanup from earlier tasks.
- Produces: `TaskWorker` with `start(signal)`, `runAvailable()`, and `stop()`.
- Produces: `dist/audit-worker.mjs` during `npm run build`.

- [ ] **Step 1: Write worker recovery and concurrency tests with injected work**

```ts
test("worker never runs more than three tasks concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const worker = makeTestWorker({
    concurrency: 3,
    queuedTaskCount: 6,
    async processTask() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });
  const running = worker.runAvailable();
  await waitFor(() => releases.length === 3);
  assert.equal(maximum, 3);
  releases.splice(0).forEach((release) => release());
  await waitFor(() => releases.length === 3);
  releases.splice(0).forEach((release) => release());
  await running;
  assert.equal(maximum, 3);
});

test("worker persists progress and completes after the caller disconnects", async () => {
  const harness = makeTestWorker({ concurrency: 1, queuedTaskCount: 1 });
  await harness.worker.runAvailable();
  assert.deepEqual(harness.progressStages, [
    "rendering",
    "locating",
    "recognizing",
    "reviewing_urls",
    "extracting_table",
    "associating",
    "finalizing",
  ]);
  assert.equal(harness.completedTaskIds.length, 1);
});
```

Also assert `recoverInterrupted` runs before claiming and cleanup runs on startup and on the configured interval.
Assert worker configuration accepts only integer concurrency values from 1 through 3, defaults to 3, and rejects a production value above 3 instead of silently exceeding the product limit.

- [ ] **Step 2: Run the worker test and verify it fails**

Run: `node --import tsx --test tests/task-worker.test.ts`

Expected: FAIL because `TaskWorker` does not exist.

- [ ] **Step 3: Implement worker slots and task processing**

Each slot repeatedly calls `claimNext`. For a claimed task:

1. assert `pdfPath` exists;
2. open the server PDF;
3. run the audit pipeline with a progress callback that awaits `repository.updateProgress`;
4. schema-validate and persist completion;
5. map a known safe error code/message and persist failure;
6. always destroy PDF resources.

The worker loop waits using an abortable timer rather than a permanent `setInterval`. SIGTERM aborts new claims and waits for current slots to settle for systemd's existing 30-second stop window.

- [ ] **Step 4: Implement the production entry point**

```ts
const database = openTaskDatabase(requireDataDir(process.env));
const repository = new TaskRepository(database);
const worker = createTaskWorkerFromEnv(repository);
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(signal));
}

try {
  await worker.start(controller.signal);
} finally {
  database.close();
}
```

Production must throw during startup if `PDF_AUDIT_DATA_DIR` is empty.

- [ ] **Step 5: Add a non-destructive worker build**

`vite.worker.config.ts` uses `build.ssr = "worker/audit-worker.ts"`, `build.outDir = "dist"`, `build.emptyOutDir = false`, target `node22`, entry name `audit-worker.mjs`, and externalizes `@napi-rs/canvas`, its platform binary, `pdfjs-dist`, and all `node:` built-ins.

Change scripts to:

```json
{
  "build:web": "node scripts/run-vinext.mjs build",
  "build:worker": "vite build --config vite.worker.config.ts",
  "build": "npm run build:web && npm run build:worker",
  "start:worker": "node dist/audit-worker.mjs"
}
```

- [ ] **Step 6: Run worker tests and verify the artifact starts far enough to validate configuration**

Run:

```bash
node --import tsx --test tests/task-worker.test.ts tests/task-repository.test.ts
npm run build
node dist/audit-worker.mjs
```

Expected: tests and build pass; the final command exits non-zero immediately with a safe `PDF_AUDIT_DATA_DIR is required` message and does not start a loop.

- [ ] **Step 7: Commit the worker**

```bash
git add lib/server/task-worker.ts worker/audit-worker.ts vite.worker.config.ts package.json scripts/run-vinext.mjs tests/task-worker.test.ts
git commit -m "feat: add durable PDF audit worker"
```

---

### Task 8: Replace Browser PDF Processing with Upload and Polling

**Files:**
- Create: `lib/client/task-api.ts`
- Create: `app/useAuditTasks.ts`
- Modify: `app/AuditConsole.tsx`
- Modify: `lib/client/task-history.ts`
- Delete: `lib/client/pdf-renderer.ts`
- Modify: `tests/rendered-html.test.mjs`
- Create: `tests/task-api-client.test.ts`
- Create: `tests/task-history-migration.test.ts`

**Interfaces:**
- Produces: typed client methods `uploadTask`, `listTasks`, `getTask`, `retryTask`, `deleteTask`, `deleteTasks`, and `importLegacyTasks`.
- Produces: `useAuditTasks(filters)` returning task state and UI actions.

- [ ] **Step 1: Write client API tests**

```ts
test("upload sends the original PDF once and parses the queued response", async () => {
  let captured: RequestInit | undefined;
  const file = new File(["%PDF-1.7\nbody"], "case.pdf", { type: "application/pdf" });
  const task = await uploadTask(file, async (_url, init) => {
    captured = init;
    return Response.json(queuedTaskFixture(), { status: 202 });
  });
  assert.equal(captured?.method, "POST");
  assert.equal((captured?.body as FormData).get("pdf"), file);
  assert.equal(task.status, "queued");
});

test("polling response rejects malformed task JSON", async () => {
  await assert.rejects(
    getTask("task-1", async () => Response.json({ status: "mystery" })),
    /任务服务返回了无效数据/,
  );
});
```

Update source tests to assert that `AuditConsole.tsx` no longer contains `runAiAuditPipeline`, `fileCacheRef`, or a `pdfjs-dist` import, and that the built client manifest contains no `pdf.worker` asset.

- [ ] **Step 2: Run the client tests and verify they fail**

Run:

```bash
node --import tsx --test tests/task-api-client.test.ts tests/task-history-migration.test.ts
node --test tests/rendered-html.test.mjs
```

Expected: FAIL because the task client and server-authoritative hook do not exist.

- [ ] **Step 3: Implement the typed task API client**

Every method accepts an optional `fetchImpl` for tests, uses same-origin relative URLs, and parses success bodies with the schemas from Task 1. Error bodies parse with `TaskApiErrorSchema`; unknown bodies become `任务服务暂时不可用，请稍后重试。`.

Build list query parameters with `URLSearchParams`, and use `encodeURIComponent(id)` for path segments. Batch delete uses `POST /api/tasks/batch-delete` with JSON and `Content-Type: application/json`.

- [ ] **Step 4: Implement the server-authoritative hook**

The hook must:

- load the active filtered task list from the server;
- debounce search/date filter changes by 250 ms;
- upload selected PDFs with at most three concurrent upload requests;
- add each 202 response immediately;
- poll visible-page active tasks every 2 seconds and hidden-page active tasks every 5 seconds;
- stop timers on unmount;
- merge detail responses by task ID;
- retry through the server endpoint;
- delete terminal tasks only after confirmation;
- perform one bounded, idempotent import from `pdf-audit-workspace.tasks.v4`, then write migration marker `pdf-audit-workspace.tasks.v4.server-migrated`.

Polling must be driven by server status and never hold the original `File` after upload completes.

- [ ] **Step 5: Reduce `AuditConsole` to presentation**

Remove `readStoredTasks`, `writeStoredTasks`, `createQueuedTask`, `processTask`, `runAiAuditPipeline`, and `fileCacheRef`. Replace them with hook actions. Update explanatory copy from browser rendering to private server processing and 72-hour retention. Preserve selected task behavior, history filters, checkboxes, single delete, batch delete, outcome presentation, and progress bars.

If retry returns `PDF_NOT_AVAILABLE`, show `原始 PDF 已超过 3 天保留期，请重新上传文件。`.

- [ ] **Step 6: Delete browser renderer and verify no worker asset is emitted**

Delete `lib/client/pdf-renderer.ts`, update moved type imports, run a production build, and inspect:

```bash
Get-ChildItem -Recurse -File dist/client | Where-Object Name -Match 'pdf\.worker'
```

Expected: no output.

- [ ] **Step 7: Run client, source, type, lint, and build checks**

Run:

```bash
node --import tsx --test tests/task-api-client.test.ts tests/task-history-migration.test.ts tests/task-history.test.ts
node --test tests/rendered-html.test.mjs
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0 and the client build has no PDF worker asset.

- [ ] **Step 8: Commit the browser migration**

```bash
git add app/AuditConsole.tsx app/useAuditTasks.ts lib/client/task-api.ts lib/client/task-history.ts tests/rendered-html.test.mjs tests/task-api-client.test.ts tests/task-history-migration.test.ts
git add -u lib/client/pdf-renderer.ts
git commit -m "feat: process uploaded PDFs on the server"
```

---

### Task 9: Add systemd Worker Deployment and Operations Documentation

**Files:**
- Create: `deploy/pdf-checker-worker.service`
- Modify: `deploy/pdf-checker.service`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-18-github-main-tencent-deployment-design.md`
- Test: `tests/deployment-config.test.mjs`

**Interfaces:**
- Consumes: `dist/audit-worker.mjs` and `/etc/pdf-checker.env`.
- Produces: two hardened systemd services sharing `/var/lib/pdf-checker`.

- [ ] **Step 1: Write deployment source tests**

```js
test("worker service uses the private data directory and built artifact", async () => {
  const service = await readFile(new URL("../deploy/pdf-checker-worker.service", import.meta.url), "utf8");
  assert.match(service, /User=ubuntu/);
  assert.match(service, /EnvironmentFile=\/etc\/pdf-checker\.env/);
  assert.match(service, /ExecStart=\/usr\/local\/bin\/node \/opt\/pdf-checker\/current\/dist\/audit-worker\.mjs/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/pdf-checker/);
  assert.match(service, /UMask=0077/);
});
```

Also assert both services use `NoNewPrivileges=true`, the web service has `ReadWritePaths=/var/lib/pdf-checker`, and Nginx retains `client_max_body_size 25m`.

- [ ] **Step 2: Run the deployment test and verify it fails**

Run: `node --test tests/deployment-config.test.mjs`

Expected: FAIL because the worker unit does not exist.

- [ ] **Step 3: Create the worker unit**

```ini
[Unit]
Description=PDF external-source audit worker
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/pdf-checker/current
Environment=NODE_ENV=production
EnvironmentFile=/etc/pdf-checker.env
ExecStart=/usr/local/bin/node /opt/pdf-checker/current/dist/audit-worker.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pdf-checker

[Install]
WantedBy=multi-user.target
```

Add the same `UMask`, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`, `ProtectHome`, and `ReadWritePaths` directives to the web service because task APIs write the upload and database before the worker claims them.

- [ ] **Step 4: Document installation and operations**

Document these exact server setup commands:

```bash
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/data
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/uploads
sudo install -o root -g root -m 0644 deploy/pdf-checker.service /etc/systemd/system/pdf-checker.service
sudo install -o root -g root -m 0644 deploy/pdf-checker-worker.service /etc/systemd/system/pdf-checker-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now pdf-checker.service pdf-checker-worker.service
```

Document `/etc/pdf-checker.env` additions:

```dotenv
PDF_AUDIT_DATA_DIR=/var/lib/pdf-checker
PDF_AUDIT_PDF_RETENTION_HOURS=72
PDF_AUDIT_WORKER_CONCURRENCY=3
PDF_AUDIT_WORKER_POLL_MS=1000
PDF_AUDIT_SINGLE_TENANT_OWNER=shared-server
```

For the current Tencent single-tenant deployment, keep `PDF_AUDIT_REQUIRE_AUTH=false` and set the explicit shared owner above. A future trusted authentication proxy should instead set `PDF_AUDIT_REQUIRE_AUTH=true`, supply `oai-authenticated-user-email`, and leave `PDF_AUDIT_SINGLE_TENANT_OWNER` empty.

Document that auth-disabled single-tenant mode gives every network client the same task history and delete permissions, so the Tencent firewall or reverse proxy must restrict the site to trusted users. It is not an acceptable mode for a public or multi-user deployment.

Include status, bounded log, queue/database backup, and cleanup checks without printing secrets.

- [ ] **Step 5: Run deployment, source, and full static checks**

Run:

```bash
node --test tests/deployment-config.test.mjs tests/rendered-html.test.mjs
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit deployment support**

```bash
git add deploy/pdf-checker-worker.service deploy/pdf-checker.service README.md docs/superpowers/specs/2026-07-18-github-main-tencent-deployment-design.md tests/deployment-config.test.mjs
git commit -m "ops: deploy durable PDF audit worker"
```

---

### Task 10: Full Verification, GitHub Publication, and Server Rollout

**Files:**
- Verify only; modify implementation files only in a focused follow-up commit when a verification failure proves a defect.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified local build, published GitHub `main`, and matching server release.

- [ ] **Step 1: Run the complete local verification suite**

Run:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run test:source
git diff --check
git status --short
```

Expected: every command exits 0; `git status --short` has no implementation changes.

- [ ] **Step 2: Verify a real ignored PDF renders entirely on the server**

Use the first local test case without committing it:

```powershell
$env:PDF_AUDIT_VERIFY_PDF='D:\Code\PPT\本地测试案例\7.14\（2026）沪0105民初13607号-12-外网溯源结果报告.pdf'
node --import tsx scripts/verify-server-pdf.ts
```

Expected: output contains only filename, byte size, page count, and rendered image sizes; it exits 0 and does not print PDF text or image data.

- [ ] **Step 3: Confirm GitHub state and publish a normal fast-forward**

Run:

```bash
gh auth status
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
git ls-remote origin refs/heads/main
```

Expected: the ancestor check exits 0, push succeeds without force, and remote `main` equals local `HEAD`.

- [ ] **Step 4: Restore SSH access evidence before deployment**

Run:

```powershell
ssh -6 -o BatchMode=yes -o ConnectTimeout=15 ubuntu@2402:4e00:1420:900:3c84:524:bcf4:0 "hostname; systemctl is-active pdf-checker nginx"
```

Expected: the connection reaches command execution and reports active services. If it still closes before key exchange, stop the rollout without changing the server and report the SSH transport blocker.

- [ ] **Step 5: Deploy the exact GitHub main commit as a release**

On the server:

```bash
set -eu
commit="$(git ls-remote https://github.com/owoTomCat/PDF-checker.git refs/heads/main | cut -f1)"
release="/opt/pdf-checker/releases/$commit"
sudo install -d -o ubuntu -g ubuntu -m 0755 /opt/pdf-checker/releases
test ! -e "$release"
git clone --filter=blob:none --no-checkout https://github.com/owoTomCat/PDF-checker.git "$release"
git -C "$release" checkout --detach "$commit"
cd "$release"
npm ci
npm run build
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker /var/lib/pdf-checker/data /var/lib/pdf-checker/uploads
sudo install -o root -g root -m 0644 deploy/pdf-checker.service /etc/systemd/system/pdf-checker.service
sudo install -o root -g root -m 0644 deploy/pdf-checker-worker.service /etc/systemd/system/pdf-checker-worker.service
sudoedit /etc/pdf-checker.env
sudo grep -q '^PDF_AUDIT_DATA_DIR=/var/lib/pdf-checker$' /etc/pdf-checker.env
sudo grep -q '^PDF_AUDIT_PDF_RETENTION_HOURS=72$' /etc/pdf-checker.env
sudo grep -q '^PDF_AUDIT_WORKER_CONCURRENCY=3$' /etc/pdf-checker.env
sudo grep -q '^PDF_AUDIT_WORKER_POLL_MS=1000$' /etc/pdf-checker.env
sudo grep -q '^PDF_AUDIT_SINGLE_TENANT_OWNER=shared-server$' /etc/pdf-checker.env
sudo systemctl stop pdf-checker-worker.service
sudo systemctl stop pdf-checker.service
sudo bash "$release/deploy/activate-release.sh" "$commit"
sudo systemctl daemon-reload
sudo systemctl enable pdf-checker.service pdf-checker-worker.service
sudo systemctl restart pdf-checker.service pdf-checker-worker.service
```

During `sudoedit`, preserve the existing Bailian key and add the five non-secret task/worker variables from Task 9. The `grep -q` checks verify their exact values without printing the file or its secret.

- [ ] **Step 6: Verify services, database, HTTP, and bounded logs**

Run on the server:

```bash
sudo systemd-analyze verify /etc/systemd/system/pdf-checker.service /etc/systemd/system/pdf-checker-worker.service
sudo nginx -t
sudo systemctl is-active pdf-checker.service pdf-checker-worker.service nginx.service
sudo journalctl -u pdf-checker.service -u pdf-checker-worker.service -n 100 --no-pager
sudo test -f /var/lib/pdf-checker/data/pdf-checker.sqlite
curl -fsS http://127.0.0.1:3000/ >/dev/null
readlink -f /opt/pdf-checker/current
```

Expected: unit and Nginx verification pass, all services are active, SQLite exists, local HTTP succeeds, and `current` resolves to the published commit. If this is the first release migration from a real `/opt/pdf-checker/current` directory, retain the generated `.current.pre-symlink.*` rollback directory until every health check passes. On a failed activation, restore that directory before restarting services; on a later symlink-to-symlink rollout, reactivate the previously verified commit with the same script.

- [ ] **Step 7: Run the deployed browser acceptance flow**

From `http://[2402:4e00:1420:900:3c84:524:bcf4:0]/`:

1. upload one real PDF;
2. confirm the task immediately becomes queued or active;
3. close the page;
4. wait for the worker to complete;
5. reopen from a second Windows computer;
6. confirm the same task and result are visible;
7. retry while the PDF is retained;
8. confirm three simultaneous active tasks is the maximum;
9. restart the worker during a disposable active task and confirm it requeues from the beginning;
10. set one disposable terminal row's expiry to the past, run cleanup, and confirm only its PDF is removed while its report remains.

- [ ] **Step 8: Record the rollout commit and final evidence**

Run:

```bash
git rev-parse HEAD
git status --short
```

Report the shared local/GitHub/server commit, verification commands that passed, real-case outcome, and any remaining operational caveat. Do not include keys, PDF content, raw model responses, or report contents.
