import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { MAX_PAGE_IMAGE_BYTES } from "../ai/contracts";
import type { RenderedPdfDocument } from "./audit-pipeline";

const MAX_RENDER_EDGE = 1_800;
const MAX_RENDER_SCALE = 2;
const JPEG_QUALITY = 0.84;

function canvasToJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("页面图片编码失败。"));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
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
    throw new Error("无法读取 PDF；文件可能已损坏、加密或格式不受支持。");
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
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      if (!canvas.getContext("2d")) {
        throw new Error("当前浏览器无法创建 PDF 页面画布。");
      }

      try {
        await page.render({ canvas, viewport }).promise;
        const blob = await canvasToJpeg(canvas);
        if (blob.size > MAX_PAGE_IMAGE_BYTES) {
          throw new Error("渲染后的单页图片超过 7 MiB 限制。");
        }
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
