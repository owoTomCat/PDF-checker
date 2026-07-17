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

    const locatorKey = (item: {
      rightsImageIndex: number;
      resultIndex: number;
    }) => `${item.rightsImageIndex}:${item.resultIndex}`;
    const screenshotCounts = new Map<string, number>();
    const tableRowsByKey = new Map<string, typeof input.tableRows>();
    for (const screenshot of input.screenshots) {
      const key = locatorKey(screenshot);
      screenshotCounts.set(key, (screenshotCounts.get(key) ?? 0) + 1);
    }
    for (const tableRow of input.tableRows) {
      const key = locatorKey(tableRow);
      const rows = tableRowsByKey.get(key) ?? [];
      rows.push(tableRow);
      tableRowsByKey.set(key, rows);
    }
    const associations = input.screenshots.map((screenshot) => {
      const key = locatorKey(screenshot);
      const tableRows = tableRowsByKey.get(key) ?? [];
      if (screenshotCounts.get(key) === 1 && tableRows.length === 1) {
        return {
          screenshotId: screenshot.id,
          tableRowId: tableRows[0].id,
          confidence: 1,
          reason: "权利图序号和结果序号唯一一致。",
        };
      }

      return {
        screenshotId: screenshot.id,
        tableRowId: null,
        confidence: 0,
        reason:
          tableRows.length === 0
            ? "未找到权利图序号和结果序号一致的汇总表行。"
            : "相同权利图序号和结果序号存在重复项，无法唯一关联。",
      };
    });
    const normalizedOutput = {
      associations,
      warnings: associations
        .filter((association) => association.tableRowId === null)
        .map((association) => association.reason),
    };

    return NextResponse.json(
      AssociationApiResponseSchema.parse({
        model: "qwen3.7-plus",
        ...normalizedOutput,
      }),
    );
  } catch (error) {
    return modelRouteErrorResponse(error, "截图与表格关联失败，请稍后重试。");
  }
}
