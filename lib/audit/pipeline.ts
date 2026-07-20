import {
  MAX_BATCH_IMAGE_BYTES,
  MAX_BATCH_PAGES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  StrictFinalizeRequestSchema,
  type LayoutRegion,
  type StrictFinalAuditResponse,
  type StrictFinalizeRequest,
} from "../ai/contracts";
import type {
  AuditStageGateway,
  RenderedImage,
  RenderedPdfDocument,
} from "./gateway";

export type PipelineStage =
  | "rendering"
  | "locating"
  | "recognizing"
  | "reviewing_urls"
  | "extracting_table"
  | "associating"
  | "finalizing";

export type PipelineProgress = {
  stage: PipelineStage;
  progress: number;
  processedPages: number;
  totalPages: number;
  batchIndex: number;
  batchCount: number;
};

const EVIDENCE_DPI = 200;
export const URL_REVIEW_DPI = 600;
const URL_REVIEW_BATCH_PAIRS = 4;

export function validatePdfFile(file: {
  name: string;
  size: number;
  type: string | null;
}) {
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) throw new Error("仅支持 PDF 文件。");
  if (file.size === 0) throw new Error("PDF 文件为空。");
  if (file.size > MAX_PDF_BYTES) {
    throw new Error("PDF 文件超过 20 MiB 限制。");
  }
}

export function chunkPageNumbers(pageCount: number) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new Error(`PDF 页数必须在 1 至 ${MAX_PDF_PAGES} 页之间。`);
  }
  const batches: number[][] = [];
  for (let start = 1; start <= pageCount; start += MAX_BATCH_PAGES) {
    batches.push(
      Array.from(
        { length: Math.min(MAX_BATCH_PAGES, pageCount - start + 1) },
        (_, index) => start + index,
      ),
    );
  }
  return batches;
}

function chunkItems<T>(items: T[], maxCount: number) {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += maxCount) {
    batches.push(items.slice(start, start + maxCount));
  }
  return batches;
}

function splitRenderedByBytes<T extends { images: RenderedImage[] }>(
  items: T[],
  maxCount: number,
) {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = item.images.reduce((sum, image) => sum + image.blob.size, 0);
    if (itemBytes > MAX_BATCH_IMAGE_BYTES) {
      throw new Error("单项复核素材超过 24 MiB 批次限制。");
    }
    if (
      current.length > 0 &&
      (current.length >= maxCount || currentBytes + itemBytes > MAX_BATCH_IMAGE_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function emitProgress(
  callback: ((progress: PipelineProgress) => void | Promise<void>) | undefined,
  progress: PipelineProgress,
) {
  await callback?.(progress);
}

function uniqueWarnings(warnings: string[]) {
  return [...new Set(warnings.filter(Boolean))];
}

function compareRegions(left: LayoutRegion, right: LayoutRegion) {
  return (
    left.pageNumber - right.pageNumber ||
    left.readingOrder - right.readingOrder ||
    left.regionId.localeCompare(right.regionId)
  );
}

function makeStageFailure(
  code: string,
  screenshot: { pageNumber: number; regionId: string },
  message: string,
): StrictFinalizeRequest["stageFailures"][number] {
  return {
    stage: "url_review",
    code,
    pageNumber: screenshot.pageNumber,
    regionId: screenshot.regionId,
    message,
  };
}

export async function runAuditPipeline(options: {
  fileName: string;
  fileSize: number;
  fileType: string | null;
  pdf: RenderedPdfDocument;
  gateway: AuditStageGateway;
  onProgress?: (progress: PipelineProgress) => void | Promise<void>;
}): Promise<StrictFinalAuditResponse> {
  const { gateway, pdf } = options;

  try {
    validatePdfFile({
      name: options.fileName,
      size: options.fileSize,
      type: options.fileType,
    });
    if (pdf.pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页限制。`);
    }

    const layoutPages: StrictFinalizeRequest["layout"]["pages"] = [];
    const layoutWarnings: string[] = [];
    const stageFailures: StrictFinalizeRequest["stageFailures"] = [];
    const pageBatches = chunkPageNumbers(pdf.pageCount);
    let renderedPageCount = 0;

    for (let batchIndex = 0; batchIndex < pageBatches.length; batchIndex += 1) {
      const rendered = [] as Array<{
        pageNumber: number;
        images: RenderedImage[];
      }>;
      for (const pageNumber of pageBatches[batchIndex]) {
        await emitProgress(options.onProgress, {
          stage: "rendering",
          progress: Math.round(2 + (renderedPageCount / pdf.pageCount) * 13),
          processedPages: renderedPageCount,
          totalPages: pdf.pageCount,
          batchIndex: batchIndex + 1,
          batchCount: pageBatches.length,
        });
        rendered.push({
          pageNumber,
          images: [
            {
              blob: await pdf.renderPage(pageNumber),
              fileName: `page-${pageNumber}.jpg`,
            },
          ],
        });
        renderedPageCount += 1;
      }

      for (const imageBatch of splitRenderedByBytes(rendered, MAX_BATCH_PAGES)) {
        const pageNumbers = imageBatch.map((item) => item.pageNumber);
        await emitProgress(options.onProgress, {
          stage: "locating",
          progress: Math.round(15 + (renderedPageCount / pdf.pageCount) * 10),
          processedPages: renderedPageCount,
          totalPages: pdf.pageCount,
          batchIndex: batchIndex + 1,
          batchCount: pageBatches.length,
        });
        const output = await gateway.locate(
          { fileName: options.fileName, totalPages: pdf.pageCount, pageNumbers },
          imageBatch.flatMap((item) => item.images),
        );
        const returnedPages = new Set(output.pages.map((page) => page.pageNumber));
        if (
          returnedPages.size !== pageNumbers.length ||
          pageNumbers.some((pageNumber) => !returnedPages.has(pageNumber))
        ) {
          throw new Error("页面区域定位结果缺少页面，请重新处理。");
        }
        layoutPages.push(...output.pages);
        layoutWarnings.push(...output.warnings);
      }
    }

    layoutPages.sort((left, right) => left.pageNumber - right.pageNumber);
    const allRegions = layoutPages.flatMap((page) => page.regions).sort(compareRegions);
    const regionById = new Map<string, LayoutRegion>();
    for (const region of allRegions) {
      if (regionById.has(region.regionId)) {
        throw new Error("页面区域定位结果包含重复区域 ID，请重新处理。");
      }
      regionById.set(region.regionId, region);
    }

    const addressBarsByParent = new Map<string, LayoutRegion[]>();
    for (const region of allRegions) {
      if (region.type === "address_bar" && region.parentRegionId) {
        const siblings = addressBarsByParent.get(region.parentRegionId) ?? [];
        siblings.push(region);
        addressBarsByParent.set(region.parentRegionId, siblings);
      }
    }
    const selectedAddressBar = new Map<string, LayoutRegion | null>();
    for (const screenshot of allRegions.filter(
      (region) => region.type === "rights_screenshot",
    )) {
      const candidates = (addressBarsByParent.get(screenshot.regionId) ?? []).sort(
        compareRegions,
      );
      selectedAddressBar.set(screenshot.regionId, candidates[0] ?? null);
      if (candidates.length > 1) {
        stageFailures.push(
          makeStageFailure(
            "ADDRESS_BAR_AMBIGUOUS",
            screenshot,
            "同一网页截图定位到多个地址栏区域，已使用阅读顺序最前的区域复核，仍需人工确认。",
          ),
        );
      }
    }

    const evidenceCertificates: StrictFinalizeRequest["evidence"]["certificates"] = [];
    const evidenceScreenshots: StrictFinalizeRequest["evidence"]["screenshots"] = [];
    const evidenceWarnings: string[] = [];
    const evidenceRegions = allRegions.filter(
      (region) =>
        region.type === "certificate" || region.type === "rights_screenshot",
    );
    const evidenceBatches = chunkItems(evidenceRegions, MAX_BATCH_PAGES);
    if (evidenceBatches.length === 0) {
      await emitProgress(options.onProgress, {
        stage: "recognizing",
        progress: 35,
        processedPages: pdf.pageCount,
        totalPages: pdf.pageCount,
        batchIndex: 0,
        batchCount: 0,
      });
    }

    for (let batchIndex = 0; batchIndex < evidenceBatches.length; batchIndex += 1) {
      const rendered: Array<{ region: LayoutRegion; images: RenderedImage[] }> = [];
      for (const region of evidenceBatches[batchIndex]) {
        rendered.push({
          region,
          images: [
            {
              blob: await pdf.renderRegion(region.pageNumber, region.bounds, {
                dpi: EVIDENCE_DPI,
                variant: "color",
                mimeType: "image/jpeg",
              }),
              fileName: `${region.regionId}.jpg`,
            },
          ],
        });
      }
      for (const imageBatch of splitRenderedByBytes(rendered, MAX_BATCH_PAGES)) {
        const regions = imageBatch.map(({ region }) => ({
          regionId: region.regionId,
          type: region.type as "certificate" | "rights_screenshot",
          pageNumber: region.pageNumber,
          rightsImageIndex: region.rightsImageIndex,
          resultIndex: region.resultIndex,
          addressBarRegionId:
            region.type === "rights_screenshot"
              ? (selectedAddressBar.get(region.regionId)?.regionId ?? null)
              : null,
          readingOrder: region.readingOrder,
        }));
        await emitProgress(options.onProgress, {
          stage: "recognizing",
          progress: Math.round(27 + ((batchIndex + 1) / evidenceBatches.length) * 15),
          processedPages: pdf.pageCount,
          totalPages: pdf.pageCount,
          batchIndex: batchIndex + 1,
          batchCount: evidenceBatches.length,
        });
        const output = await gateway.recognize(
          { fileName: options.fileName, totalPages: pdf.pageCount, regions },
          imageBatch.flatMap((item) => item.images),
        );
        evidenceCertificates.push(...output.certificates);
        evidenceScreenshots.push(...output.screenshots);
        evidenceWarnings.push(...output.warnings);
      }
    }

    const urlReviews: StrictFinalizeRequest["urlReviews"]["reviews"] = [];
    const urlWarnings: string[] = [];
    const reviewableScreenshots: Array<{
      screenshot: (typeof evidenceScreenshots)[number];
      addressBar: LayoutRegion;
    }> = [];
    for (const screenshot of evidenceScreenshots) {
      const addressBar = screenshot.addressBarRegionId
        ? regionById.get(screenshot.addressBarRegionId)
        : undefined;
      if (
        !addressBar ||
        addressBar.type !== "address_bar" ||
        addressBar.parentRegionId !== screenshot.regionId
      ) {
        stageFailures.push(
          makeStageFailure(
            "ADDRESS_BAR_MISSING",
            screenshot,
            "网页截图未定位到可独立复核的地址栏，发布网址未完整识别，需人工复核。",
          ),
        );
        continue;
      }
      reviewableScreenshots.push({ screenshot, addressBar });
    }

    const urlBatches = chunkItems(reviewableScreenshots, URL_REVIEW_BATCH_PAIRS);
    if (urlBatches.length === 0) {
      await emitProgress(options.onProgress, {
        stage: "reviewing_urls",
        progress: 52,
        processedPages: pdf.pageCount,
        totalPages: pdf.pageCount,
        batchIndex: 0,
        batchCount: 0,
      });
    }
    for (let batchIndex = 0; batchIndex < urlBatches.length; batchIndex += 1) {
      const rendered: Array<{
        screenshot: (typeof evidenceScreenshots)[number];
        addressBar: LayoutRegion;
        images: RenderedImage[];
      }> = [];
      for (const { screenshot, addressBar } of urlBatches[batchIndex]) {
        const color = await pdf.renderRegion(
          addressBar.pageNumber,
          addressBar.bounds,
          {
            dpi: URL_REVIEW_DPI,
            variant: "color",
            mimeType: "image/png",
          },
        );
        const grayscale = await pdf.renderRegion(
          addressBar.pageNumber,
          addressBar.bounds,
          {
            dpi: URL_REVIEW_DPI,
            variant: "grayscale-contrast",
            mimeType: "image/png",
          },
        );
        rendered.push({
          screenshot,
          addressBar,
          images: [
            {
              blob: color,
              fileName: `${screenshot.screenshotId}-color.png`,
            },
            {
              blob: grayscale,
              fileName: `${screenshot.screenshotId}-grayscale.png`,
            },
          ],
        });
      }
      for (const imageBatch of splitRenderedByBytes(
        rendered,
        URL_REVIEW_BATCH_PAIRS,
      )) {
        const pairs = imageBatch.map(({ screenshot, addressBar }) => ({
          screenshotId: screenshot.screenshotId,
          pageNumber: screenshot.pageNumber,
          addressBarRegionId: addressBar.regionId,
        }));
        await emitProgress(options.onProgress, {
          stage: "reviewing_urls",
          progress: Math.round(43 + ((batchIndex + 1) / urlBatches.length) * 15),
          processedPages: pdf.pageCount,
          totalPages: pdf.pageCount,
          batchIndex: batchIndex + 1,
          batchCount: urlBatches.length,
        });
        const output = await gateway.reviewUrls(
          { fileName: options.fileName, totalPages: pdf.pageCount, pairs },
          imageBatch.flatMap((item) => item.images),
        );
        urlReviews.push(...output.reviews);
        urlWarnings.push(...output.warnings);
      }
    }

    const tableHeaders: StrictFinalizeRequest["table"]["headers"] = [];
    const tableRows: StrictFinalizeRequest["table"]["rows"] = [];
    const tableWarnings: string[] = [];
    const tableRegions = allRegions.filter(
      (region) => region.type === "summary_table",
    );
    const tableBatches = chunkItems(tableRegions, MAX_BATCH_PAGES);
    if (tableBatches.length === 0) {
      await emitProgress(options.onProgress, {
        stage: "extracting_table",
        progress: 70,
        processedPages: pdf.pageCount,
        totalPages: pdf.pageCount,
        batchIndex: 0,
        batchCount: 0,
      });
    }
    for (let batchIndex = 0; batchIndex < tableBatches.length; batchIndex += 1) {
      const rendered: Array<{ region: LayoutRegion; images: RenderedImage[] }> = [];
      for (const region of tableBatches[batchIndex]) {
        rendered.push({
          region,
          images: [
            {
              blob: await pdf.renderRegion(region.pageNumber, region.bounds, {
                dpi: EVIDENCE_DPI,
                variant: "color",
                mimeType: "image/jpeg",
              }),
              fileName: `${region.regionId}.jpg`,
            },
          ],
        });
      }
      for (const imageBatch of splitRenderedByBytes(rendered, MAX_BATCH_PAGES)) {
        const regions = imageBatch.map(({ region }) => ({
          regionId: region.regionId,
          pageNumber: region.pageNumber,
          readingOrder: region.readingOrder,
        }));
        await emitProgress(options.onProgress, {
          stage: "extracting_table",
          progress: Math.round(59 + ((batchIndex + 1) / tableBatches.length) * 15),
          processedPages: pdf.pageCount,
          totalPages: pdf.pageCount,
          batchIndex: batchIndex + 1,
          batchCount: tableBatches.length,
        });
        const output = await gateway.extractTable(
          { fileName: options.fileName, totalPages: pdf.pageCount, regions },
          imageBatch.flatMap((item) => item.images),
        );
        tableHeaders.push(...output.headers);
        tableRows.push(...output.rows);
        tableWarnings.push(...output.warnings);
      }
    }

    await emitProgress(options.onProgress, {
      stage: "associating",
      progress: 82,
      processedPages: pdf.pageCount,
      totalPages: pdf.pageCount,
      batchIndex: 1,
      batchCount: 1,
    });
    const screenshotLocators = evidenceScreenshots.map((screenshot) => ({
      id: screenshot.screenshotId,
      pageNumber: screenshot.pageNumber,
      rightsImageIndex: screenshot.rightsImageIndex,
      resultIndex: screenshot.resultIndex,
      readingOrder: regionById.get(screenshot.regionId)?.readingOrder ?? 1,
    }));
    const tableRowLocators = tableRows.map((row) => ({
      id: row.tableRowId,
      pageNumber: row.pageNumber,
      rightsImageIndex: row.rightsImageIndex,
      resultIndex: row.resultIndex,
      readingOrder: regionById.get(row.regionId)?.readingOrder ?? 1,
    }));
    let associations: StrictFinalizeRequest["associations"]["associations"] = [];
    const associationWarnings: string[] = [];
    if (screenshotLocators.length > 0) {
      const output = await gateway.associate({
        screenshots: screenshotLocators,
        tableRows: tableRowLocators,
      });
      associations = output.associations;
      associationWarnings.push(...output.warnings);
    }

    const warnings = uniqueWarnings([
      ...layoutWarnings,
      ...evidenceWarnings,
      ...urlWarnings,
      ...tableWarnings,
      ...associationWarnings,
    ]);
    const finalInput = StrictFinalizeRequestSchema.parse({
      fileName: options.fileName,
      pageCount: pdf.pageCount,
      layout: { pages: layoutPages, warnings: uniqueWarnings(layoutWarnings) },
      evidence: {
        certificates: evidenceCertificates,
        screenshots: evidenceScreenshots,
        warnings: uniqueWarnings(evidenceWarnings),
      },
      urlReviews: {
        reviews: urlReviews,
        warnings: uniqueWarnings(urlWarnings),
      },
      table: {
        headers: tableHeaders,
        rows: tableRows,
        warnings: uniqueWarnings(tableWarnings),
      },
      associations: {
        associations,
        warnings: uniqueWarnings(associationWarnings),
      },
      warnings,
      stageFailures,
    });

    await emitProgress(options.onProgress, {
      stage: "finalizing",
      progress: 94,
      processedPages: pdf.pageCount,
      totalPages: pdf.pageCount,
      batchIndex: 1,
      batchCount: 1,
    });
    return gateway.finalize(finalInput);
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}
