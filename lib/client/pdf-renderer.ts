import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { BoundingBox } from "../ai/contracts";
import type { RenderedPdfDocument } from "./audit-pipeline";
import {
  applyGrayscaleContrast,
  assertRenderBlobSize,
  computeRegionRenderPlan,
} from "./pdf-renderer-core";

export { applyGrayscaleContrast, computeRegionRenderPlan } from "./pdf-renderer-core";

const MAX_RENDER_EDGE = 1_800;
const MAX_RENDER_SCALE = 2;
const JPEG_QUALITY = 0.84;

type RegionRenderOptions = Parameters<RenderedPdfDocument["renderRegion"]>[2];

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: RegionRenderOptions["mimeType"],
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PDF 页面图片编码失败。"));
      },
      mimeType,
      mimeType === "image/jpeg" ? JPEG_QUALITY : undefined,
    );
  });
}

function createCanvas(width: number, height: number) {
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error("当前浏览器无法创建 PDF 页面画布。");
  }
  return { canvas, context };
}

export async function openPdfForRendering(
  file: File,
): Promise<RenderedPdfDocument> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });

  let document: Awaited<typeof loadingTask.promise>;
  try {
    document = await loadingTask.promise;
  } catch {
    await loadingTask.destroy().catch(() => undefined);
    throw new Error(
      "无法读取 PDF；文件可能已损坏、加密或格式不受支持。",
    );
  }

  return {
    pageCount: document.numPages,
    async renderPage(pageNumber) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        MAX_RENDER_SCALE,
        MAX_RENDER_EDGE / Math.max(baseViewport.width, baseViewport.height),
      );
      const viewport = page.getViewport({ scale });
      const { canvas } = createCanvas(viewport.width, viewport.height);

      try {
        await page.render({ canvas, viewport }).promise;
        const blob = await canvasToBlob(canvas, "image/jpeg");
        assertRenderBlobSize(blob.size, "渲染后的单页图片");
        return blob;
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    async renderRegion(
      pageNumber: number,
      bounds: BoundingBox,
      options: RegionRenderOptions,
    ) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const plan = computeRegionRenderPlan(
        baseViewport.width,
        baseViewport.height,
        bounds,
        options.dpi,
      );
      const viewport = page.getViewport({ scale: plan.scale });
      const { canvas, context } = createCanvas(
        plan.canvasWidth,
        plan.canvasHeight,
      );

      try {
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

        const blob = await canvasToBlob(canvas, options.mimeType);
        assertRenderBlobSize(blob.size, "渲染后的区域图片");
        return blob;
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    async destroy() {
      await loadingTask.destroy();
    },
  };
}
