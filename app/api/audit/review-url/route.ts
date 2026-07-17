import { NextResponse } from "next/server";
import {
  UrlReviewApiResponseSchema,
  UrlReviewRequestMetadataSchema,
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
      UrlReviewRequestMetadataSchema,
      (value) => value.pairs.length * 2,
    );
    const screenshotIds = new Set(
      metadata.pairs.map((pair) => pair.screenshotId),
    );
    if (
      screenshotIds.size !== metadata.pairs.length ||
      metadata.pairs.some((pair) => pair.pageNumber > metadata.totalPages)
    ) {
      throw new RouteInputError(
        "INVALID_INPUT",
        422,
        "URL 复核记录重复或页码越界。",
      );
    }

    const output = await createBailianClientFromEnv().reviewUrls({
      fileName: metadata.fileName,
      totalPages: metadata.totalPages,
      pairs: metadata.pairs.map((pair, index) => ({
        ...pair,
        colorDataUrl: dataUrls[index * 2],
        grayscaleDataUrl: dataUrls[index * 2 + 1],
      })),
    });
    const returnedIds = new Set(
      output.reviews.map((review) => review.screenshotId),
    );
    if (
      returnedIds.size !== screenshotIds.size ||
      [...screenshotIds].some((id) => !returnedIds.has(id))
    ) {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "模型返回的 URL 复核记录不完整。",
      );
    }

    return NextResponse.json(
      UrlReviewApiResponseSchema.parse({ model: "qwen3.7-plus", ...output }),
    );
  } catch (error) {
    return modelRouteErrorResponse(error, "地址栏 URL 复核失败，请稍后重试。");
  }
}
