import {
  AssociationApiResponseSchema,
  AssociationRequestSchema,
  EvidenceApiResponseSchema,
  EvidenceRequestMetadataSchema,
  LayoutApiResponseSchema,
  LayoutRequestMetadataSchema,
  StrictFinalAuditResponseSchema,
  StrictFinalizeRequestSchema,
  TableApiResponseSchema,
  TableRequestMetadataSchema,
  UrlReviewApiResponseSchema,
  UrlReviewRequestMetadataSchema,
} from "../ai/contracts";
import type { AuditStageGateway, RenderedImage } from "../audit/gateway";
import { buildFinalAuditResult } from "../audit-result";
import {
  BailianClientError,
  createBailianClient,
} from "./bailian-client";

type BailianClient = ReturnType<typeof createBailianClient>;
type BailianClientProvider = BailianClient | (() => BailianClient);

export class AuditGatewayInputError extends Error {
  readonly code = "INVALID_INPUT";
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "AuditGatewayInputError";
  }
}

async function blobDataUrl(blob: Blob) {
  const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  return `data:${blob.type};base64,${base64}`;
}

async function imageDataUrls(images: RenderedImage[]) {
  return Promise.all(images.map((image) => blobDataUrl(image.blob)));
}

function invalidModelOutput(message: string): never {
  throw new BailianClientError("INVALID_MODEL_OUTPUT", message);
}

function invalidInput(message: string): never {
  throw new AuditGatewayInputError(message);
}

function assertImageCount(images: RenderedImage[], expected: number) {
  if (images.length !== expected) {
    invalidInput("图片数量与阶段元数据不匹配。");
  }
}

export function createBailianAuditGateway(
  provider?: BailianClientProvider,
): AuditStageGateway {
  let resolvedClient = typeof provider === "function" ? undefined : provider;
  function resolveClient() {
    if (resolvedClient) return resolvedClient;
    if (typeof provider !== "function") {
      throw new BailianClientError("CONFIG_ERROR", "百炼客户端未配置。");
    }
    resolvedClient = provider();
    return resolvedClient;
  }

  return {
    async locate(rawMetadata, images) {
      const metadata = LayoutRequestMetadataSchema.parse(rawMetadata);
      const uniquePages = new Set(metadata.pageNumbers);
      if (
        uniquePages.size !== metadata.pageNumbers.length ||
        metadata.pageNumbers.some((page) => page > metadata.totalPages)
      ) {
        invalidInput("页码重复或超出 PDF 页数。");
      }
      assertImageCount(images, metadata.pageNumbers.length);
      const dataUrls = await imageDataUrls(images);
      const client = resolveClient();
      const output = await client.locateRegions({
        fileName: metadata.fileName,
        totalPages: metadata.totalPages,
        pages: dataUrls.map((dataUrl, index) => ({
          pageNumber: metadata.pageNumbers[index],
          dataUrl,
        })),
      });
      const expectedPages = [...metadata.pageNumbers].sort((a, b) => a - b);
      const returnedPages = output.pages
        .map((page) => page.pageNumber)
        .sort((a, b) => a - b);
      if (
        expectedPages.length !== returnedPages.length ||
        expectedPages.some((pageNumber, index) => pageNumber !== returnedPages[index])
      ) {
        invalidModelOutput(
          "模型返回的页面定位结果不完整，请重新处理。",
        );
      }
      return LayoutApiResponseSchema.parse({
        model: "qwen3.7-plus",
        ...output,
      });
    },

    async recognize(rawMetadata, images) {
      const metadata = EvidenceRequestMetadataSchema.parse(rawMetadata);
      const regionIds = new Set(metadata.regions.map((region) => region.regionId));
      const invalidMetadata =
        regionIds.size !== metadata.regions.length ||
        metadata.regions.some(
          (region) =>
            region.pageNumber > metadata.totalPages ||
            (region.type === "certificate" &&
              (region.rightsImageIndex !== null ||
                region.resultIndex !== null ||
                region.addressBarRegionId !== null)) ||
            (region.type === "rights_screenshot" &&
              (region.rightsImageIndex === null ||
                region.resultIndex === null)),
        );
      if (invalidMetadata) {
        invalidInput(
          "证据区域元数据重复、越界或父子关系不完整。",
        );
      }
      assertImageCount(images, metadata.regions.length);
      const dataUrls = await imageDataUrls(images);
      const client = resolveClient();
      const output = await client.recognizeEvidence({
        fileName: metadata.fileName,
        totalPages: metadata.totalPages,
        regions: metadata.regions.map((region, index) => ({
          ...region,
          dataUrl: dataUrls[index],
        })),
      });
      const normalizedOutput = {
        ...output,
        screenshots: output.screenshots.map((item) => ({
          ...item,
          screenshotId: item.regionId,
        })),
      };
      const certificateIds = new Set(
        metadata.regions
          .filter((region) => region.type === "certificate")
          .map((region) => region.regionId),
      );
      const screenshotMetadata = new Map(
        metadata.regions
          .filter((region) => region.type === "rights_screenshot")
          .map((region) => [region.regionId, region]),
      );
      const returnedCertificateIds = new Set(
        normalizedOutput.certificates.map((item) => item.regionId),
      );
      const returnedScreenshotIds = new Set(
        normalizedOutput.screenshots.map((item) => item.regionId),
      );
      const invalidOutput =
        returnedCertificateIds.size !== certificateIds.size ||
        returnedScreenshotIds.size !== screenshotMetadata.size ||
        [...certificateIds].some((id) => !returnedCertificateIds.has(id)) ||
        [...screenshotMetadata.keys()].some(
          (id) => !returnedScreenshotIds.has(id),
        ) ||
        normalizedOutput.screenshots.some((item) => {
          const source = screenshotMetadata.get(item.regionId);
          return (
            !source ||
            item.screenshotId !== item.regionId ||
            item.pageNumber !== source.pageNumber ||
            item.rightsImageIndex !== source.rightsImageIndex ||
            item.resultIndex !== source.resultIndex ||
            item.addressBarRegionId !== source.addressBarRegionId
          );
        });
      if (invalidOutput) {
        invalidModelOutput(
          "模型返回的证书或截图识别结果与区域不匹配。",
        );
      }
      return EvidenceApiResponseSchema.parse({
        model: "qwen3.7-plus",
        ...normalizedOutput,
      });
    },

    async reviewUrls(rawMetadata, images) {
      const metadata = UrlReviewRequestMetadataSchema.parse(rawMetadata);
      const screenshotIds = new Set(
        metadata.pairs.map((pair) => pair.screenshotId),
      );
      if (
        screenshotIds.size !== metadata.pairs.length ||
        metadata.pairs.some((pair) => pair.pageNumber > metadata.totalPages)
      ) {
        invalidInput("URL 复核记录重复或页码越界。");
      }
      assertImageCount(images, metadata.pairs.length * 2);
      const dataUrls = await imageDataUrls(images);
      const client = resolveClient();
      const output = await client.reviewUrls({
        fileName: metadata.fileName,
        totalPages: metadata.totalPages,
        pairs: metadata.pairs.map((pair, index) => ({
          ...pair,
          colorDataUrl: dataUrls[index * 2],
          grayscaleDataUrl: dataUrls[index * 2 + 1],
        })),
      });
      const expectedIds = new Set(metadata.pairs.map((pair) => pair.screenshotId));
      const returnedIds = new Set(
        output.reviews.map((review) => review.screenshotId),
      );
      if (
        returnedIds.size !== expectedIds.size ||
        [...expectedIds].some((id) => !returnedIds.has(id))
      ) {
        invalidModelOutput("模型返回的 URL 复核记录不完整。");
      }
      return UrlReviewApiResponseSchema.parse({
        model: "qwen3.7-plus",
        ...output,
      });
    },

    async extractTable(rawMetadata, images) {
      const metadata = TableRequestMetadataSchema.parse(rawMetadata);
      const regionIds = new Set(metadata.regions.map((region) => region.regionId));
      if (
        regionIds.size !== metadata.regions.length ||
        metadata.regions.some((region) => region.pageNumber > metadata.totalPages)
      ) {
        invalidInput("表格区域重复或页码越界。");
      }
      assertImageCount(images, metadata.regions.length);
      const dataUrls = await imageDataUrls(images);
      const client = resolveClient();
      const output = await client.extractTable({
        fileName: metadata.fileName,
        totalPages: metadata.totalPages,
        regions: metadata.regions.map((region, index) => ({
          ...region,
          dataUrl: dataUrls[index],
        })),
      });
      const unexpectedRegion = [...output.headers, ...output.rows].some(
        (item) => !regionIds.has(item.regionId),
      );
      const rowIds = new Set(output.rows.map((row) => row.tableRowId));
      if (unexpectedRegion || rowIds.size !== output.rows.length) {
        invalidModelOutput(
          "模型返回的汇总表记录与表格区域不匹配。",
        );
      }
      return TableApiResponseSchema.parse({
        model: "qwen3.7-plus",
        ...output,
      });
    },

    async associate(rawInput) {
      const input = AssociationRequestSchema.parse(rawInput);
      const client = resolveClient();
      const output = await client.associateRows(input);
      const expectedScreenshotIds = new Set(
        input.screenshots.map((item) => item.id),
      );
      const allowedTableRowIds = new Set(input.tableRows.map((item) => item.id));
      const returnedScreenshotIds = new Set(
        output.associations.map((item) => item.screenshotId),
      );
      const invalidOutput =
        returnedScreenshotIds.size !== expectedScreenshotIds.size ||
        [...expectedScreenshotIds].some(
          (id) => !returnedScreenshotIds.has(id),
        ) ||
        output.associations.some(
          (item) =>
            !expectedScreenshotIds.has(item.screenshotId) ||
            (item.tableRowId !== null &&
              !allowedTableRowIds.has(item.tableRowId)),
        );
      if (invalidOutput) {
        invalidModelOutput("模型返回的 ID 关联结果不完整或越界。");
      }

      const locatorKey = (item: {
        rightsImageIndex: number;
        resultIndex: number;
      }) => `${item.rightsImageIndex}:${item.resultIndex}`;
      const screenshotCounts = new Map<string, number>();
      const tableRowsByKey = new Map<string, typeof input.tableRows>();
      for (const screenshot of input.screenshots) {
        const key = locatorKey(screenshot);
        screenshotCounts.set(key, (screenshotCounts.get(key) ?? 0) + 1);
      }
      for (const tableRow of input.tableRows) {
        const key = locatorKey(tableRow);
        const rows = tableRowsByKey.get(key) ?? [];
        rows.push(tableRow);
        tableRowsByKey.set(key, rows);
      }
      const associations = input.screenshots.map((screenshot) => {
        const key = locatorKey(screenshot);
        const tableRows = tableRowsByKey.get(key) ?? [];
        if (screenshotCounts.get(key) === 1 && tableRows.length === 1) {
          return {
            screenshotId: screenshot.id,
            tableRowId: tableRows[0].id,
            confidence: 1,
            reason: "权利图序号和结果序号唯一一致。",
          };
        }
        return {
          screenshotId: screenshot.id,
          tableRowId: null,
          confidence: 0,
          reason:
            tableRows.length === 0
              ? "未找到权利图序号和结果序号一致的汇总表行。"
              : "相同权利图序号和结果序号存在重复项，无法唯一关联。",
        };
      });
      return AssociationApiResponseSchema.parse({
        model: "qwen3.7-plus",
        associations,
        warnings: associations
          .filter((association) => association.tableRowId === null)
          .map((association) => association.reason),
      });
    },

    async finalize(rawInput) {
      const input = StrictFinalizeRequestSchema.parse(rawInput);
      return StrictFinalAuditResponseSchema.parse(buildFinalAuditResult(input));
    },
  };
}
