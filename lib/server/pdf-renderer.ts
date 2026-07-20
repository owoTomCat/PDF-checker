import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { BoundingBox } from "../ai/contracts";
import type { RenderedPdfDocument } from "../audit/gateway";
import {
  applyGrayscaleContrast,
  assertRenderBlobSize,
  computeRegionRenderPlan,
} from "../client/pdf-renderer-core";

const MAX_RENDER_EDGE = 1_800;
const MAX_RENDER_SCALE = 2;
const JPEG_QUALITY = 0.84;

export type ServerPdfErrorCode =
  | "PDF_ENCRYPTED"
  | "PDF_INVALID"
  | "PDF_UNSUPPORTED"
  | "PDF_IMAGE_TOO_LARGE"
  | "PDF_RENDER_FAILED";

const ERROR_MESSAGES: Record<ServerPdfErrorCode, string> = {
  PDF_ENCRYPTED: "PDF 文件已加密，无法处理。",
  PDF_INVALID: "PDF 文件无效或已损坏。",
  PDF_UNSUPPORTED: "PDF 文件包含不受支持的内容。",
  PDF_IMAGE_TOO_LARGE: "渲染后的 PDF 图片超过大小限制。",
  PDF_RENDER_FAILED: "PDF 页面渲染失败。",
};

export class ServerPdfError extends Error {
  readonly code: ServerPdfErrorCode;

  constructor(code: ServerPdfErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ServerPdfError";
    this.code = code;
  }
}

type RegionRenderOptions = Parameters<RenderedPdfDocument["renderRegion"]>[2];

function mapOpenError(error: unknown) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";

  if (name === "PasswordException") {
    return new ServerPdfError("PDF_ENCRYPTED");
  }
  if (name === "UnknownErrorException" || name === "FormatError") {
    return new ServerPdfError("PDF_UNSUPPORTED");
  }
  return new ServerPdfError("PDF_INVALID");
}

function mapRenderError(error: unknown) {
  if (error instanceof ServerPdfError) return error;
  return new ServerPdfError("PDF_RENDER_FAILED");
}

function assertImageSize(blob: Blob, description: string) {
  try {
    assertRenderBlobSize(blob.size, description);
  } catch {
    throw new ServerPdfError("PDF_IMAGE_TOO_LARGE");
  }
}

async function encodeCanvas(
  canvas: Canvas,
  mimeType: RegionRenderOptions["mimeType"],
) {
  const buffer =
    mimeType === "image/jpeg"
      ? await canvas.encode("jpeg", JPEG_QUALITY * 100)
      : await canvas.encode("png");
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new Blob([bytes], { type: mimeType });
}

export async function openServerPdf(
  pdfPath: string,
): Promise<RenderedPdfDocument> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;

  try {
    const buffer = await readFile(pdfPath);
    loadingTask = getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
    const activeLoadingTask = loadingTask;
    const document = await activeLoadingTask.promise;
    let destroyed = false;
    const destroyDocument = async () => {
      if (destroyed) return;
      destroyed = true;
      await activeLoadingTask.destroy();
    };

    return {
      pageCount: document.numPages,
      async renderPage(pageNumber) {
        let page: Awaited<ReturnType<typeof document.getPage>> | undefined;
        let canvas: Canvas | undefined;

        try {
          page = await document.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(
            MAX_RENDER_SCALE,
            MAX_RENDER_EDGE /
              Math.max(baseViewport.width, baseViewport.height),
          );
          const viewport = page.getViewport({ scale });
          canvas = createCanvas(
            Math.max(1, Math.ceil(viewport.width)),
            Math.max(1, Math.ceil(viewport.height)),
          );

          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport,
          }).promise;
          const blob = await encodeCanvas(canvas, "image/jpeg");
          assertImageSize(blob, "渲染后的单页图片");
          return blob;
        } catch (error) {
          await destroyDocument().catch(() => undefined);
          throw mapRenderError(error);
        } finally {
          page?.cleanup();
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
      },
      async renderRegion(pageNumber, bounds: BoundingBox, options) {
        let page: Awaited<ReturnType<typeof document.getPage>> | undefined;
        let canvas: Canvas | undefined;

        try {
          page = await document.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const plan = computeRegionRenderPlan(
            baseViewport.width,
            baseViewport.height,
            bounds,
            options.dpi,
          );
          const viewport = page.getViewport({ scale: plan.scale });
          canvas = createCanvas(plan.canvasWidth, plan.canvasHeight);
          const context = canvas.getContext("2d");

          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport,
            transform: plan.transform,
          }).promise;

          if (options.variant === "grayscale-contrast") {
            const imageData = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            applyGrayscaleContrast(imageData.data);
            context.putImageData(imageData, 0, 0);
          }

          const blob = await encodeCanvas(canvas, options.mimeType);
          assertImageSize(blob, "渲染后的区域图片");
          return blob;
        } catch (error) {
          await destroyDocument().catch(() => undefined);
          throw mapRenderError(error);
        } finally {
          page?.cleanup();
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
      },
      async destroy() {
        await destroyDocument();
      },
    };
  } catch (error) {
    await loadingTask?.destroy().catch(() => undefined);
    throw mapOpenError(error);
  }
}
