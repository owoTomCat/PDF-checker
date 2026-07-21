import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskApiClientError,
  deleteTask,
  deleteTasks,
  getTask,
  importLegacyTasks,
  listTasks,
  retryTask,
  uploadTask,
} from "../lib/client/task-api";
import type { AuditTaskDetail, AuditTaskSummary } from "../lib/types";

function summary(overrides: Partial<AuditTaskSummary> = {}): AuditTaskSummary {
  return {
    id: "task-1",
    fileName: "case.pdf",
    fileSize: 18,
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
    errorCode: null,
    errorMessage: null,
    issueCount: null,
    summary: null,
    pdfExpiresAt: "2026-07-23T00:00:00.000Z",
    pdfAvailable: true,
    ...overrides,
  };
}

function detail(overrides: Partial<AuditTaskDetail> = {}): AuditTaskDetail {
  return { ...summary(), reportText: null, report: null, ...overrides };
}

test("upload sends the original PDF once and parses the queued response", async () => {
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const file = new File(["%PDF-1.7\nbody"], "上海 报告（终）.pdf", {
    type: "application/pdf",
  });
  const task = await uploadTask(file, async (url, init) => {
    capturedUrl = String(url);
    captured = init;
    return Response.json(summary(), { status: 202 });
  });

  assert.equal(capturedUrl, "/api/tasks");
  assert.equal(captured?.method, "POST");
  assert.equal(new Headers(captured?.headers).get("content-type"), "application/pdf");
  assert.equal(
    new Headers(captured?.headers).get("x-pdf-file-name"),
    encodeURIComponent(file.name),
  );
  assert.equal(captured?.body, file);
  assert.equal(captured?.body instanceof FormData, false);
  assert.equal(task.status, "queued");
});

test("list uses URLSearchParams on a same-origin relative URL", async () => {
  let capturedUrl = "";
  const result = await listTasks(
    {
      query: "A&B report",
      createdFrom: "2026-07-01T00:00:00.000Z",
      createdTo: "2026-07-21T00:00:00.000Z",
      limit: 80,
    },
    async (url, init) => {
      capturedUrl = String(url);
      assert.equal(init?.method, "GET");
      return Response.json({ items: [summary()], nextCursor: "next page" });
    },
  );

  const url = new URL(capturedUrl, "https://example.invalid");
  assert.equal(url.origin, "https://example.invalid");
  assert.equal(url.pathname, "/api/tasks");
  assert.equal(url.searchParams.get("query"), "A&B report");
  assert.equal(url.searchParams.get("createdFrom"), "2026-07-01T00:00:00.000Z");
  assert.equal(url.searchParams.get("limit"), "80");
  assert.equal(result.items[0]?.id, "task-1");
  assert.equal(result.nextCursor, "next page");
});

test("detail and retry encode task IDs and reject malformed success JSON", async () => {
  const urls: string[] = [];
  const encodedId = "folder/name ?#";
  await getTask(encodedId, async (url) => {
    urls.push(String(url));
    return Response.json(detail());
  });
  await retryTask(encodedId, async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.method, "POST");
    return Response.json(summary(), { status: 202 });
  });

  assert.deepEqual(urls, [
    `/api/tasks/${encodeURIComponent(encodedId)}`,
    `/api/tasks/${encodeURIComponent(encodedId)}/retry`,
  ]);
  await assert.rejects(
    getTask("task-1", async () => Response.json({ status: "mystery" })),
    /任务服务返回了无效数据。/,
  );
});

test("delete and import mutations use the documented methods and JSON bodies", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("batch-delete")) {
      return Response.json({ deleted: ["one", "two"] });
    }
    if (String(url).endsWith("/import")) {
      return Response.json({ imported: 1 });
    }
    return new Response(null, { status: 204 });
  };

  await deleteTask("task/one", fetchImpl);
  const deleted = await deleteTasks(["one", "two"], fetchImpl);
  const imported = await importLegacyTasks([detail({ status: "failed", outcome: "failed" })], fetchImpl);

  assert.equal(calls[0]?.url, `/api/tasks/${encodeURIComponent("task/one")}`);
  assert.equal(calls[0]?.init?.method, "DELETE");
  assert.equal(calls[1]?.url, "/api/tasks/batch-delete");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.equal(new Headers(calls[1]?.init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { ids: ["one", "two"] });
  assert.deepEqual(deleted, ["one", "two"]);
  assert.equal(calls[2]?.url, "/api/tasks/import");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    tasks: [detail({ status: "failed", outcome: "failed" })],
  });
  assert.equal(imported, 1);
});

test("API errors expose validated codes while unknown bodies use safe Chinese copy", async () => {
  await assert.rejects(
    retryTask("expired", async () =>
      Response.json(
        { error: { code: "PDF_UNAVAILABLE", message: "The retained PDF is no longer available." } },
        { status: 409 },
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof TaskApiClientError);
      assert.equal(error.code, "PDF_UNAVAILABLE");
      assert.equal(error.status, 409);
      return true;
    },
  );

  await assert.rejects(
    getTask("task-1", async () => new Response("proxy exploded", { status: 502 })),
    /任务服务暂时不可用，请稍后重试。/,
  );
});
