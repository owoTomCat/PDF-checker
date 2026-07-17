import { NextResponse } from "next/server";
import {
  TableApiResponseSchema,
  TableRequestMetadataSchema,
} from "@/lib/ai/contracts";
import {
  BailianClientError,
  createBailianClientFromEnv,
} from "@/lib/server/bailian-client";
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
    const { metadata, dataUrls } = await parseImageBatchRequest(
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

    const output = await createBailianClientFromEnv().extractTable({
      fileName: metadata.fileName,
      totalPages: metadata.totalPages,
      regions: metadata.regions.map((region, index) => ({
        ...region,
        dataUrl: dataUrls[index],
      })),
    });
    const unexpectedRegion = [...output.headers, ...output.rows].some(
      (item) => !regionIds.has(item.regionId),
    );
    const rowIds = new Set(output.rows.map((row) => row.tableRowId));
    if (unexpectedRegion || rowIds.size !== output.rows.length) {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "模型返回的汇总表记录与表格区域不匹配。",
      );
    }

    return NextResponse.json(
      TableApiResponseSchema.parse({ model: "qwen3.7-plus", ...output }),
    );
  } catch (error) {
    return modelRouteErrorResponse(error, "汇总表提取失败，请稍后重试。");
  }
}
