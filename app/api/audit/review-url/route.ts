import { NextResponse } from "next/server";
import { UrlReviewRequestMetadataSchema } from "@/lib/ai/contracts";
import { createBailianAuditGateway } from "@/lib/server/bailian-audit-gateway";
import { createBailianClientFromEnv } from "@/lib/server/bailian-client";
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
    const { metadata, images } = await parseImageBatchRequest(
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

    const gateway = createBailianAuditGateway(createBailianClientFromEnv());
    return NextResponse.json(await gateway.reviewUrls(metadata, images));
  } catch (error) {
    return modelRouteErrorResponse(error, "地址栏 URL 复核失败，请稍后重试。");
  }
}
