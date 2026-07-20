import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createServerPdfOpener,
  openServerPdf,
  ServerPdfError,
} from "../lib/server/pdf-renderer";
import { minimalPdfBytes } from "./minimal-pdf";

const MAX_PAGE_IMAGE_BYTES = 7 * 1024 * 1024;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function namedError(name: string) {
  return Object.assign(new Error("private PDF.js detail"), { name });
}

function fakeRuntime(options?: {
  openError?: Error;
  getPageError?: Error;
  renderError?: Error;
  encodedBytes?: number;
  destroy?: () => Promise<void>;
}) {
  const metrics = {
    destroyCalls: 0,
    pageCleanupCalls: 0,
    canvas: undefined as
      | { width: number; height: number; encode: () => Promise<Uint8Array> }
      | undefined,
  };
  const page = {
    getViewport({ scale }: { scale: number }) {
      return { width: 10 * scale, height: 20 * scale };
    },
    render() {
      return {
        promise: options?.renderError
          ? Promise.reject(options.renderError)
          : Promise.resolve(),
      };
    },
    cleanup() {
      metrics.pageCleanupCalls += 1;
    },
  };
  const loadingTask = {
    promise: options?.openError
      ? Promise.reject(options.openError)
      : Promise.resolve({
          numPages: 1,
          getPage: async () => {
            if (options?.getPageError) throw options.getPageError;
            return page;
          },
        }),
    async destroy() {
      metrics.destroyCalls += 1;
      await options?.destroy?.();
    },
  };
  const runtime = {
    async readFile() {
      return new Uint8Array([1]);
    },
    getDocument() {
      return loadingTask;
    },
    createCanvas(width: number, height: number) {
      const canvas = {
        width,
        height,
        getContext() {
          return {
            getImageData() {
              return {
                data: new Uint8ClampedArray(width * height * 4),
              };
            },
            putImageData() {},
          };
        },
        async encode() {
          return new Uint8Array(options?.encodedBytes ?? 256);
        },
      };
      metrics.canvas = canvas;
      return canvas;
    },
  };
  return { runtime, metrics };
}

async function spawnVerifier(pdfPath: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/verify-server-pdf.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PDF_AUDIT_VERIFY_PDF: pdfPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [exitCode] = await once(child, "close");
  return { exitCode, stdout, stderr };
}

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

test("maps encrypted PDFs without exposing PDF.js details", async () => {
  const { runtime, metrics } = fakeRuntime({
    openError: namedError("PasswordException"),
  });
  const open = createServerPdfOpener(runtime);

  await assert.rejects(open("private.pdf"), (error: unknown) => {
    assert.ok(error instanceof ServerPdfError);
    assert.equal(error.code, "PDF_ENCRYPTED");
    assert.equal(error.message.includes("private PDF.js detail"), false);
    return true;
  });
  assert.equal(metrics.destroyCalls, 1);
});

test("preserves unsupported classification from lazy page loading", async () => {
  for (const errorName of ["UnknownErrorException", "FormatError"]) {
    const { runtime, metrics } = fakeRuntime({
      getPageError: namedError(errorName),
    });
    const document = await createServerPdfOpener(runtime)("private.pdf");

    await assert.rejects(document.renderPage(1), (error: unknown) => {
      assert.ok(error instanceof ServerPdfError);
      assert.equal(error.code, "PDF_UNSUPPORTED");
      return true;
    });
    assert.equal(metrics.destroyCalls, 1);
  }
});

test("maps encoded image limits and releases page and canvas", async () => {
  const { runtime, metrics } = fakeRuntime({
    encodedBytes: MAX_PAGE_IMAGE_BYTES + 1,
  });
  const document = await createServerPdfOpener(runtime)("private.pdf");

  await assert.rejects(document.renderPage(1), (error: unknown) => {
    assert.ok(error instanceof ServerPdfError);
    assert.equal(error.code, "PDF_IMAGE_TOO_LARGE");
    return true;
  });
  assert.equal(metrics.pageCleanupCalls, 1);
  assert.deepEqual(
    { width: metrics.canvas?.width, height: metrics.canvas?.height },
    { width: 0, height: 0 },
  );
  assert.equal(metrics.destroyCalls, 1);
});

test("maps generic render failures and releases page and canvas", async () => {
  const { runtime, metrics } = fakeRuntime({ renderError: new Error("raw") });
  const document = await createServerPdfOpener(runtime)("private.pdf");

  await assert.rejects(document.renderPage(1), (error: unknown) => {
    assert.ok(error instanceof ServerPdfError);
    assert.equal(error.code, "PDF_RENDER_FAILED");
    return true;
  });
  assert.equal(metrics.pageCleanupCalls, 1);
  assert.deepEqual(
    { width: metrics.canvas?.width, height: metrics.canvas?.height },
    { width: 0, height: 0 },
  );
  assert.equal(metrics.destroyCalls, 1);
});

test("rejects page numbers outside the generated PDF bounds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "one-page.pdf");
  await writeFile(pdfPath, minimalPdfBytes());

  for (const pageNumber of [0, 2]) {
    const document = await openServerPdf(pdfPath);
    await assert.rejects(document.renderPage(pageNumber), (error: unknown) => {
      assert.ok(error instanceof ServerPdfError);
      assert.equal(error.code, "PDF_RENDER_FAILED");
      return true;
    });
    await document.destroy();
  }
});

test("concurrent destroy callers await one shared cleanup", async () => {
  const cleanup = deferred<void>();
  const { runtime, metrics } = fakeRuntime({ destroy: () => cleanup.promise });
  const document = await createServerPdfOpener(runtime)("private.pdf");
  const first = document.destroy();
  const second = document.destroy();
  let settled = 0;
  void first.finally(() => (settled += 1));
  void second.finally(() => (settled += 1));

  await Promise.resolve();
  assert.equal(metrics.destroyCalls, 1);
  assert.equal(settled, 0);
  cleanup.resolve();
  await Promise.all([first, second]);
  assert.equal(settled, 2);
});

test("repeated destroy callers observe the same cleanup rejection", async () => {
  const cleanup = deferred<void>();
  const failure = new Error("cleanup failed");
  const { runtime, metrics } = fakeRuntime({ destroy: () => cleanup.promise });
  const document = await createServerPdfOpener(runtime)("private.pdf");
  const first = document.destroy();
  const second = document.destroy();

  cleanup.reject(failure);
  const results = await Promise.allSettled([first, second]);
  assert.equal(metrics.destroyCalls, 1);
  assert.deepEqual(
    results.map((result) =>
      result.status === "rejected" ? result.reason : undefined,
    ),
    [failure, failure],
  );
});

test("render failure remains pending until shared cleanup resolves", async () => {
  const cleanup = deferred<void>();
  const { runtime, metrics } = fakeRuntime({
    renderError: new Error("raw"),
    destroy: () => cleanup.promise,
  });
  const document = await createServerPdfOpener(runtime)("private.pdf");
  const render = document.renderPage(1);
  let settled = false;
  void render.catch(() => (settled = true));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(metrics.destroyCalls, 1);
  assert.equal(metrics.pageCleanupCalls, 1);
  assert.equal(settled, false);
  cleanup.resolve();
  await assert.rejects(render, (error: unknown) => {
    assert.ok(error instanceof ServerPdfError);
    assert.equal(error.code, "PDF_RENDER_FAILED");
    return true;
  });
});

test("verification success prints exactly the allowed JSON shape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfPath = path.join(root, "one-page.pdf");
  const bytes = minimalPdfBytes();
  await writeFile(pdfPath, bytes);
  const result = await spawnVerifier(pdfPath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), [
    "byteSize",
    "fileName",
    "pageCount",
    "renderedImageSizes",
  ]);
  assert.deepEqual(output, {
    fileName: "one-page.pdf",
    byteSize: bytes.byteLength,
    pageCount: 1,
    renderedImageSizes: [
      { page: 1, byteSize: output.renderedImageSizes[0].byteSize, mimeType: "image/jpeg" },
    ],
  });
  assert.ok(output.renderedImageSizes[0].byteSize > 100);
});

test("verification failures do not print the private PDF path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privatePath = path.join(root, "private-document.pdf");
  const result = await spawnVerifier(privatePath);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
