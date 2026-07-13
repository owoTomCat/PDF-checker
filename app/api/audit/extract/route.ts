import { NextResponse } from "next/server";
import {
  ExtractRequestMetadataSchema,
  MAX_BATCH_IMAGE_BYTES,
  MAX_PAGE_IMAGE_BYTES,
} from "@/lib/ai/contracts";
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

class RouteInputError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof RequestGuardError || error instanceof RouteInputError) {
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
    { error: { code: "INTERNAL_ERROR", message: "页面识别失败，请稍后重试。" } },
    { status: 500 },
  );
}

function isJpeg(bytes: Uint8Array) {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

async function pageFileToDataUrl(file: File) {
  if (file.size === 0 || file.size > MAX_PAGE_IMAGE_BYTES) {
    throw new RouteInputError(
      "IMAGE_TOO_LARGE",
      413,
      "单页图片为空或超过 8 MiB 限制。",
    );
  }
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    throw new RouteInputError(
      "INVALID_IMAGE",
      422,
      "页面图片仅支持 JPEG 或 PNG。",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validSignature =
    (file.type === "image/jpeg" && isJpeg(bytes)) ||
    (file.type === "image/png" && isPng(bytes));
  if (!validSignature) {
    throw new RouteInputError(
      "INVALID_IMAGE",
      422,
      "页面图片内容与声明格式不一致。",
    );
  }

  return `data:${file.type};base64,${bytesToBase64(bytes)}`;
}

export async function POST(request: Request) {
  try {
    assertModelRequestAllowed(request, modelRequestGuardOptionsFromEnv());
    const form = await request.formData();
    const files = form.getAll("pages");
    if (files.some((value) => !(value instanceof File))) {
      throw new RouteInputError("INVALID_IMAGE", 422, "页面图片格式无效。");
    }

    let pageNumbers: unknown;
    try {
      pageNumbers = JSON.parse(String(form.get("pageNumbers") ?? ""));
    } catch {
      throw new RouteInputError("INVALID_INPUT", 422, "页码参数格式无效。");
    }
    const totalPages = Number(form.get("totalPages"));
    const metadata = ExtractRequestMetadataSchema.safeParse({
      fileName: String(form.get("fileName") ?? ""),
      totalPages,
      pageNumbers,
    });
    if (!metadata.success || metadata.data.pageNumbers.length !== files.length) {
      throw new RouteInputError(
        "INVALID_INPUT",
        422,
        "页面图片与页码参数不匹配。",
      );
    }
    const uniquePages = new Set(metadata.data.pageNumbers);
    if (
      uniquePages.size !== metadata.data.pageNumbers.length ||
      metadata.data.pageNumbers.some((page) => page > totalPages)
    ) {
      throw new RouteInputError("INVALID_INPUT", 422, "页码参数超出范围。");
    }

    const imageFiles = files as File[];
    const totalImageBytes = imageFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalImageBytes > MAX_BATCH_IMAGE_BYTES) {
      throw new RouteInputError(
        "BATCH_TOO_LARGE",
        413,
        "单批页面图片超过 24 MiB 限制。",
      );
    }
    const dataUrls = await Promise.all(imageFiles.map(pageFileToDataUrl));
    const client = createBailianClientFromEnv();
    const output = await client.extractPages({
      fileName: metadata.data.fileName,
      totalPages: metadata.data.totalPages,
      pages: dataUrls.map((dataUrl, index) => ({
        pageNumber: metadata.data.pageNumbers[index],
        dataUrl,
      })),
    });

    const expectedPages = [...metadata.data.pageNumbers].sort((a, b) => a - b);
    const returnedPages = output.pages
      .map((page) => page.pageNumber)
      .sort((a, b) => a - b);
    if (JSON.stringify(expectedPages) !== JSON.stringify(returnedPages)) {
      throw new BailianClientError(
        "INVALID_MODEL_OUTPUT",
        "模型返回的页码不完整，请重新处理。",
      );
    }

    return NextResponse.json({
      model: "qwen3.7-plus",
      pages: output.pages,
      warnings: output.warnings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
