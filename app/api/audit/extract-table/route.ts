import { NextResponse } from "next/server";
import { TableRequestMetadataSchema } from "@/lib/ai/contracts";
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
      TableRequestMetadataSchema,
      (value) => value.regions.length,
    );
    const regionIds = new Set(metadata.regions.map((region) => region.regionId));
    if (
      regionIds.size !== metadata.regions.length ||
      metadata.regions.some((region) => region.pageNumber > metadata.totalPages)
    ) {
      throw new RouteInputError(
        "INVALID_INPUT",
        422,
        "表格区域重复或页码越界。",
      );
    }

    const gateway = createBailianAuditGateway(createBailianClientFromEnv());
    return NextResponse.json(await gateway.extractTable(metadata, images));
  } catch (error) {
    return modelRouteErrorResponse(error, "汇总表提取失败，请稍后重试。");
  }
}
