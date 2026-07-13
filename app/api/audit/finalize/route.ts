import { NextResponse } from "next/server";
import { buildFinalAuditResult } from "@/lib/audit-result";
import { FinalizeRequestSchema } from "@/lib/ai/contracts";
import {
  BailianClientError,
  createBailianClientFromEnv,
} from "@/lib/server/bailian-client";
import {
  RequestGuardError,
  assertModelRequestAllowed,
  modelRequestGuardOptionsFromEnv,
} from "@/lib/server/request-guards";

export const runtime = "edge";

const MAX_FINALIZE_BODY_BYTES = 2 * 1024 * 1024;

class FinalizeInputError extends Error {
  readonly code = "INVALID_INPUT";
  readonly status = 422;
}

function errorResponse(error: unknown) {
  if (error instanceof RequestGuardError || error instanceof FinalizeInputError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof BailianClientError) {
    const status =
      error.code === "UPSTREAM_TIMEOUT"
        ? 504
        : error.code === "CONFIG_ERROR"
          ? 503
          : 502;
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "汇总核验失败，请稍后重试。" } },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    assertModelRequestAllowed(request, modelRequestGuardOptionsFromEnv());
    const declaredBodyBytes = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(declaredBodyBytes) &&
      declaredBodyBytes > MAX_FINALIZE_BODY_BYTES
    ) {
      return NextResponse.json(
        { error: { code: "BODY_TOO_LARGE", message: "汇总数据超过 2 MiB 限制。" } },
        { status: 413 },
      );
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_FINALIZE_BODY_BYTES) {
      return NextResponse.json(
        { error: { code: "BODY_TOO_LARGE", message: "汇总数据超过 2 MiB 限制。" } },
        { status: 413 },
      );
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(rawBody);
    } catch {
      throw new FinalizeInputError("汇总参数不是有效 JSON。");
    }
    const parsedInput = FinalizeRequestSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new FinalizeInputError("汇总参数不完整或超出限制。");
    }
    const pageNumbers = parsedInput.data.pages.map((page) => page.pageNumber);
    const uniquePages = new Set(pageNumbers);
    const allPagesPresent =
      uniquePages.size === parsedInput.data.pageCount &&
      Array.from({ length: parsedInput.data.pageCount }, (_, index) => index + 1).every(
        (page) => uniquePages.has(page),
      );
    if (!allPagesPresent) {
      throw new FinalizeInputError("页级识别结果不完整，无法汇总。");
    }

    const client = createBailianClientFromEnv();
    const modelOutput = await client.finalize(parsedInput.data);
    return NextResponse.json(
      buildFinalAuditResult(modelOutput, parsedInput.data.pageCount),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
