import { createCanvas } from "@napi-rs/canvas";
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

type ServerCanvasContext = {
  getImageData: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => { data: Uint8ClampedArray };
  putImageData: (
    imageData: { data: Uint8ClampedArray },
    x: number,
    y: number,
  ) => void;
};

type ServerCanvas = {
  width: number;
  height: number;
  getContext: (contextType: "2d") => ServerCanvasContext;
  encode: (
    format: "jpeg" | "png",
    quality?: number,
  ) => Promise<Uint8Array>;
};

type ServerPdfPage = {
  getViewport: (options: { scale: number }) => {
    width: number;
    height: number;
  };
  render: (options: {
    canvas: ServerCanvas;
    viewport: unknown;
    transform?: [number, number, number, number, number, number];
  }) => { promise: Promise<unknown> };
  cleanup: () => void;
};

type ServerPdfLoadingTask = {
  promise: Promise<{
    numPages: number;
    getPage: (pageNumber: number) => Promise<ServerPdfPage>;
  }>;
  destroy: () => Promise<void>;
};

export type ServerPdfRuntime = {
  readFile: (pdfPath: string) => Promise<Uint8Array>;
  getDocument: (data: Uint8Array) => ServerPdfLoadingTask;
  createCanvas: (width: number, height: number) => ServerCanvas;
};

function classifyPdfError(
  error: unknown,
  fallback: "PDF_INVALID" | "PDF_RENDER_FAILED",
) {
  if (error instanceof ServerPdfError) return error;
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
  return new ServerPdfError(fallback);
}

function assertImageSize(blob: Blob, description: string) {
  try {
    assertRenderBlobSize(blob.size, description);
  } catch {
    throw new ServerPdfError("PDF_IMAGE_TOO_LARGE");
  }
}

async function encodeCanvas(
  canvas: ServerCanvas,
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

function releaseRenderResources(
  page: ServerPdfPage | undefined,
  canvas: ServerCanvas | undefined,
) {
  let failure: ServerPdfError | undefined;
  try {
    page?.cleanup();
  } catch (error) {
    failure = classifyPdfError(error, "PDF_RENDER_FAILED");
  }
  if (canvas) {
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch (error) {
      failure ??= classifyPdfError(error, "PDF_RENDER_FAILED");
    }
  }
  return failure;
}

const defaultRuntime: ServerPdfRuntime = {
  async readFile(pdfPath) {
    return new Uint8Array(await readFile(pdfPath));
  },
  getDocument(data) {
    return getDocument({ data, verbosity: 0 }) as unknown as ServerPdfLoadingTask;
  },
  createCanvas(width, height) {
    return createCanvas(width, height) as unknown as ServerCanvas;
  },
};

export function createServerPdfOpener(runtime: ServerPdfRuntime) {
  return async function openServerPdfWithRuntime(
    pdfPath: string,
  ): Promise<RenderedPdfDocument> {
    let loadingTask: ServerPdfLoadingTask | undefined;

    try {
      const bytes = await runtime.readFile(pdfPath);
      loadingTask = runtime.getDocument(bytes);
      const activeLoadingTask = loadingTask;
      const document = await activeLoadingTask.promise;
      let destroyPromise: Promise<void> | undefined;
      const destroyDocument = () => {
        destroyPromise ??= Promise.resolve().then(() =>
          activeLoadingTask.destroy(),
        );
        return destroyPromise;
      };

      return {
        pageCount: document.numPages,
        async renderPage(pageNumber) {
          let page: ServerPdfPage | undefined;
          let canvas: ServerCanvas | undefined;
          let blob: Blob | undefined;
          let failure: ServerPdfError | undefined;

          try {
            page = await document.getPage(pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const scale = Math.min(
              MAX_RENDER_SCALE,
              MAX_RENDER_EDGE /
                Math.max(baseViewport.width, baseViewport.height),
            );
            const viewport = page.getViewport({ scale });
            canvas = runtime.createCanvas(
              Math.max(1, Math.ceil(viewport.width)),
              Math.max(1, Math.ceil(viewport.height)),
            );

            await page.render({ canvas, viewport }).promise;
            blob = await encodeCanvas(canvas, "image/jpeg");
            assertImageSize(blob, "渲染后的单页图片");
          } catch (error) {
            failure = classifyPdfError(error, "PDF_RENDER_FAILED");
          } finally {
            const releaseFailure = releaseRenderResources(page, canvas);
            failure ??= releaseFailure;
          }

          if (failure) {
            await destroyDocument().catch(() => undefined);
            throw failure;
          }
          return blob!;
        },
        async renderRegion(pageNumber, bounds: BoundingBox, options) {
          let page: ServerPdfPage | undefined;
          let canvas: ServerCanvas | undefined;
          let blob: Blob | undefined;
          let failure: ServerPdfError | undefined;

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
            canvas = runtime.createCanvas(plan.canvasWidth, plan.canvasHeight);
            const context = canvas.getContext("2d");

            await page.render({
              canvas,
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

            blob = await encodeCanvas(canvas, options.mimeType);
            assertImageSize(blob, "渲染后的区域图片");
          } catch (error) {
            failure = classifyPdfError(error, "PDF_RENDER_FAILED");
          } finally {
            const releaseFailure = releaseRenderResources(page, canvas);
            failure ??= releaseFailure;
          }

          if (failure) {
            await destroyDocument().catch(() => undefined);
            throw failure;
          }
          return blob!;
        },
        destroy: destroyDocument,
      };
    } catch (error) {
      await loadingTask?.destroy().catch(() => undefined);
      throw classifyPdfError(error, "PDF_INVALID");
    }
  };
}

export const openServerPdf = createServerPdfOpener(defaultRuntime);
