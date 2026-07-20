import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PDF_BYTES,
  type StrictFinalizeRequest,
} from "../lib/ai/contracts";
import { buildFinalAuditResult } from "../lib/audit-result";
import {
  chunkPageNumbers,
  runAuditPipeline,
  validatePdfFile,
} from "../lib/audit/pipeline";
import {
  type AuditStageGateway,
  type RenderedPdfDocument,
} from "../lib/audit/gateway";
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
  let releaseFirstProgress!: () => void;
  let observeFirstProgress!: () => void;
  const firstProgressGate = new Promise<void>((resolve) => {
    releaseFirstProgress = resolve;
  });
  const firstProgressObserved = new Promise<void>((resolve) => {
    observeFirstProgress = resolve;
  });
  let firstProgressPending = true;
  let destroyed = false;
  let finalBody: StrictFinalizeRequest | undefined;
  const controller = new AbortController();
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
  const gateway: AuditStageGateway = {
    async locate(metadata, images, signal) {
      assert.equal(signal, controller.signal);
      calls.push("locate");
      assert.deepEqual(metadata.pageNumbers, [1]);
      assert.equal(images.length, 1);
      return { model: "qwen3.7-plus", ...strictLayout, warnings: ["layout-warning"] };
    },
    async recognize(metadata, images, signal) {
      assert.equal(signal, controller.signal);
      calls.push("recognize");
      assert.equal(metadata.regions.length, 2);
      assert.equal(images.length, 2);
      return {
        model: "qwen3.7-plus",
        ...strictEvidence,
        warnings: ["evidence-warning"],
      };
    },
    async reviewUrls(metadata, images, signal) {
      assert.equal(signal, controller.signal);
      calls.push("reviewUrls");
      assert.equal(metadata.pairs.length, 1);
      assert.equal(images.length, 2);
      return {
        model: "qwen3.7-plus",
        ...strictUrlReview,
        warnings: ["url-warning"],
      };
    },
    async extractTable(metadata, images, signal) {
      assert.equal(signal, controller.signal);
      calls.push("extractTable");
      assert.equal(metadata.regions.length, 1);
      assert.equal(images.length, 1);
      return { model: "qwen3.7-plus", ...strictTable, warnings: ["table-warning"] };
    },
    async associate(input, signal) {
      assert.equal(signal, controller.signal);
      calls.push("associate");
      assert.deepEqual(Object.keys(input.screenshots[0]).sort(), [
        "id",
        "pageNumber",
        "readingOrder",
        "resultIndex",
        "rightsImageIndex",
      ]);
      return { model: "qwen3.7-plus", ...strictAssociation };
    },
    async finalize(input, signal) {
      assert.equal(signal, controller.signal);
      calls.push("finalize");
      finalBody = input;
      return buildFinalAuditResult(input);
    },
  };

  const resultPromise = runAuditPipeline({
    fileName: "example.pdf",
    fileSize: 16,
    fileType: "application/pdf",
    pdf: document,
    gateway,
    signal: controller.signal,
    async onProgress(progress) {
      progressStages.add(progress.stage);
      if (firstProgressPending) {
        firstProgressPending = false;
        observeFirstProgress();
        await firstProgressGate;
      }
    },
  });
  await firstProgressObserved;
  assert.deepEqual(calls, []);
  releaseFirstProgress();
  const result = await resultPromise;

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
  let finalBody: StrictFinalizeRequest | undefined;
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

  const gateway: AuditStageGateway = {
    async locate() {
      calls.push("locate");
      return { model: "qwen3.7-plus", ...layoutWithoutAddress };
    },
    async recognize(metadata) {
      calls.push("recognize");
      const screenshot = metadata.regions.find(
        (region) => region.type === "rights_screenshot",
      );
      assert.equal(screenshot?.addressBarRegionId, null);
      return { model: "qwen3.7-plus", ...evidenceWithoutAddress };
    },
    async reviewUrls() {
      calls.push("reviewUrls");
      throw new Error("URL review should be skipped");
    },
    async extractTable() {
      calls.push("extractTable");
      return { model: "qwen3.7-plus", ...strictTable };
    },
    async associate() {
      calls.push("associate");
      return { model: "qwen3.7-plus", ...strictAssociation };
    },
    async finalize(input) {
      calls.push("finalize");
      finalBody = input;
      return buildFinalAuditResult(input);
    },
  };

  const result = await runAuditPipeline({
    fileName: "example.pdf",
    fileSize: 16,
    fileType: "application/pdf",
    pdf: document,
    gateway,
  });

  assert.equal(calls.includes("reviewUrls"), false);
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
    runAuditPipeline({
      fileName: "example.pdf",
      fileSize: 16,
      fileType: "application/pdf",
      pdf: document,
      gateway: {} as AuditStageGateway,
    }),
    /80 页/,
  );
  assert.equal(destroyed, true);
});

test("destroys an already-supplied PDF when file metadata is invalid", async () => {
  const invalidFiles = [
    { fileName: "notes.txt", fileSize: 16, fileType: "text/plain" },
    { fileName: "empty.pdf", fileSize: 0, fileType: "application/pdf" },
    {
      fileName: "oversized.pdf",
      fileSize: MAX_PDF_BYTES + 1,
      fileType: "application/pdf",
    },
  ];

  for (const metadata of invalidFiles) {
    let destroyCount = 0;
    const document: RenderedPdfDocument = {
      pageCount: 1,
      async renderPage() {
        throw new Error("should not render");
      },
      async renderRegion() {
        throw new Error("should not render");
      },
      async destroy() {
        destroyCount += 1;
      },
    };

    await assert.rejects(
      runAuditPipeline({
        ...metadata,
        pdf: document,
        gateway: {} as AuditStageGateway,
      }),
    );
    assert.equal(destroyCount, 1, metadata.fileName);
  }
});
