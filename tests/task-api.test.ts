import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFinalAuditResult } from "../lib/audit-result";
import { runtime as taskRoutesRuntime } from "../app/api/tasks/route";
import { runtime as taskRouteRuntime } from "../app/api/tasks/[id]/route";
import { runtime as retryRouteRuntime } from "../app/api/tasks/[id]/retry/route";
import { runtime as batchDeleteRouteRuntime } from "../app/api/tasks/batch-delete/route";
import { runtime as importRouteRuntime } from "../app/api/tasks/import/route";
import {
  createTaskApiForDataDir,
  taskOwnerFromRequest,
} from "../lib/server/task-api";
import { defaultTaskFileOperations } from "../lib/server/task-files";
import { strictFinalizeRequest } from "./strict-fixtures";

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

async function createUploadedTask(
  api: ReturnType<typeof createTaskApiForDataDir>,
  id?: string,
) {
  const form = new FormData();
  form.set("pdf", new File(["%PDF-1.7\nbody"], "case.pdf", { type: "application/pdf" }));
  const response = await api.create(authenticatedRequest("https://pdf.example/api/tasks", {
    method: "POST",
    body: form,
  }));
  assert.equal(response.status, 202);
  const task = await response.json() as { id: string };
  if (id) assert.equal(task.id, id);
  return task.id;
}

function terminalLegacyTask(id: string, overrides: Record<string, unknown> = {}) {
  const result = buildFinalAuditResult(strictFinalizeRequest);
  return {
    id,
    fileName: "legacy.pdf",
    fileSize: 12,
    fileType: "application/pdf",
    status: "completed",
    outcome: result.outcome,
    model: result.model,
    progress: 100,
    processedPages: 1,
    totalPages: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:01:00.000Z",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
    errorCode: null,
    errorMessage: null,
    issueCount: result.report.issues.length,
    summary: result.summary,
    pdfExpiresAt: null,
    pdfAvailable: false,
    reportText: result.reportText,
    report: result.report,
    ...overrides,
  };
}

test("upload becomes durable before returning 202", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-api-"));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));

  const id = await createUploadedTask(api);
  const task = api.repository.getOwned("owner@example.com", id);
  assert.equal(task?.id, id);
  assert.equal(task?.status, "queued");
  assert.equal(task?.pdfAvailable, true);
});

test("another owner sees not found instead of task metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-owner-"));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = await createUploadedTask(api);

  const response = await api.getOne(new Request(`https://pdf.example/api/tasks/${id}`, {
    headers: {
      origin: "https://pdf.example",
      "sec-fetch-site": "same-origin",
      "oai-authenticated-user-email": "other@example.com",
    },
  }), id);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: "TASK_NOT_FOUND", message: "The task was not found." },
  });
});

test("active delete returns TASK_ACTIVE without removing the row", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-active-delete-"));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = await createUploadedTask(api);

  const response = await api.remove(authenticatedRequest(`https://pdf.example/api/tasks/${id}`, { method: "DELETE" }), id);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { code: "TASK_ACTIVE", message: "The task is still being processed." },
  });
  assert.equal(api.repository.getOwned("owner@example.com", id)?.status, "queued");
});

test("retry rejects a missing retained PDF", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-retry-expired-"));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = await createUploadedTask(api);
  api.repository.fail({ id, errorCode: "PDF_INVALID", now: new Date().toISOString() });
  await rm(path.join(root, "uploads", `${id}.pdf`));

  const response = await api.retry(authenticatedRequest(`https://pdf.example/api/tasks/${id}/retry`, { method: "POST" }), id);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { code: "PDF_UNAVAILABLE", message: "The retained PDF is no longer available." },
  });
});

test("batch delete rejects 101 unique IDs and does not partially delete when an owned row is active", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-batch-delete-"));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const activeId = await createUploadedTask(api);
  const importedId = "legacy-terminal";
  await api.importLegacy(authenticatedRequest("https://pdf.example/api/tasks/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [terminalLegacyTask(importedId)] }),
  }));

  const oversized = await api.batchRemove(authenticatedRequest("https://pdf.example/api/tasks/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, index) => `task-${index}`) }),
  }));
  assert.equal(oversized.status, 422);

  const active = await api.batchRemove(authenticatedRequest("https://pdf.example/api/tasks/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [importedId, activeId] }),
  }));
  assert.equal(active.status, 409);
  assert.equal(api.repository.list("owner@example.com", { limit: 80 }).items.some((task) => task.fileName === "legacy.pdf"), true);
});

test("legacy import is terminal-only, owner-bound, idempotent, and limited to 80 tasks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-import-"));
  const api = createTaskApiForDataDir(root, { requireAuth: true });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const imported = terminalLegacyTask("legacy-task", {
    fileName: "C:\\private\\legacy.pdf",
    errorCode: "C:\\private\\legacy.pdf",
    errorMessage: "C:\\private\\legacy stack trace",
  });

  const first = await api.importLegacy(authenticatedRequest("https://pdf.example/api/tasks/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [imported] }),
  }));
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { imported: number }).imported, 1);
  const stored = api.repository.list("owner@example.com", { limit: 80 }).items.find((task) => task.fileName === "legacy.pdf");
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.fileName, "legacy.pdf");
  assert.equal(stored?.errorCode, "INTERNAL_ERROR");
  assert.doesNotMatch(stored?.errorMessage ?? "", /private|stack trace/i);

  const repeat = await api.importLegacy(authenticatedRequest("https://pdf.example/api/tasks/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [imported] }),
  }));
  assert.equal((await repeat.json() as { imported: number }).imported, 0);
  const otherOwner = await api.getOne(new Request(`https://pdf.example/api/tasks/${stored!.id}`, {
    headers: {
      origin: "https://pdf.example",
      "sec-fetch-site": "same-origin",
      "oai-authenticated-user-email": "other@example.com",
    },
  }), "legacy-task");
  assert.equal(otherOwner.status, 404);

  const nonTerminal = await api.importLegacy(authenticatedRequest("https://pdf.example/api/tasks/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [terminalLegacyTask("queued-legacy", { status: "queued", outcome: null, model: null, progress: 0, completedAt: null })] }),
  }));
  assert.equal(nonTerminal.status, 422);
  const tooMany = Array.from({ length: 81 }, (_, index) => terminalLegacyTask(`legacy-${index}`));
  const overflow = await api.importLegacy(authenticatedRequest("https://pdf.example/api/tasks/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: tooMany }),
  }));
  assert.equal(overflow.status, 422);
});

test("auth-disabled production uses only its configured single-tenant owner", () => {
  const request = new Request("https://pdf.example/api/tasks", {
    headers: {
      origin: "https://pdf.example",
      "sec-fetch-site": "same-origin",
      "oai-authenticated-user-email": "spoofed@example.com",
    },
  });
  assert.equal(taskOwnerFromRequest(request, {
    NODE_ENV: "production",
    PDF_AUDIT_REQUIRE_AUTH: "false",
    PDF_AUDIT_SINGLE_TENANT_OWNER: "Configured@Example.COM",
  }), "configured@example.com");
  assert.throws(() => taskOwnerFromRequest(request, {
    NODE_ENV: "production",
    PDF_AUDIT_REQUIRE_AUTH: "false",
  }), { code: "AUTH_REQUIRED" });
});

test("task route modules use the Node runtime", () => {
  assert.deepEqual(
    [taskRoutesRuntime, taskRouteRuntime, retryRouteRuntime, batchDeleteRouteRuntime, importRouteRuntime],
    ["nodejs", "nodejs", "nodejs", "nodejs", "nodejs"],
  );
});

test("failed deletion keeps its task row and failed upload rollback returns a safe error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-delete-retry-"));
  const taskId = "fce916b4-7297-4f7f-aac5-2e6e84de2032";
  const deleteId = "ace916b4-7297-4f7f-aac5-2e6e84de2032";
  let createCount = 0;
  const api = createTaskApiForDataDir(root, {
    requireAuth: true,
    createId: () => (createCount++ === 0 ? taskId : deleteId),
    fileOperations: {
      ...defaultTaskFileOperations,
      unlink: async () => {
        throw Object.assign(new Error("C:\\private\\uploads cannot unlink"), { code: "EACCES" });
      },
    },
  });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "uploads", `${taskId}.pdf`);

  api.repository.claimOrphanPdfDeletion(pdfPath, new Date().toISOString());
  const form = new FormData();
  form.set("pdf", new File(["%PDF-1.7\nbody"], "case.pdf", { type: "application/pdf" }));
  const rollback = await api.create(authenticatedRequest("https://pdf.example/api/tasks", { method: "POST", body: form }));
  assert.equal(rollback.status, 500);
  assert.doesNotMatch(JSON.stringify(await rollback.json()), /private|uploads/i);
  assert.equal(api.repository.getOwned("owner@example.com", taskId), null);
  await access(pdfPath);
  assert.equal(api.repository.claimOrphanPdfDeletion(pdfPath, new Date().toISOString()), true);

  const createdDeleteId = await createUploadedTask(api, deleteId);
  api.repository.fail({ id: createdDeleteId, errorCode: "PDF_INVALID", now: new Date().toISOString() });
  const removal = await api.remove(authenticatedRequest(`https://pdf.example/api/tasks/${createdDeleteId}`, { method: "DELETE" }), createdDeleteId);
  assert.equal(removal.status, 204);
  assert.equal(api.repository.getOwned("owner@example.com", createdDeleteId), null);
});

test("deletion reservation prevents a concurrent retry from losing its PDF", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-delete-race-"));
  const retryId = "bce916b4-7297-4f7f-aac5-2e6e84de2032";
  const api = createTaskApiForDataDir(root, {
    requireAuth: true,
    createId: () => retryId,
    fileOperations: {
      ...defaultTaskFileOperations,
      unlink: async (target) => {
        assert.equal(
          api.repository.retryOwned("owner@example.com", retryId, new Date().toISOString()),
          null,
        );
        await defaultTaskFileOperations.unlink(target);
      },
    },
  });
  t.after(() => api.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));
  await createUploadedTask(api, retryId);
  api.repository.fail({ id: retryId, errorCode: "PDF_INVALID", now: new Date().toISOString() });

  const response = await api.remove(authenticatedRequest(`https://pdf.example/api/tasks/${retryId}`, { method: "DELETE" }), retryId);
  assert.equal(response.status, 204);
  assert.equal(api.repository.getOwned("owner@example.com", retryId), null);
});
