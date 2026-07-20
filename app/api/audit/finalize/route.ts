import { NextResponse } from "next/server";
import { StrictFinalizeRequestSchema } from "@/lib/ai/contracts";
import { createBailianAuditGateway } from "@/lib/server/bailian-audit-gateway";
import { createBailianClientFromEnv } from "@/lib/server/bailian-client";
import {
  modelRouteErrorResponse,
  parseJsonRequest,
} from "@/lib/server/image-input";
import {
  assertModelRequestAllowed,
  modelRequestGuardOptionsFromEnv,
} from "@/lib/server/request-guards";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    assertModelRequestAllowed(request, modelRequestGuardOptionsFromEnv());
    const input = await parseJsonRequest(request, StrictFinalizeRequestSchema);
    const gateway = createBailianAuditGateway(createBailianClientFromEnv());
    return NextResponse.json(await gateway.finalize(input));
  } catch (error) {
    return modelRouteErrorResponse(error, "汇总核验失败，请稍后重试。");
  }
}
