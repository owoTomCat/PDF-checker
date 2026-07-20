import { NextResponse } from "next/server";
import { LayoutRequestMetadataSchema } from "@/lib/ai/contracts";
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

    const gateway = createBailianAuditGateway(createBailianClientFromEnv());
    return NextResponse.json(await gateway.locate(metadata, images));
  } catch (error) {
    return modelRouteErrorResponse(error, "页面区域定位失败，请稍后重试。");
  }
}
