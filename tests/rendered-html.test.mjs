import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);

test("defines the PDF audit workspace UI and metadata", async () => {
  const [page, layout, consoleSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AuditConsole.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /title:\s*"PDF 外网溯源报告核验"/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(page, /<AuditConsole \/>/);
  assert.match(consoleSource, /外网溯源结果报告自动核验台/);
  assert.match(consoleSource, /Promise\.all/);
  assert.match(consoleSource, /localStorage/);
  assert.match(consoleSource, /PDF 不会上传到服务器/);
  assert.doesNotMatch(consoleSource, /\/api\/tasks/);
  assert.doesNotMatch(page + layout + consoleSource, /codex-preview|react-loading-skeleton/);
});

test("removes the disposable starter preview", async () => {
  await assert.rejects(
    access(previewRoot),
  );
  await assert.rejects(
    access(new URL("public/_sites-preview", templateRoot)),
  );
});
