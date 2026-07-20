import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);

test("defines the strict Qwen PDF audit workspace UI and metadata", async () => {
  const [
    page,
    layout,
    consoleSource,
    auditPipelineSource,
    taskApiSource,
    taskHookSource,
    taskCoordinatorSource,
    readme,
    specification,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AuditConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/audit/pipeline.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/task-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/useAuditTasks.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/task-coordinator.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/spec-qwen-ai-pipeline.md", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /title:\s*"PDF 外网溯源报告核验"/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(page, /<AuditConsole \/>/);
  assert.match(consoleSource, /外网溯源结果报告自动核验台/);
  assert.match(consoleSource, /useAuditTasks\(/);
  assert.doesNotMatch(consoleSource, /runAiAuditPipeline|fileCacheRef|pdfjs-dist/);
  assert.doesNotMatch(consoleSource, /readStoredTasks|writeStoredTasks|createQueuedTask|processTask/);
  for (const copy of [
    "搜索任务名称",
    "时间范围",
    "全选当前结果",
    "批量删除",
    "删除任务",
  ]) {
    assert.match(consoleSource, new RegExp(copy));
  }
  assert.match(consoleSource, /服务器历史/);
  assert.match(consoleSource, /className="task-open"/);
  assert.match(consoleSource, /className="task-delete"/);
  assert.doesNotMatch(
    consoleSource,
    /<button[\s\S]{0,160}className=\{`task-row/,
  );
  assert.match(consoleSource, /qwen3\.7-plus/);
  assert.match(consoleSource, /私密上传到服务器/);
  assert.match(consoleSource, /72\s*小时/);
  assert.match(consoleSource, /阿里云百炼/);
  assert.match(consoleSource, /需人工复核/);
  assert.match(consoleSource, /问题列表/);
  assert.match(consoleSource, /人工复核项/);
  assert.match(taskHookSource, /localStorage/);
  assert.match(taskApiSource, /\/api\/tasks/);
  assert.match(taskCoordinatorSource, /2_000|2000/);
  assert.match(taskCoordinatorSource, /5_000|5000/);
  assert.match(taskHookSource, /250/);
  assert.match(taskHookSource, /deletedVersionRef\.current\.has\(incoming\.id\)/);
  assert.match(consoleSource, /return loadTaskDetails\(selectedTaskId\)/);
  assert.match(auditPipelineSource, /export async function runAuditPipeline/);
  assert.doesNotMatch(
    auditPipelineSource,
    /\bfetch\b|\bwindow\b|defaultOpenPdf|pdf-renderer|FormData|new File/,
  );
  assert.match(readme, /截图裁剪看不到汇总表/);
  assert.match(readme, /600 DPI/);
  assert.match(readme, /彩色.*灰度|灰度.*彩色/s);
  assert.match(specification, /\/api\/audit\/review-url/);
  assert.doesNotMatch(specification, /POST \/api\/audit\/extract\s/);
  assert.doesNotMatch(consoleSource, /runAuditFromPdf/);
  assert.doesNotMatch(consoleSource, /PDF 不会上传到服务器/);
  assert.match(taskHookSource + taskApiSource, /\/api\/tasks/);
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

test("removes the legacy local parser, storage adapter, and run route", async () => {
  const legacyPaths = [
    "../lib/pdf-text-extractor.ts",
    "../lib/audit-runner.ts",
    "../lib/server/storage.ts",
    "../app/api/tasks/[id]/run/route.ts",
    "../lib/client/pdf-renderer.ts",
  ];

  for (const path of legacyPaths) {
    await assert.rejects(access(new URL(path, import.meta.url)));
  }
});

test("uses a cross-platform vinext launcher", async () => {
  const [packageSource, launcher] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-vinext.mjs", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.scripts.dev, "node scripts/run-vinext.mjs dev");
  assert.equal(packageJson.scripts["build:web"], "node scripts/run-vinext.mjs build");
  assert.equal(packageJson.scripts["build:worker"], "vite build --config vite.worker.config.ts");
  assert.equal(packageJson.scripts.build, "npm run build:web && npm run build:worker");
  assert.equal(packageJson.scripts.start, "node scripts/run-vinext.mjs start");
  assert.equal(packageJson.scripts["start:worker"], "node dist/audit-worker.mjs");
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /WRANGLER_LOG_PATH=/);
  assert.match(launcher, /process\.execPath/);
  assert.match(launcher, /"vinext",\s*"dist",\s*"cli\.js"/s);
  assert.doesNotMatch(launcher, /ComSpec|vinext\.cmd/);
});
