import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openServerPdf, ServerPdfError } from "../lib/server/pdf-renderer";
import { minimalPdfBytes } from "./minimal-pdf";

test("renders a generated PDF page and region in Node", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "one-page.pdf");
  await writeFile(pdfPath, minimalPdfBytes());
  const document = await openServerPdf(pdfPath);
  t.after(() => document.destroy());

  assert.equal(document.pageCount, 1);
  const page = await document.renderPage(1);
  assert.equal(page.type, "image/jpeg");
  assert.ok(page.size > 100);

  const region = await document.renderRegion(
    1,
    { x: 0, y: 0, width: 1, height: 1 },
    { dpi: 200, variant: "grayscale-contrast", mimeType: "image/png" },
  );
  assert.equal(region.type, "image/png");
  assert.ok(region.size > 100);
});

test("maps an invalid PDF to a stable safe error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "invalid.pdf");
  await writeFile(pdfPath, "%PDF-1.7\ninvalid");

  await assert.rejects(openServerPdf(pdfPath), (error: unknown) => {
    assert.ok(error instanceof ServerPdfError);
    assert.equal(error.code, "PDF_INVALID");
    assert.equal(error.message, "PDF 文件无效或已损坏。");
    assert.equal(error.message.includes(pdfPath), false);
    return true;
  });
});

test("verification failures do not print the private PDF path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privatePath = path.join(root, "private-document.pdf");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/verify-server-pdf.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PDF_AUDIT_VERIFY_PDF: privatePath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  const [exitCode] = await once(child, "close");
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});
