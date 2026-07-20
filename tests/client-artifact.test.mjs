import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const clientRoot = path.resolve("dist/client");

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

test("built client contains no browser PDF renderer or worker", async () => {
  const files = await filesBelow(clientRoot);
  assert.equal(files.some((file) => /pdf\.worker/i.test(path.basename(file))), false);
  const textFiles = files.filter((file) => /\.(?:css|html|js|json|mjs|txt)$/i.test(file));
  const sources = await Promise.all(textFiles.map((file) => readFile(file, "utf8")));
  assert.doesNotMatch(
    sources.join("\n"),
    /pdfjs-dist|openPdfForRendering|runAiAuditPipeline|client\/pdf-renderer/i,
  );
});
