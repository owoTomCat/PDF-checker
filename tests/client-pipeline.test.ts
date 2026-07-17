import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PDF_BYTES } from "../lib/ai/contracts";
import {
  chunkPageNumbers,
  runAiAuditPipeline,
  validatePdfFile,
  type RenderedPdfDocument,
} from "../lib/client/audit-pipeline";

function makePdfFile(size = 16) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7"));
  return new File([bytes], "example.pdf", { type: "application/pdf" });
}

function pageExtraction(pageNumber: number) {
  return {
    pageNumber,
    pageType: pageNumber === 1 ? ("cover" as const) : ("other" as const),
    firstPageTable:
      pageNumber === 1
        ? {
            caseNumber: "示例案号",
            feedbackDate: "2026-07-13",
            rightsHolderName: "示例权利人",
            workType: "摄影作品",
          }
        : null,
    certificate: null,
    resultTables: [],
    screenshots: [],
    warnings: [],
    confidence: 0.95,
  };
}

function needsReviewResponse(pageCount: number) {
  return {
    model: "qwen3.7-plus",
    outcome: "needs_review",
    input: {
      firstPageTable: {
        caseNumber: "示例案号",
        feedbackDate: "2026-07-13",
        rightsHolderName: "示例权利人",
        workType: "摄影作品",
      },
      certificate: null,
      groups: [],
    },
    report: { certificateIssues: [], resultIssues: [], issues: [] },
    reportText: "识别结果不完整，需人工复核。",
    summary: {
      parserMode: "qwen3.7-plus 视觉识别 + 跨页归并 + 规则复核",
      pageCount,
      firstPageFields: 4,
      groupCount: 0,
      tableRowCount: 0,
      screenshotHeadingCount: 0,
      warnings: ["未识别到结果表格"],
      confidence: 0.6,
      extractionComplete: false,
    },
  };
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

test("renders and uploads only page images in six-page batches", async () => {
  const renderedPages: number[] = [];
  let destroyed = false;
  const document: RenderedPdfDocument = {
    pageCount: 7,
    async renderPage(pageNumber) {
      renderedPages.push(pageNumber);
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xdb])], {
        type: "image/jpeg",
      });
    },
    async renderRegion() {
      throw new Error("legacy pipeline should not render regions");
    },
    async destroy() {
      destroyed = true;
    },
  };
  const batchSizes: number[] = [];
  const stages: string[] = [];
  let finalPageCount = 0;
  let finalPagesLength = 0;

  const result = await runAiAuditPipeline(makePdfFile(), {
    openPdf: async () => document,
    onProgress(progress) {
      stages.push(progress.stage);
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/extract")) {
        assert.equal(init?.body instanceof FormData, true);
        const form = init?.body as FormData;
        const images = form.getAll("pages");
        const pageNumbers = JSON.parse(String(form.get("pageNumbers"))) as number[];
        batchSizes.push(images.length);
        assert.equal(
          images.every(
            (value) => value instanceof File && value.type === "image/jpeg",
          ),
          true,
        );
        assert.equal(
          images.some(
            (value) => value instanceof File && value.type === "application/pdf",
          ),
          false,
        );
        return Response.json({
          model: "qwen3.7-plus",
          pages: pageNumbers.map(pageExtraction),
          warnings: [],
        });
      }

      const body = JSON.parse(String(init?.body));
      finalPageCount = body.pageCount;
      finalPagesLength = body.pages.length;
      return Response.json(needsReviewResponse(body.pageCount));
    },
  });

  assert.deepEqual(renderedPages, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(batchSizes, [6, 1]);
  assert.equal(finalPageCount, 7);
  assert.equal(finalPagesLength, 7);
  assert.equal(stages.includes("rendering"), true);
  assert.equal(stages.includes("extracting"), true);
  assert.equal(stages.includes("finalizing"), true);
  assert.equal(result.outcome, "needs_review");
  assert.equal(destroyed, true);
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
