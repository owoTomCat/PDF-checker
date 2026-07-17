import { NextResponse } from "next/server";
import {
  AssociationApiResponseSchema,
  AssociationRequestSchema,
} from "@/lib/ai/contracts";
import {
  BailianClientError,
  createBailianClientFromEnv,
} from "@/lib/server/bailian-client";
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
    const output = await createBailianClientFromEnv().associateRows(input);
    const expectedScreenshotIds = new Set(
      input.screenshots.map((item) => item.id),
    );
    const allowedTableRowIds = new Set(input.tableRows.map((item) => item.id));
    const returnedScreenshotIds = new Set(
      output.associations.map((item) => item.screenshotId),
    );
    const invalidOutput =
      returnedScreenshotIds.size !== expectedScreenshotIds.size ||
      [...expectedScreenshotIds].some(
        (id) => !returnedScreenshotIds.has(id),
      ) ||
      output.associations.some(
        (item) =>
          !expectedScreenshotIds.has(item.screenshotId) ||
          (item.tableRowId !== null &&
            !allowedTableRowIds.has(item.tableRowId)),
      );
    if (invalidOutput) {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "模型返回的 ID 关联结果不完整或越界。",
      );
    }

    return NextResponse.json(
      AssociationApiResponseSchema.parse({
        model: "qwen3.7-plus",
        ...output,
      }),
    );
  } catch (error) {
    return modelRouteErrorResponse(error, "截图与表格关联失败，请稍后重试。");
  }
}
