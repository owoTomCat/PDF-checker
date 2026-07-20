import { NextResponse } from "next/server";
import { EvidenceRequestMetadataSchema } from "@/lib/ai/contracts";
import { createBailianAuditGateway } from "@/lib/server/bailian-audit-gateway";
import { createBailianClientFromEnv } from "@/lib/server/bailian-client";
import {
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
    );

    const gateway = createBailianAuditGateway(createBailianClientFromEnv());
    return NextResponse.json(await gateway.recognize(metadata, images));
  } catch (error) {
    return modelRouteErrorResponse(error, "证书和截图识别失败，请稍后重试。");
  }
}
