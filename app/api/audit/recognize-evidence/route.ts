import { NextResponse } from "next/server";
import { EvidenceRequestMetadataSchema } from "@/lib/ai/contracts";
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
      EvidenceRequestMetadataSchema,
      (value) => value.regions.length,
    );
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
      throw new RouteInputError(
        "INVALID_INPUT",
        422,
        "证据区域元数据重复、越界或父子关系不完整。",
      );
    }

    const gateway = createBailianAuditGateway(createBailianClientFromEnv());
    return NextResponse.json(await gateway.recognize(metadata, images));
  } catch (error) {
    return modelRouteErrorResponse(error, "证书和截图识别失败，请稍后重试。");
  }
}
