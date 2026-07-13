import {
  ExtractApiResponseSchema,
  FinalAuditResponseSchema,
  MAX_BATCH_PAGES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  type FinalAuditResponse,
  type PageExtraction,
} from "../ai/contracts";

export type PipelineStage = "rendering" | "extracting" | "finalizing";

export type PipelineProgress = {
  stage: PipelineStage;
  progress: number;
  processedPages: number;
  totalPages: number;
  batchIndex: number;
  batchCount: number;
};

export type RenderedPdfDocument = {
  pageCount: number;
  renderPage: (pageNumber: number) => Promise<Blob>;
  destroy: () => Promise<void>;
};

type PipelineOptions = {
  fetchImpl?: typeof fetch;
  openPdf?: (file: File) => Promise<RenderedPdfDocument>;
  onProgress?: (progress: PipelineProgress) => void;
};

export function validatePdfFile(file: File) {
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) throw new Error("仅支持 PDF 文件。");
  if (file.size === 0) throw new Error("PDF 文件为空。");
  if (file.size > MAX_PDF_BYTES) {
    throw new Error("PDF 文件超过 20 MiB 限制。");
  }
}

export function chunkPageNumbers(pageCount: number) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new Error(`PDF 页数必须在 1 至 ${MAX_PDF_PAGES} 页之间。`);
  }
  const batches: number[][] = [];
  for (let start = 1; start <= pageCount; start += MAX_BATCH_PAGES) {
    batches.push(
      Array.from(
        { length: Math.min(MAX_BATCH_PAGES, pageCount - start + 1) },
        (_, index) => start + index,
      ),
    );
  }
  return batches;
}

async function defaultOpenPdf(file: File) {
  const { openPdfForRendering } = await import("./pdf-renderer");
  return openPdfForRendering(file);
}

async function responseJson(response: Response) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("服务器返回了无法解析的响应。");
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message.slice(0, 500)
        : "模型服务请求失败，请稍后重试。";
    throw new Error(message);
  }
  return body;
}

function emitProgress(
  callback: PipelineOptions["onProgress"],
  progress: PipelineProgress,
) {
  callback?.(progress);
}

export async function runAiAuditPipeline(
  file: File,
  options: PipelineOptions = {},
): Promise<FinalAuditResponse> {
  validatePdfFile(file);
  const fetchImpl = options.fetchImpl ?? fetch;
  const openPdf = options.openPdf ?? defaultOpenPdf;
  const pdf = await openPdf(file);

  try {
    if (pdf.pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页限制。`);
    }
    const batches = chunkPageNumbers(pdf.pageCount);
    const extractedPages: PageExtraction[] = [];
    let processedPages = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const pageNumbers = batches[batchIndex];
      const rendered: Array<{ pageNumber: number; blob: Blob }> = [];

      for (const pageNumber of pageNumbers) {
        emitProgress(options.onProgress, {
          stage: "rendering",
          progress: Math.round(5 + (processedPages / pdf.pageCount) * 70),
          processedPages,
          totalPages: pdf.pageCount,
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
        });
        rendered.push({ pageNumber, blob: await pdf.renderPage(pageNumber) });
      }

      emitProgress(options.onProgress, {
        stage: "extracting",
        progress: Math.round(10 + (processedPages / pdf.pageCount) * 70),
        processedPages,
        totalPages: pdf.pageCount,
        batchIndex: batchIndex + 1,
        batchCount: batches.length,
      });
      const form = new FormData();
      form.append("fileName", file.name);
      form.append("totalPages", String(pdf.pageCount));
      form.append("pageNumbers", JSON.stringify(pageNumbers));
      for (const page of rendered) {
        form.append(
          "pages",
          new File([page.blob], `page-${page.pageNumber}.jpg`, {
            type: "image/jpeg",
          }),
        );
      }

      const response = await fetchImpl("/api/audit/extract", {
        method: "POST",
        body: form,
      });
      const parsed = ExtractApiResponseSchema.safeParse(
        await responseJson(response),
      );
      if (!parsed.success) {
        throw new Error("页级模型响应不完整，请重新处理。");
      }
      const returnedPages = new Set(parsed.data.pages.map((page) => page.pageNumber));
      if (
        returnedPages.size !== pageNumbers.length ||
        pageNumbers.some((page) => !returnedPages.has(page))
      ) {
        throw new Error("页级模型响应缺少页面，请重新处理。");
      }
      extractedPages.push(...parsed.data.pages);
      processedPages += pageNumbers.length;
    }

    extractedPages.sort((left, right) => left.pageNumber - right.pageNumber);
    emitProgress(options.onProgress, {
      stage: "finalizing",
      progress: 90,
      processedPages: pdf.pageCount,
      totalPages: pdf.pageCount,
      batchIndex: batches.length,
      batchCount: batches.length,
    });
    const finalResponse = await fetchImpl("/api/audit/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        pageCount: pdf.pageCount,
        pages: extractedPages,
      }),
    });
    const finalResult = FinalAuditResponseSchema.safeParse(
      await responseJson(finalResponse),
    );
    if (!finalResult.success) {
      throw new Error("最终模型响应不完整，请重新处理或人工复核。");
    }
    return finalResult.data;
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}
