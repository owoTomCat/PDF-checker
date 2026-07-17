import assert from "node:assert/strict";
import test from "node:test";
import { POST as associateRows } from "../app/api/audit/associate/route";
import { POST as extractTable } from "../app/api/audit/extract-table/route";
import { POST as finalizeAudit } from "../app/api/audit/finalize/route";
import { POST as locateRegions } from "../app/api/audit/layout/route";
import { POST as recognizeEvidence } from "../app/api/audit/recognize-evidence/route";
import { POST as reviewUrls } from "../app/api/audit/review-url/route";
import {
  strictAssociation,
  strictEvidence,
  strictFinalizeRequest,
  strictLayout,
  strictTable,
  strictUrlReview,
} from "./strict-fixtures";

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

function jpeg(name = "image.jpg") {
  return new File(
    [new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00])],
    name,
    { type: "image/jpeg" },
  );
}

function png(name = "image.png") {
  return new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    name,
    { type: "image/png" },
  );
}

function multipartRequest(path: string, metadata: unknown, files: File[]) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  files.forEach((file) => form.append("images", file));
  return new Request(`https://audit.example.com${path}`, {
    method: "POST",
    headers: { origin: "https://audit.example.com" },
    body: form,
  });
}

test("layout API accepts a bounded page image and returns geometry only", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = "";
  globalThis.fetch = async (_url, init) => {
    upstreamBody = String(init?.body);
    return modelResponse(strictLayout);
  };

  try {
    const response = await locateRegions(
      multipartRequest(
        "/api/audit/layout",
        { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
        [jpeg("page-1.jpg")],
      ),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.model, "qwen3.7-plus");
    assert.equal(body.pages[0].regions[0].regionId, "certificate-1");
    assert.match(upstreamBody, /data:image\/jpeg;base64/);
    assert.doesNotMatch(upstreamBody, /application\/pdf/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("layout API rejects a spoofed image before calling the model", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return modelResponse(strictLayout);
  };

  try {
    const response = await locateRegions(
      multipartRequest(
        "/api/audit/layout",
        { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
        [new File(["not-jpeg"], "page-1.jpg", { type: "image/jpeg" })],
      ),
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "INVALID_IMAGE");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evidence and table APIs reject metadata from the other stage", async () => {
  const evidenceResponse = await recognizeEvidence(
    multipartRequest(
      "/api/audit/recognize-evidence",
      {
        fileName: "example.pdf",
        totalPages: 1,
        regions: [
          {
            regionId: "screenshot-1",
            type: "rights_screenshot",
            pageNumber: 1,
            rightsImageIndex: 1,
            resultIndex: 1,
            addressBarRegionId: "address-1",
            readingOrder: 1,
            tableRowId: "forbidden",
          },
        ],
      },
      [jpeg()],
    ),
  );
  const tableResponse = await extractTable(
    multipartRequest(
      "/api/audit/extract-table",
      {
        fileName: "example.pdf",
        totalPages: 1,
        regions: [
          {
            regionId: "table-1",
            pageNumber: 1,
            readingOrder: 1,
            screenshotId: "forbidden",
          },
        ],
      },
      [jpeg()],
    ),
  );

  assert.equal(evidenceResponse.status, 422);
  assert.equal(tableResponse.status, 422);
});

test("URL review rejects an incomplete color and grayscale pair", async () => {
  const response = await reviewUrls(
    multipartRequest(
      "/api/audit/review-url",
      {
        fileName: "example.pdf",
        totalPages: 1,
        pairs: [
          {
            screenshotId: "screenshot-1",
            pageNumber: 1,
            addressBarRegionId: "address-1",
          },
        ],
      },
      [png("color.png")],
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.error.code, "INVALID_INPUT");
});

test("evidence API accepts a screenshot when layout found no address bar", async () => {
  const originalFetch = globalThis.fetch;
  const evidenceWithoutAddress = {
    ...strictEvidence,
    certificates: [],
    screenshots: strictEvidence.screenshots.map((screenshot) => ({
      ...screenshot,
      addressBarRegionId: null,
    })),
  };
  globalThis.fetch = async () => modelResponse(evidenceWithoutAddress);

  try {
    const response = await recognizeEvidence(
      multipartRequest(
        "/api/audit/recognize-evidence",
        {
          fileName: "example.pdf",
          totalPages: 1,
          regions: [
            {
              regionId: "screenshot-1",
              type: "rights_screenshot",
              pageNumber: 1,
              rightsImageIndex: 1,
              resultIndex: 1,
              addressBarRegionId: null,
              readingOrder: 1,
            },
          ],
        },
        [jpeg()],
      ),
    );
    const body = await response.json();

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.screenshots[0].addressBarRegionId, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all isolated image APIs return their validated stage output", async () => {
  const originalFetch = globalThis.fetch;
  const outputs = [
    { ...strictEvidence, certificates: [] },
    strictUrlReview,
    strictTable,
  ];
  let outputIndex = 0;
  globalThis.fetch = async () => modelResponse(outputs[outputIndex++]);

  try {
    const evidenceResponse = await recognizeEvidence(
      multipartRequest(
        "/api/audit/recognize-evidence",
        {
          fileName: "example.pdf",
          totalPages: 1,
          regions: [
            {
              regionId: "screenshot-1",
              type: "rights_screenshot",
              pageNumber: 1,
              rightsImageIndex: 1,
              resultIndex: 1,
              addressBarRegionId: "address-1",
              readingOrder: 1,
            },
          ],
        },
        [jpeg()],
      ),
    );
    const reviewResponse = await reviewUrls(
      multipartRequest(
        "/api/audit/review-url",
        {
          fileName: "example.pdf",
          totalPages: 1,
          pairs: [
            {
              screenshotId: "screenshot-1",
              pageNumber: 1,
              addressBarRegionId: "address-1",
            },
          ],
        },
        [png("color.png"), png("grayscale.png")],
      ),
    );
    const tableResponse = await extractTable(
      multipartRequest(
        "/api/audit/extract-table",
        {
          fileName: "example.pdf",
          totalPages: 1,
          regions: [
            { regionId: "table-1", pageNumber: 1, readingOrder: 1 },
          ],
        },
        [jpeg()],
      ),
    );

    const evidenceBody = await evidenceResponse.json();
    const reviewBody = await reviewResponse.json();
    const tableBody = await tableResponse.json();
    assert.equal(evidenceResponse.status, 200, JSON.stringify(evidenceBody));
    assert.equal(reviewResponse.status, 200, JSON.stringify(reviewBody));
    assert.equal(tableResponse.status, 200, JSON.stringify(tableBody));
    assert.equal(evidenceBody.screenshots.length, 1);
    assert.equal(reviewBody.reviews.length, 1);
    assert.equal(tableBody.rows.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("association API rejects business fields before calling the model", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return modelResponse(strictAssociation);
  };

  try {
    const response = await associateRows(
      new Request("https://audit.example.com/api/audit/associate", {
        method: "POST",
        headers: {
          origin: "https://audit.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          screenshots: [
            {
              id: "screenshot-1",
              pageNumber: 1,
              rightsImageIndex: 1,
              resultIndex: 1,
              readingOrder: 1,
              url: "https://example.com/forbidden",
            },
          ],
          tableRows: [],
        }),
      }),
    );

    assert.equal(response.status, 422);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("association API returns validated ID-only mappings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => modelResponse(strictAssociation);

  try {
    const response = await associateRows(
      new Request("https://audit.example.com/api/audit/associate", {
        method: "POST",
        headers: {
          origin: "https://audit.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          screenshots: [
            {
              id: "screenshot-1",
              pageNumber: 1,
              rightsImageIndex: 1,
              resultIndex: 1,
              readingOrder: 1,
            },
          ],
          tableRows: [
            {
              id: "table-row-1",
              pageNumber: 1,
              rightsImageIndex: 1,
              resultIndex: 1,
              readingOrder: 1,
            },
          ],
        }),
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.associations[0].tableRowId, "table-row-1");
    assert.equal("url" in body.associations[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("layout API maps malformed model output to a stable generic error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ message: { content: "not-json" } }] });

  try {
    const response = await locateRegions(
      multipartRequest(
        "/api/audit/layout",
        { fileName: "example.pdf", totalPages: 1, pageNumbers: [1] },
        [jpeg()],
      ),
    );
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "INVALID_MODEL_OUTPUT");
    assert.doesNotMatch(JSON.stringify(body), /not-json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("layout API rejects an oversized declared body before multipart parsing", async () => {
  const response = await locateRegions(
    new Request("https://audit.example.com/api/audit/layout", {
      method: "POST",
      headers: {
        origin: "https://audit.example.com",
        "content-length": String(27 * 1024 * 1024),
        "content-type": "text/plain",
      },
      body: "oversized-body-placeholder",
    }),
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "BATCH_TOO_LARGE");
});

test("finalize API is deterministic and does not call the model", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("finalize must not call fetch");
  };

  try {
    const response = await finalizeAudit(
      new Request("https://audit.example.com/api/audit/finalize", {
        method: "POST",
        headers: {
          origin: "https://audit.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify(strictFinalizeRequest),
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.outcome, "passed");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy finalize API still rejects an oversized declared body during migration", async () => {
  const response = await finalizeAudit(
    new Request("https://audit.example.com/api/audit/finalize", {
      method: "POST",
      headers: {
        origin: "https://audit.example.com",
        "content-length": String(3 * 1024 * 1024),
        "content-type": "text/plain",
      },
      body: "oversized-body-placeholder",
    }),
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "BODY_TOO_LARGE");
});
