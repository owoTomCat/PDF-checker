import { NextResponse } from "next/server";
import {
  EvidenceApiResponseSchema,
  EvidenceRequestMetadataSchema,
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
              region.resultIndex === null ||
              region.addressBarRegionId === null)),
      );
    if (invalidMetadata) {
      throw new RouteInputError(
        "INVALID_INPUT",
        422,
        "证据区域元数据重复、越界或父子关系不完整。",
      );
    }

    const output = await createBailianClientFromEnv().recognizeEvidence({
      fileName: metadata.fileName,
      totalPages: metadata.totalPages,
      regions: metadata.regions.map((region, index) => ({
        ...region,
        dataUrl: dataUrls[index],
      })),
    });

    const certificateIds = new Set(
      metadata.regions
        .filter((region) => region.type === "certificate")
        .map((region) => region.regionId),
    );
    const screenshotMetadata = new Map(
      metadata.regions
        .filter((region) => region.type === "rights_screenshot")
        .map((region) => [region.regionId, region]),
    );
    const returnedCertificateIds = new Set(
      output.certificates.map((item) => item.regionId),
    );
    const returnedScreenshotIds = new Set(
      output.screenshots.map((item) => item.regionId),
    );
    const invalidOutput =
      returnedCertificateIds.size !== certificateIds.size ||
      returnedScreenshotIds.size !== screenshotMetadata.size ||
      [...certificateIds].some((id) => !returnedCertificateIds.has(id)) ||
      [...screenshotMetadata.keys()].some(
        (id) => !returnedScreenshotIds.has(id),
      ) ||
      output.screenshots.some((item) => {
        const source = screenshotMetadata.get(item.regionId);
        return (
          !source ||
          item.screenshotId !== item.regionId ||
          item.pageNumber !== source.pageNumber ||
          item.rightsImageIndex !== source.rightsImageIndex ||
          item.resultIndex !== source.resultIndex ||
          item.addressBarRegionId !== source.addressBarRegionId
        );
      });
    if (invalidOutput) {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "模型返回的证书或截图识别结果与区域不匹配。",
      );
    }

    return NextResponse.json(
      EvidenceApiResponseSchema.parse({ model: "qwen3.7-plus", ...output }),
    );
  } catch (error) {
    return modelRouteErrorResponse(error, "证书和截图识别失败，请稍后重试。");
  }
}
