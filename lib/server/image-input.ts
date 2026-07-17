import { NextResponse } from "next/server";
import * as z from "zod";
import {
  MAX_BATCH_IMAGE_BYTES,
  MAX_PAGE_IMAGE_BYTES,
} from "../ai/contracts";
import { BailianClientError } from "./bailian-client";
import { RequestGuardError } from "./request-guards";

export const MAX_MODEL_MULTIPART_BODY_BYTES =
  MAX_BATCH_IMAGE_BYTES + 2 * 1024 * 1024;
export const MAX_MODEL_JSON_BODY_BYTES = 2 * 1024 * 1024;

export class RouteInputError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RouteInputError";
  }
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return (
    bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value)
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

async function imageFileToDataUrl(file: File) {
  if (file.size === 0 || file.size > MAX_PAGE_IMAGE_BYTES) {
    throw new RouteInputError(
      "IMAGE_TOO_LARGE",
      413,
      "单张图片为空或超过 7 MiB 限制。",
    );
  }
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    throw new RouteInputError(
      "INVALID_IMAGE",
      422,
      "图片仅支持 JPEG 或 PNG。",
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
      "图片内容与声明格式不一致。",
    );
  }
  return `data:${file.type};base64,${bytesToBase64(bytes)}`;
}

function assertDeclaredBodyWithinLimit(request: Request, maxBytes: number) {
  const declaredBodyBytes = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredBodyBytes) &&
    declaredBodyBytes > maxBytes
  ) {
    throw new RouteInputError(
      "BATCH_TOO_LARGE",
      413,
      "上传数据超过 26 MiB 限制。",
    );
  }
}

export async function parseImageBatchRequest<T>(
  request: Request,
  metadataSchema: z.ZodType<T>,
  expectedImageCount: (metadata: T) => number,
) {
  assertDeclaredBodyWithinLimit(request, MAX_MODEL_MULTIPART_BODY_BYTES);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new RouteInputError(
      "INVALID_INPUT",
      422,
      "上传数据不是有效的 multipart 表单。",
    );
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(String(form.get("metadata") ?? ""));
  } catch {
    throw new RouteInputError(
      "INVALID_INPUT",
      422,
      "阶段元数据不是有效 JSON。",
    );
  }
  const parsedMetadata = metadataSchema.safeParse(rawMetadata);
  if (!parsedMetadata.success) {
    throw new RouteInputError(
      "INVALID_INPUT",
      422,
      "阶段元数据不完整或包含禁止字段。",
    );
  }

  const values = form.getAll("images");
  if (values.some((value) => !(value instanceof File))) {
    throw new RouteInputError("INVALID_IMAGE", 422, "图片字段格式无效。");
  }
  const files = values as File[];
  if (files.length !== expectedImageCount(parsedMetadata.data)) {
    throw new RouteInputError(
      "INVALID_INPUT",
      422,
      "图片数量与阶段元数据不匹配。",
    );
  }

  const totalImageBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalImageBytes > MAX_BATCH_IMAGE_BYTES) {
    throw new RouteInputError(
      "BATCH_TOO_LARGE",
      413,
      "单批图片超过 24 MiB 限制。",
    );
  }

  return {
    metadata: parsedMetadata.data,
    dataUrls: await Promise.all(files.map(imageFileToDataUrl)),
  };
}

export async function parseJsonRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
) {
  const declaredBodyBytes = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredBodyBytes) &&
    declaredBodyBytes > MAX_MODEL_JSON_BODY_BYTES
  ) {
    throw new RouteInputError(
      "BODY_TOO_LARGE",
      413,
      "请求数据超过 2 MiB 限制。",
    );
  }

  const rawBody = await request.text();
  if (
    new TextEncoder().encode(rawBody).byteLength >
    MAX_MODEL_JSON_BODY_BYTES
  ) {
    throw new RouteInputError(
      "BODY_TOO_LARGE",
      413,
      "请求数据超过 2 MiB 限制。",
    );
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(rawBody);
  } catch {
    throw new RouteInputError(
      "INVALID_INPUT",
      422,
      "请求数据不是有效 JSON。",
    );
  }
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    throw new RouteInputError(
      "INVALID_INPUT",
      422,
      "请求数据不完整或包含禁止字段。",
    );
  }
  return parsed.data;
}

export function modelRouteErrorResponse(
  error: unknown,
  fallbackMessage: string,
) {
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
    { error: { code: "INTERNAL_ERROR", message: fallbackMessage } },
    { status: 500 },
  );
}
