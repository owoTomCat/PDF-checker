import { NextResponse } from "next/server";
import { StrictFinalizeRequestSchema } from "@/lib/ai/contracts";
import { buildFinalAuditResult } from "@/lib/audit-result";
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
    return NextResponse.json(buildFinalAuditResult(input));
  } catch (error) {
    return modelRouteErrorResponse(error, "汇总核验失败，请稍后重试。");
  }
}
