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
    pipelineSource,
    rendererSource,
    readme,
    specification,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AuditConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/audit-pipeline.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/pdf-renderer.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/spec-qwen-ai-pipeline.md", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /title:\s*"PDF 外网溯源报告核验"/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(page, /<AuditConsole \/>/);
  assert.match(consoleSource, /外网溯源结果报告自动核验台/);
  assert.match(consoleSource, /runAiAuditPipeline/);
  assert.match(consoleSource, /localStorage/);
  assert.match(consoleSource, /useState<AuditTaskDetail\[\]>\(\[\]\)/);
  assert.match(consoleSource, /MAX_PARALLEL_TASKS\s*=\s*5/);
  assert.match(
    consoleSource,
    /runWithConcurrency\(\s*queuedTasks,\s*MAX_PARALLEL_TASKS/,
  );
  assert.match(
    consoleSource,
    /setTasks\(\(current\)\s*=>\s*upsertHistoryTask\(current, task\)\)/,
  );
  assert.match(
    consoleSource,
    /const \[historyReady, setHistoryReady\] = useState\(false\)/,
  );
  assert.match(consoleSource, /if \(!historyReady\) return/);
  assert.match(consoleSource, /writeStoredTasks\(tasks\)/);
  assert.doesNotMatch(consoleSource, /for \(const task of queuedTasks\)/);
  for (const copy of [
    "搜索任务名称",
    "时间范围",
    "全选当前结果",
    "批量删除",
    "删除任务",
  ]) {
    assert.match(consoleSource, new RegExp(copy));
  }
  assert.match(consoleSource, /filterHistoryTasks\(/);
  assert.match(consoleSource, /removeHistoryTasks\(/);
  assert.match(consoleSource, /className="task-open"/);
  assert.match(consoleSource, /className="task-delete"/);
  assert.doesNotMatch(
    consoleSource,
    /<button[\s\S]{0,160}className=\{`task-row/,
  );
  assert.match(
    consoleSource,
    /useEffect\(\(\) => \{\s*const loadTimer = window\.setTimeout\(\(\) => \{\s*setTasks\(readStoredTasks\(\)\);\s*setHistoryReady\(true\);\s*\}, 0\);\s*return \(\) => window\.clearTimeout\(loadTimer\);\s*\}, \[\]\)/s,
  );
  assert.doesNotMatch(
    consoleSource,
    /useState<AuditTaskDetail\[\]>\(readStoredTasks\)/,
  );
  assert.match(consoleSource, /qwen3\.7-plus/);
  assert.match(consoleSource, /定位用页面图/);
  assert.match(consoleSource, /阿里云百炼/);
  assert.match(consoleSource, /需人工复核/);
  assert.match(consoleSource, /问题列表/);
  assert.match(consoleSource, /人工复核项/);
  assert.match(consoleSource, /pdf-audit-workspace\.tasks\.v4/);
  for (const endpoint of [
    "layout",
    "recognize-evidence",
    "review-url",
    "extract-table",
    "associate",
  ]) {
    assert.match(pipelineSource, new RegExp(`/api/audit/${endpoint}`));
  }
  assert.match(pipelineSource, /\/api\/audit\/finalize/);
  assert.doesNotMatch(pipelineSource, /\/api\/audit\/extract["']/);
  assert.match(readme, /截图裁剪看不到汇总表/);
  assert.match(readme, /600 DPI/);
  assert.match(readme, /彩色.*灰度|灰度.*彩色/s);
  assert.match(specification, /\/api\/audit\/review-url/);
  assert.doesNotMatch(specification, /POST \/api\/audit\/extract\s/);
  assert.doesNotMatch(rendererSource, /getTextContent/);
  assert.doesNotMatch(consoleSource, /runAuditFromPdf/);
  assert.doesNotMatch(consoleSource, /PDF 不会上传到服务器/);
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

test("removes the legacy local parser and D1/R2 task routes", async () => {
  const legacyPaths = [
    "../lib/pdf-text-extractor.ts",
    "../lib/audit-runner.ts",
    "../lib/server/storage.ts",
    "../app/api/tasks/route.ts",
    "../app/api/tasks/[id]/route.ts",
    "../app/api/tasks/[id]/run/route.ts",
  ];

  for (const path of legacyPaths) {
    await assert.rejects(access(new URL(path, import.meta.url)));
  }
});

test("uses a cross-platform vinext launcher", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.scripts.dev, "node scripts/run-vinext.mjs dev");
  assert.equal(packageJson.scripts.build, "node scripts/run-vinext.mjs build");
  assert.equal(packageJson.scripts.start, "node scripts/run-vinext.mjs start");
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /WRANGLER_LOG_PATH=/);
});
