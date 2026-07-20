import { NextResponse } from "next/server";
import { AssociationRequestSchema } from "@/lib/ai/contracts";
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
    const input = await parseJsonRequest(request, AssociationRequestSchema);
    const gateway = createBailianAuditGateway(createBailianClientFromEnv);
    return NextResponse.json(await gateway.associate(input));
  } catch (error) {
    return modelRouteErrorResponse(error, "截图与表格关联失败，请稍后重试。");
  }
}
