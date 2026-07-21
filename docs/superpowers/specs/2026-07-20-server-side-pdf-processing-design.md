# Server-side PDF processing design

## Goal

Move PDF parsing and rendering out of the browser. The browser uploads each original PDF once, the server persists the upload for 72 hours, and a durable background worker completes the existing strict audit pipeline even if the browser closes or reloads.

The design must preserve the current product behavior:

- enforce same-origin access and an explicit production ownership mode, using trusted authentication for any multi-user deployment;
- process at most three audit tasks concurrently;
- retain the current strict audit rules and `qwen3.7-plus` model contract;
- keep task search, date filtering, single deletion, and batch deletion;
- recover unfinished work after a service restart;
- never expose API keys or server paths, and never expose another authenticated user's tasks in multi-user mode.

The user's new requirement explicitly supersedes the repository's previous rule that original PDFs must never be uploaded to the application server. The replacement boundary is: original PDFs may be stored only in the server's private data directory, are never committed or logged, and are deleted after 72 hours.

## Non-goals

- This change does not upload PDFs to OSS. OSS can replace the 72-hour local file store in a later change without changing the task API.
- This change does not add Redis, a distributed queue, or horizontal worker scaling.
- This change does not resume in the middle of a PDF after a process crash. Recovery restarts the task from the beginning.
- This change does not persist rendered page images, cropped evidence images, or raw model responses.
- This change does not allow deletion or cancellation of an actively processing task.

## Chosen architecture

The deployment has two systemd services in the same repository and on the same server:

1. `pdf-checker.service` runs the existing web application and task APIs.
2. `pdf-checker-worker.service` runs one durable worker process with concurrency three.

Both processes use the same SQLite database and private upload directory:

```text
Browser
  -> POST /api/tasks (one PDF)
  -> private file + SQLite queued row
  -> 202 Accepted with task id

Worker
  -> atomically claims queued rows
  -> parses and renders PDF on the server
  -> calls the Bailian audit stages directly
  -> writes progress and final result to SQLite

Browser
  -> GET /api/tasks and GET /api/tasks/:id
  -> polls active tasks until terminal
```

The worker is a separate process so work does not depend on a browser request or on the web process remaining alive. It still uses SQLite rather than Redis, which is appropriate for the current single-server deployment.

## Persistent paths and permissions

Production uses:

```text
/var/lib/pdf-checker/
  data/pdf-checker.sqlite
  uploads/<task-id>.pdf
```

Configuration:

```text
PDF_AUDIT_DATA_DIR=/var/lib/pdf-checker
PDF_AUDIT_PDF_RETENTION_HOURS=72
PDF_AUDIT_WORKER_CONCURRENCY=3
PDF_AUDIT_WORKER_POLL_MS=1000
PDF_AUDIT_SINGLE_TENANT_OWNER=
```

The directory is owned by the service account `ubuntu`, has mode `0700`, and uploaded files have mode `0600`. The systemd units set `UMask=0077`. Original filenames are metadata only and are never used to construct filesystem paths.

Development and tests may override `PDF_AUDIT_DATA_DIR` with a temporary directory. Production must not fall back silently to a repository-relative directory.

## SQLite design

Use Node's built-in `node:sqlite` API on the declared Node 22.13+ runtime. Production remains on Node 24. SQLite is configured with WAL mode, foreign keys, and a busy timeout. Schema migrations run before either service starts accepting work.

The `audit_tasks` table stores:

| Field | Purpose |
| --- | --- |
| `id` | Server-generated UUID primary key |
| `owner_email` | Authenticated owner identity |
| `file_name`, `file_size`, `file_type` | Display and validation metadata |
| `pdf_path` | Nullable server-controlled absolute path; imported legacy rows have none |
| `pdf_expires_at`, `pdf_deleted_at` | 72-hour lifecycle |
| `status` | Existing task status enum |
| `progress`, `processed_pages`, `total_pages` | Pollable progress |
| `outcome`, `model`, `issue_count` | Result summary |
| `summary_json`, `report_json`, `report_text` | Validated final result |
| `error_code`, `error_message` | Sanitized terminal failure |
| `attempt_count` | Crash-recovery attempts |
| `created_at`, `updated_at`, `started_at`, `completed_at` | ISO timestamps |

JSON columns contain only values that pass the existing Zod schemas before insertion. The database never stores PDF bytes, rendered images, API keys, or unvalidated raw model output.

## Task states and queue behavior

The existing states remain the public contract:

```text
queued
  -> rendering
  -> locating
  -> recognizing
  -> reviewing_urls
  -> extracting_table
  -> associating
  -> finalizing
  -> completed | failed
```

The worker owns transitions after `queued`. It uses an immediate SQLite transaction to select the oldest queued task and mark it claimed before processing. One worker process runs three independent processing slots. Upload requests are not limited to three; the server queues excess work.

On worker startup:

- any task in a non-terminal processing state is returned to `queued`;
- progress is reset because processing restarts from the beginning;
- `attempt_count` is incremented when the task is claimed again;
- after three crash-recovery attempts, the task becomes `failed` with `WORKER_RETRY_EXHAUSTED` instead of looping forever.

Ordinary model or document errors are terminal for that attempt and are not blindly retried. Existing model-stage retry behavior remains inside the Bailian client where already defined.

## Task APIs

All routes use the existing same-origin and authentication guard. In an authenticated deployment, the authenticated email is the ownership key. In an auth-disabled single-tenant deployment, the server ignores caller-supplied identity headers and requires an explicit `PDF_AUDIT_SINGLE_TENANT_OWNER`; production never invents or falls back to an identity. Only non-production mode may fall back to `local-development`.

The current Tencent deployment uses the explicit single-tenant owner so the same server history is visible from the user's other computers. A future trusted authentication proxy can set `PDF_AUDIT_REQUIRE_AUTH=true`, provide `oai-authenticated-user-email`, and leave the single-tenant owner empty without changing the task schema.

### `POST /api/tasks`

Accept an `application/pdf` raw request body. The browser sends the original `File` once and places
its URL-encoded name in the single bounded `fileName` query parameter. Return `202 Accepted` with
the created task summary.

Validation order:

1. same-origin request plus either authenticated ownership or an explicitly configured single-tenant owner;
2. exactly one non-empty, safe filename no longer than 255 characters;
3. media type is `application/pdf`;
4. raw body is non-empty and no larger than 20 MiB;
5. binary prefix begins with `%PDF-`;
6. server-controlled task ID and path.

The server writes an `.uploading` file first, renames it atomically to `<task-id>.pdf`, and then inserts the queued database row. If the database insert fails, it removes the file. If writing fails, it never creates the row.

### `GET /api/tasks`

Return only the current user's tasks. The API supports the existing name and date filters plus bounded cursor pagination. The UI sends its active filters to the API and initially requests the most recent 80 matching records to preserve current behavior.

### `GET /api/tasks/:id`

Return the current user's task detail. Another user's ID is treated as not found.

### `POST /api/tasks/:id/retry`

Requeue a terminal task without requiring another upload when its retained PDF still exists. The operation clears the previous result and error, resets crash-recovery attempts, and returns the same task to `queued`. It is rejected when the PDF has expired or has already been deleted; in that case the user must select the PDF again.

### `DELETE /api/tasks/:id` and batch delete

Deletion is allowed only for terminal tasks. It removes any retained PDF and then deletes the row. Batch deletion is limited to 100 IDs per request and applies the same ownership and terminal-state checks atomically.

### Legacy browser history import

The first post-deployment load imports the current browser's completed or failed `localStorage` history into the authenticated user's SQLite history when such history exists. The import accepts at most 80 terminal tasks, validates every result with the existing schemas, never imports a PDF path, and is idempotent by task ID. Imported rows have no retained PDF. After a successful import, the browser marks that history version as migrated.

This prevents existing users from losing visible history while making all new tasks server-authoritative.

## Server-side PDF renderer

The browser `pdfjs-dist` import and PDF Worker asset are removed from the production UI path. The server renderer uses:

- `pdfjs-dist/legacy/build/pdf.mjs` for Node-compatible parsing;
- `@napi-rs/canvas` as an explicit production dependency;
- the existing render scale, DPI, grayscale/contrast, byte-size, and page-count rules.

The renderer implements the current `RenderedPdfDocument` interface so the strict pipeline can retain its tested page and region behavior. It reads the private file into a `Uint8Array`, creates one canvas per active render, encodes JPEG/PNG buffers, and releases page/canvas resources in `finally` blocks.

Encrypted PDFs, invalid PDFs, unsupported structures, rendering failures, and oversized rendered images receive distinct internal error codes. User messages remain safe and concise.

PDF.js is used only for parsing and rendering. The original PDF is not sent to Bailian; Bailian continues receiving the same bounded page and crop images as before.

References:

- PDF.js browser and legacy-build guidance: <https://github.com/mozilla/pdf.js/wiki/frequently-asked-questions>
- `@napi-rs/canvas` package: <https://www.npmjs.com/package/@napi-rs/canvas>
- Node SQLite API: <https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>

## Audit pipeline refactor

The current client pipeline mixes orchestration, browser rendering, and HTTP calls. Split it into three bounded units:

1. An environment-neutral audit orchestrator that owns stage ordering, batching, progress, and strict finalization inputs.
2. A server PDF renderer implementing page and region rendering.
3. A server model gateway that calls the existing Bailian client methods directly and applies the same Zod and page-coverage checks currently present in API routes.

Existing `/api/audit/*` routes remain for compatibility and are refactored to reuse the same model gateway, but the new browser flow no longer calls them stage by stage. This prevents an internal HTTP loop and avoids forwarding authentication headers between server components.

Every progress transition is persisted before the next expensive stage begins. Final results are schema-validated before the task is marked `completed`.

## Browser behavior

The browser becomes a task client rather than a PDF processor:

- Selecting files creates one upload request per PDF.
- Uploads may proceed independently, while server processing is capped at three.
- A successful upload immediately displays the server task as `queued`.
- Active tasks poll every two seconds while the page is visible and every five seconds while hidden.
- Page reload queries the server list and resumes polling active task IDs.
- Closing the page has no effect on worker execution.
- The local file cache and the “reselect PDF to reprocess” requirement are removed for new server tasks.
- “Reprocess” calls the server retry endpoint while the retained PDF is available; after expiry it asks for a new upload.
- `localStorage` is reduced to migration state and optional non-authoritative UI preferences.

The UI continues to disable deletion for active tasks. A task whose PDF has expired still displays its completed result, but cannot be reprocessed without selecting the PDF again.

## Error handling and observability

Public errors use stable codes, including:

- `INVALID_PDF_UPLOAD`
- `PDF_TOO_LARGE`
- `PDF_ENCRYPTED`
- `PDF_INVALID`
- `PDF_RENDER_FAILED`
- `TASK_NOT_FOUND`
- `TASK_ACTIVE`
- `MODEL_UNAVAILABLE`
- `INVALID_MODEL_OUTPUT`
- `WORKER_RETRY_EXHAUSTED`

The worker logs the task ID, stage, error code, and stack needed for diagnosis. It never logs PDF content, rendered image data, API keys, authentication headers, raw model responses, or full report contents. API responses do not expose absolute filesystem paths.

When the worker process exits unexpectedly, systemd restarts it. Database state is the recovery source of truth. A failure to persist a final result means the task is not marked complete.

## Retention cleanup

The worker runs an idempotent cleanup pass on startup and every 15 minutes:

- delete PDFs whose `pdf_expires_at` is in the past, except while their task is queued or active;
- mark `pdf_deleted_at` whether the file was deleted or already missing;
- remove abandoned `.uploading` files older than one hour;
- remove UUID-named PDF files older than one hour when no SQLite row references them, covering a crash between file rename and row insertion;
- never delete task results automatically.

Cleanup is path-safe: it operates only on UUID filenames under the resolved upload directory. A missing file is not treated as a fatal cleanup error.

## Deployment changes

Deployment adds:

- an update to `AGENTS.md` replacing the obsolete browser-only PDF boundary with the approved private 72-hour server-retention boundary;
- `/var/lib/pdf-checker/data` and `/var/lib/pdf-checker/uploads` with private permissions;
- `PDF_AUDIT_DATA_DIR` and retention/concurrency variables in `/etc/pdf-checker.env`;
- an explicit single-tenant owner in the current auth-disabled Tencent deployment, with no production identity fallback;
- `pdf-checker-worker.service`, ordered after the data-directory setup and network availability;
- a build step that emits `dist/audit-worker.mjs` from the typed worker entry point, with Node native modules externalized;
- `pdf-checker-worker.service` starts `/usr/local/bin/node /opt/pdf-checker/current/dist/audit-worker.mjs`;
- `@napi-rs/canvas` and its Linux x64 binary during `npm ci`;
- systemd hardening and restart policies for both services.

Nginx keeps the current 25 MiB request-body limit. The upload API returns quickly after durable local persistence, so model-processing time no longer depends on the Nginx request timeout.

Release switching must not touch `/var/lib/pdf-checker`, so code deployments preserve tasks, results, and retained PDFs.

## Testing strategy

### Unit tests

- PDF upload validation and magic-byte checks;
- task state transitions and owner isolation;
- SQLite migrations, WAL configuration, CRUD, pagination, and atomic claim behavior;
- restart recovery and three-attempt exhaustion;
- 72-hour cleanup and abandoned-upload cleanup;
- distinct PDF.js error mapping;
- progress persistence and final-result schema validation.

### Integration tests

- upload returns `202` only after file and row are durable;
- an uploaded task is processed without a live browser request;
- the worker never exceeds three concurrent tasks;
- simulated worker restart requeues unfinished work;
- task listing, polling, single deletion, and batch deletion enforce ownership;
- legacy local history import is bounded, schema-validated, and idempotent.

Tests generate a minimal PDF at runtime rather than committing PDF fixtures. A local, ignored real case is used for manual render verification.

### Release verification

- `npm run test:unit`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- systemd unit verification for web and worker;
- one real PDF upload, browser closure, background completion, reload, and result retrieval;
- process restart during an active task followed by successful reprocessing;
- verification that an artificially expired PDF is deleted while its result remains.

## Acceptance criteria

The change is complete when:

1. The browser no longer imports or executes PDF.js for new tasks.
2. The same PDF behaves consistently across supported Windows browsers because parsing occurs on the server.
3. Closing or refreshing the browser does not interrupt processing.
4. At most three server tasks process concurrently.
5. A server restart requeues unfinished tasks and prevents infinite crash loops.
6. Original PDFs are private and automatically removed after 72 hours.
7. Completed text results remain available after the PDF is removed.
8. Existing history management continues to work against server-authoritative records.
9. The real PDF-to-Bailian chain passes on the deployed server.
