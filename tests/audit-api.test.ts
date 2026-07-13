import assert from "node:assert/strict";
import test from "node:test";
import { POST as extractPages } from "../app/api/audit/extract/route";
import { POST as finalizeAudit } from "../app/api/audit/finalize/route";

const originalEnv = {
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseUrl: process.env.DASHSCOPE_BASE_URL,
  model: process.env.QWEN_MODEL,
  requireAuth: process.env.PDF_AUDIT_REQUIRE_AUTH,
};

process.env.DASHSCOPE_API_KEY = "test-secret";
process.env.DASHSCOPE_BASE_URL =
  "https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
process.env.QWEN_MODEL = "qwen3.7-plus";
process.env.PDF_AUDIT_REQUIRE_AUTH = "false";

test.after(() => {
  process.env.DASHSCOPE_API_KEY = originalEnv.apiKey;
  process.env.DASHSCOPE_BASE_URL = originalEnv.baseUrl;
  process.env.QWEN_MODEL = originalEnv.model;
  process.env.PDF_AUDIT_REQUIRE_AUTH = originalEnv.requireAuth;
});

function modelResponse(content: unknown) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(content) } }],
  });
}

function extractionOutput(pageNumber = 1) {
  return {
    pages: [
      {
        pageNumber,
        pageType: "cover",
        firstPageTable: {
          caseNumber: "示例案号",
          feedbackDate: "2026-07-13",
          rightsHolderName: "示例权利人",
          workType: "摄影作品",
        },
        certificate: null,
        resultTables: [],
        screenshots: [],
        warnings: [],
        confidence: 0.98,
      },
    ],
    warnings: [],
  };
}

function extractRequest(file: File, pageNumbers = [1]) {
  const form = new FormData();
  form.append("fileName", "example.pdf");
  form.append("totalPages", "1");
  form.append("pageNumbers", JSON.stringify(pageNumbers));
  form.append("pages", file);
  return new Request("https://audit.example.com/api/audit/extract", {
    method: "POST",
    headers: { origin: "https://audit.example.com" },
    body: form,
  });
}

test("extract API accepts a bounded JPEG batch and returns validated pages", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = "";
  globalThis.fetch = async (_url, init) => {
    upstreamBody = String(init?.body);
    return modelResponse(extractionOutput());
  };

  try {
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00])],
      "page-1.jpg",
      { type: "image/jpeg" },
    );
    const response = await extractPages(extractRequest(file));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.model, "qwen3.7-plus");
    assert.equal(body.pages[0].pageNumber, 1);
    assert.match(upstreamBody, /data:image\/jpeg;base64/);
    assert.doesNotMatch(upstreamBody, /application\/pdf/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extract API rejects a spoofed image before calling the model", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return modelResponse(extractionOutput());
  };

  try {
    const file = new File(["not-a-jpeg"], "page-1.jpg", {
      type: "image/jpeg",
    });
    const response = await extractPages(extractRequest(file));
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.error.code, "INVALID_IMAGE");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finalize API returns needs_review for incomplete model evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    modelResponse({
      firstPageTable: {
        caseNumber: "示例案号",
        feedbackDate: "2026-07-13",
        rightsHolderName: "示例权利人",
        workType: "摄影作品",
      },
      certificate: null,
      groups: [],
      extractionComplete: false,
      confidence: 0.6,
      warnings: ["未识别到结果表格"],
    });

  try {
    const response = await finalizeAudit(
      new Request("https://audit.example.com/api/audit/finalize", {
        method: "POST",
        headers: {
          origin: "https://audit.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fileName: "example.pdf",
          pageCount: 1,
          pages: extractionOutput().pages,
        }),
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.outcome, "needs_review");
    assert.match(body.reportText, /需人工复核/);
    assert.doesNotMatch(body.reportText, /pdf中无错误/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API maps malformed model output to a stable generic error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ message: { content: "not-json" } }] });

  try {
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00])],
      "page-1.jpg",
      { type: "image/jpeg" },
    );
    const response = await extractPages(extractRequest(file));
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "INVALID_MODEL_OUTPUT");
    assert.doesNotMatch(JSON.stringify(body), /not-json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
