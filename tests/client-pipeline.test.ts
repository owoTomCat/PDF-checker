import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PDF_BYTES } from "../lib/ai/contracts";
import { buildFinalAuditResult } from "../lib/audit-result";
import {
  chunkPageNumbers,
  runAiAuditPipeline,
  validatePdfFile,
  type RenderedPdfDocument,
} from "../lib/client/audit-pipeline";
import {
  strictAssociation,
  strictEvidence,
  strictLayout,
  strictTable,
  strictUrlReview,
} from "./strict-fixtures";

function makePdfFile(size = 16) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7"));
  return new File([bytes], "example.pdf", { type: "application/pdf" });
}

function jpeg() {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb])], {
    type: "image/jpeg",
  });
}

function png() {
  return new Blob(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    { type: "image/png" },
  );
}

function responseForStage(stage: string) {
  switch (stage) {
    case "/api/audit/layout":
      return { model: "qwen3.7-plus", ...strictLayout, warnings: ["layout-warning"] };
    case "/api/audit/recognize-evidence":
      return {
        model: "qwen3.7-plus",
        ...strictEvidence,
        warnings: ["evidence-warning"],
      };
    case "/api/audit/review-url":
      return {
        model: "qwen3.7-plus",
        ...strictUrlReview,
        warnings: ["url-warning"],
      };
    case "/api/audit/extract-table":
      return { model: "qwen3.7-plus", ...strictTable, warnings: ["table-warning"] };
    case "/api/audit/associate":
      return { model: "qwen3.7-plus", ...strictAssociation };
    default:
      throw new Error(`unexpected stage: ${stage}`);
  }
}

function regionTypeForBounds(bounds: { x: number; y: number; width: number; height: number }) {
  return strictLayout.pages[0].regions.find(
    (region) => JSON.stringify(region.bounds) === JSON.stringify(bounds),
  )?.type;
}

test("chunks pages into batches of at most six", () => {
  assert.deepEqual(chunkPageNumbers(13), [
    [1, 2, 3, 4, 5, 6],
    [7, 8, 9, 10, 11, 12],
    [13],
  ]);
});

test("rejects non-PDF and oversized files before rendering", () => {
  assert.throws(
    () => validatePdfFile(new File(["x"], "notes.txt", { type: "text/plain" })),
    /仅支持 PDF/,
  );
  assert.throws(
    () => validatePdfFile(makePdfFile(MAX_PDF_BYTES + 1)),
    /20 MiB/,
  );
});

test("orchestrates isolated stages in strict order and aggregates warnings", async () => {
  const calls: string[] = [];
  const progressStages = new Set<string>();
  let destroyed = false;
  let finalBody: Record<string, unknown> | undefined;
  const document: RenderedPdfDocument = {
    pageCount: 1,
    async renderPage(pageNumber) {
      calls.push(`render:${pageNumber}`);
      return jpeg();
    },
    async renderRegion(pageNumber, bounds, options) {
      const type = regionTypeForBounds(bounds);
      if (!type) throw new Error("unknown crop bounds");
      if (type === "address_bar") {
        assert.equal(options.dpi, 600);
        assert.equal(options.mimeType, "image/png");
        calls.push(`crop:${type}:${options.variant}:${options.dpi}`);
        return png();
      }
      assert.equal(options.dpi, 200);
      assert.equal(options.variant, "color");
      calls.push(`crop:${type}:${pageNumber}`);
      return jpeg();
    },
    async destroy() {
      destroyed = true;
    },
  };

  const result = await runAiAuditPipeline(makePdfFile(), {
    openPdf: async () => document,
    onProgress(progress) {
      progressStages.add(progress.stage);
    },
    fetchImpl: async (url, init) => {
      const stage = String(url);
      calls.push(stage);
      if (init?.body instanceof FormData) {
        const files = init.body.getAll("images");
        assert.equal(files.length > 0, true);
        assert.equal(
          files.some(
            (value) => value instanceof File && value.type === "application/pdf",
          ),
          false,
        );
      }
      if (stage === "/api/audit/associate") {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(Object.keys(body.screenshots[0]).sort(), [
          "id",
          "pageNumber",
          "readingOrder",
          "resultIndex",
          "rightsImageIndex",
        ]);
      }
      if (stage === "/api/audit/finalize") {
        finalBody = JSON.parse(String(init?.body));
        return Response.json(buildFinalAuditResult(finalBody as never));
      }
      return Response.json(responseForStage(stage));
    },
  });

  assert.deepEqual(calls, [
    "render:1",
    "/api/audit/layout",
    "crop:certificate:1",
    "crop:rights_screenshot:1",
    "/api/audit/recognize-evidence",
    "crop:address_bar:color:600",
    "crop:address_bar:grayscale-contrast:600",
    "/api/audit/review-url",
    "crop:summary_table:1",
    "/api/audit/extract-table",
    "/api/audit/associate",
    "/api/audit/finalize",
  ]);
  assert.deepEqual(finalBody?.warnings, [
    "layout-warning",
    "evidence-warning",
    "url-warning",
    "table-warning",
  ]);
  assert.deepEqual(finalBody?.stageFailures, []);
  assert.deepEqual(
    [...progressStages],
    [
      "rendering",
      "locating",
      "recognizing",
      "reviewing_urls",
      "extracting_table",
      "associating",
      "finalizing",
    ],
  );
  assert.equal(result.model, "qwen3.7-plus");
  assert.equal(destroyed, true);
});

test("records a missing address bar without substituting the table URL", async () => {
  const calls: string[] = [];
  let finalBody: Record<string, any> | undefined;
  const layoutWithoutAddress = {
    ...strictLayout,
    pages: [
      {
        ...strictLayout.pages[0],
        regions: strictLayout.pages[0].regions.filter(
          (region) => region.type !== "address_bar",
        ),
      },
    ],
  };
  const evidenceWithoutAddress = {
    ...strictEvidence,
    screenshots: strictEvidence.screenshots.map((screenshot) => ({
      ...screenshot,
      addressBarRegionId: null,
      initialUrl: {
        ...screenshot.initialUrl,
        rawText: null,
        status: "unrecognized" as const,
      },
    })),
  };
  const document: RenderedPdfDocument = {
    pageCount: 1,
    async renderPage() {
      calls.push("render");
      return jpeg();
    },
    async renderRegion(_pageNumber, bounds) {
      const type = layoutWithoutAddress.pages[0].regions.find(
        (region) => JSON.stringify(region.bounds) === JSON.stringify(bounds),
      )?.type;
      calls.push(`crop:${type}`);
      return jpeg();
    },
    async destroy() {},
  };

  const result = await runAiAuditPipeline(makePdfFile(), {
    openPdf: async () => document,
    fetchImpl: async (url, init) => {
      const stage = String(url);
      calls.push(stage);
      if (stage === "/api/audit/layout") {
        return Response.json({ model: "qwen3.7-plus", ...layoutWithoutAddress });
      }
      if (stage === "/api/audit/recognize-evidence") {
        const metadata = JSON.parse(
          String((init?.body as FormData).get("metadata")),
        );
        const screenshot = metadata.regions.find(
          (region: { type: string }) => region.type === "rights_screenshot",
        );
        assert.equal(screenshot.addressBarRegionId, null);
        return Response.json({ model: "qwen3.7-plus", ...evidenceWithoutAddress });
      }
      if (stage === "/api/audit/extract-table") {
        return Response.json({ model: "qwen3.7-plus", ...strictTable });
      }
      if (stage === "/api/audit/associate") {
        return Response.json({ model: "qwen3.7-plus", ...strictAssociation });
      }
      if (stage === "/api/audit/finalize") {
        finalBody = JSON.parse(String(init?.body));
        return Response.json(buildFinalAuditResult(finalBody as never));
      }
      throw new Error(`unexpected stage: ${stage}`);
    },
  });

  assert.equal(calls.includes("/api/audit/review-url"), false);
  assert.deepEqual(finalBody?.urlReviews.reviews, []);
  assert.equal(finalBody?.stageFailures.length, 1);
  assert.equal(finalBody?.stageFailures[0].code, "ADDRESS_BAR_MISSING");
  assert.equal(finalBody?.stageFailures[0].regionId, "screenshot-1");
  assert.equal(result.outcome, "needs_review");
});

test("destroys the PDF document when its page count exceeds the limit", async () => {
  let destroyed = false;
  const document: RenderedPdfDocument = {
    pageCount: 81,
    async renderPage() {
      throw new Error("should not render");
    },
    async renderRegion() {
      throw new Error("should not render");
    },
    async destroy() {
      destroyed = true;
    },
  };

  await assert.rejects(
    runAiAuditPipeline(makePdfFile(), {
      openPdf: async () => document,
      fetchImpl: async () => Response.json({}),
    }),
    /80 页/,
  );
  assert.equal(destroyed, true);
});
