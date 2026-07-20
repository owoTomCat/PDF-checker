import { stat } from "node:fs/promises";
import path from "node:path";
import { openServerPdf } from "../lib/server/pdf-renderer";

async function main() {
  const pdfPath = process.env.PDF_AUDIT_VERIFY_PDF;
  if (!pdfPath) {
    throw new Error("PDF_AUDIT_VERIFY_PDF is required.");
  }

  const fileStat = await stat(pdfPath);
  const document = await openServerPdf(pdfPath);

  try {
    const renderedImageSizes = [];
    for (let page = 1; page <= document.pageCount; page += 1) {
      const blob = await document.renderPage(page);
      renderedImageSizes.push({
        page,
        byteSize: blob.size,
        mimeType: blob.type,
      });
    }

    console.log(
      JSON.stringify({
        fileName: path.basename(pdfPath),
        byteSize: fileStat.size,
        pageCount: document.pageCount,
        renderedImageSizes,
      }),
    );
  } finally {
    await document.destroy();
  }
}

await main().catch(() => {
  process.exitCode = 1;
});
