import type { ZodType } from "zod";
import {
  AssociationApiResponseSchema,
  EvidenceApiResponseSchema,
  LayoutApiResponseSchema,
  StrictFinalAuditResponseSchema,
  TableApiResponseSchema,
  UrlReviewApiResponseSchema,
  type StrictFinalAuditResponse,
} from "../ai/contracts";
import type {
  AuditStageGateway,
  RenderedImage,
  RenderedPdfDocument,
} from "../audit/gateway";
import {
  runAuditPipeline,
  validatePdfFile,
  type PipelineProgress,
} from "../audit/pipeline";

export {
  URL_REVIEW_DPI,
  chunkPageNumbers,
  validatePdfFile,
  type PipelineProgress,
  type PipelineStage,
} from "../audit/pipeline";
export type { RenderedPdfDocument } from "../audit/gateway";

type PipelineOptions = {
  fetchImpl?: typeof fetch;
  openPdf?: (file: File) => Promise<RenderedPdfDocument>;
  onProgress?: (progress: PipelineProgress) => void | Promise<void>;
};

async function defaultOpenPdf(file: File) {
  const { openPdfForRendering } = await import("./pdf-renderer");
  return openPdfForRendering(file);
}

async function responseJson(response: Response) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("服务器返回了无法解析的响应。");
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message.slice(0, 500)
        : "模型服务请求失败，请稍后重试。";
    throw new Error(message);
  }
  return body;
}

async function parseResponse<T>(
  response: Response,
  schema: ZodType<T>,
  incompleteMessage: string,
) {
  const parsed = schema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new Error(incompleteMessage);
  }
  return parsed.data;
}

function imageForm(metadata: unknown, images: RenderedImage[]) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (const image of images) {
    form.append(
      "images",
      new File([image.blob], image.fileName, { type: image.blob.type }),
    );
  }
  return form;
}

export function createHttpAuditGateway(
  fetchImpl: typeof fetch,
): AuditStageGateway {
  return {
    async locate(metadata, images) {
      return parseResponse(
        await fetchImpl("/api/audit/layout", {
          method: "POST",
          body: imageForm(metadata, images),
        }),
        LayoutApiResponseSchema,
        "页面区域定位响应不完整，请重新处理。",
      );
    },
    async recognize(metadata, images) {
      return parseResponse(
        await fetchImpl("/api/audit/recognize-evidence", {
          method: "POST",
          body: imageForm(metadata, images),
        }),
        EvidenceApiResponseSchema,
        "证书和网页截图识别响应不完整，请重新处理。",
      );
    },
    async reviewUrls(metadata, images) {
      return parseResponse(
        await fetchImpl("/api/audit/review-url", {
          method: "POST",
          body: imageForm(metadata, images),
        }),
        UrlReviewApiResponseSchema,
        "地址栏 URL 复核响应不完整，请重新处理。",
      );
    },
    async extractTable(metadata, images) {
      return parseResponse(
        await fetchImpl("/api/audit/extract-table", {
          method: "POST",
          body: imageForm(metadata, images),
        }),
        TableApiResponseSchema,
        "汇总表提取响应不完整，请重新处理。",
      );
    },
    async associate(input) {
      return parseResponse(
        await fetchImpl("/api/audit/associate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
        AssociationApiResponseSchema,
        "网页截图与汇总表关联响应不完整，请重新处理。",
      );
    },
    async finalize(input) {
      return parseResponse(
        await fetchImpl("/api/audit/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
        StrictFinalAuditResponseSchema,
        "最终规则核验响应不完整，请重新处理或人工复核。",
      );
    },
  };
}

export async function runAiAuditPipeline(
  file: File,
  options: PipelineOptions = {},
): Promise<StrictFinalAuditResponse> {
  validatePdfFile(file);
  const pdf = await (options.openPdf ?? defaultOpenPdf)(file);
  return runAuditPipeline({
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || null,
    pdf,
    gateway: createHttpAuditGateway(options.fetchImpl ?? fetch),
    onProgress: options.onProgress,
  });
}
