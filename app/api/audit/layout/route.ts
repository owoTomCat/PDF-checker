import { NextResponse } from "next/server";
import {
  LayoutApiResponseSchema,
  LayoutRequestMetadataSchema,
} from "@/lib/ai/contracts";
import {
  BailianClientError,
  createBailianClientFromEnv,
} from "@/lib/server/bailian-client";
import {
  RouteInputError,
  modelRouteErrorResponse,
  parseImageBatchRequest,
} from "@/lib/server/image-input";
import {
  assertModelRequestAllowed,
  modelRequestGuardOptionsFromEnv,
} from "@/lib/server/request-guards";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    assertModelRequestAllowed(request, modelRequestGuardOptionsFromEnv());
    const { metadata, dataUrls } = await parseImageBatchRequest(
      request,
      LayoutRequestMetadataSchema,
      (value) => value.pageNumbers.length,
    );
    const uniquePages = new Set(metadata.pageNumbers);
    if (
      uniquePages.size !== metadata.pageNumbers.length ||
      metadata.pageNumbers.some((page) => page > metadata.totalPages)
    ) {
      throw new RouteInputError(
        "INVALID_INPUT",
        422,
        "页码重复或超出 PDF 页数。",
      );
    }

    const output = await createBailianClientFromEnv().locateRegions({
      fileName: metadata.fileName,
      totalPages: metadata.totalPages,
      pages: dataUrls.map((imageDataUrl, index) => ({
        pageNumber: metadata.pageNumbers[index],
        dataUrl: imageDataUrl,
      })),
    });
    const expectedPages = [...metadata.pageNumbers].sort((a, b) => a - b);
    const returnedPages = output.pages
      .map((page) => page.pageNumber)
      .sort((a, b) => a - b);
    if (JSON.stringify(expectedPages) !== JSON.stringify(returnedPages)) {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "模型返回的页面定位结果不完整，请重新处理。",
      );
    }

    return NextResponse.json(
      LayoutApiResponseSchema.parse({ model: "qwen3.7-plus", ...output }),
    );
  } catch (error) {
    return modelRouteErrorResponse(error, "页面区域定位失败，请稍后重试。");
  }
}
