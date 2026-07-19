# Layout Warning Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop correctly excluded non-target PDF content from creating layout warnings that incorrectly downgrade otherwise complete zero-issue audits to manual review.

**Architecture:** Keep the existing layout JSON schema and strict finalizer unchanged. Tighten `LAYOUT_SYSTEM_PROMPT` so an empty region set is a confident normal result for clearly irrelevant pages, while warnings remain reserved for likely target evidence that cannot be reliably located or classified.

**Tech Stack:** TypeScript 5.9, Node.js 24, Node test runner, Next.js/Vinext, Alibaba Bailian compatible chat-completions API, Git, systemd, Nginx.

## Global Constraints

- Do not classify an independent rights image or comparison image as `rights_screenshot`.
- Do not classify a case-information table as `summary_table`.
- Do not filter model warnings by English text, ignore all empty-page warnings, or loosen the finalizer's `warnings.length === 0` completeness requirement.
- A warning is allowed only when a likely target region is uncertain because of clarity, occlusion, bounds, type, or required numbering.
- All model-generated layout warnings must be concise Chinese.
- Existing browser history is immutable; the real case must be reprocessed after deployment.
- Never log, persist, commit, or print the PDF, rendered page images, raw model response, `.env.local`, or `DASHSCOPE_API_KEY`.

---

### Task 1: Add Prompt Contract Regression Assertions

**Files:**
- Modify: `tests/bailian-client.test.ts`
- Test: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: exported `LAYOUT_SYSTEM_PROMPT` from `lib/ai/prompts.ts`.
- Produces: regression assertions for harmless exclusion, empty-page confidence semantics, real-warning conditions, and Chinese warning language.

- [ ] **Step 1: Add the failing assertions**

In `test("builds five isolated qwen3.7-plus JSON requests", ...)`, add these assertions after the existing `summary_table` classification assertion:

```ts
  assert.match(
    LAYOUT_SYSTEM_PROMPT,
    /只包含独立权利图、图片对比区域[\s\S]+regions 和 warnings 均返回空数组/,
  );
  assert.match(
    LAYOUT_SYSTEM_PROMPT,
    /不得仅因页面没有 certificate、rights_screenshot 或 summary_table 而生成告警/,
  );
  assert.match(
    LAYOUT_SYSTEM_PROMPT,
    /明确确认页面没有目标区域[\s\S]+可以返回高置信度/,
  );
  assert.match(
    LAYOUT_SYSTEM_PROMPT,
    /可能存在目标区域[\s\S]+无法可靠定位[\s\S]+warnings/,
  );
  assert.match(LAYOUT_SYSTEM_PROMPT, /warnings 必须使用简洁中文/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --import tsx --test tests/bailian-client.test.ts
```

Expected: the prompt-contract test fails on the first new unmatched regular expression; no TypeScript compilation error occurs.

---

### Task 2: Define Harmless Exclusion and Real Warning Semantics

**Files:**
- Modify: `lib/ai/prompts.ts`
- Test: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: the existing `LAYOUT_SYSTEM_PROMPT` string and unchanged layout response schema.
- Produces: prompt rules that return `{ regions: [], warnings: [], confidence: high }` for confidently irrelevant pages and preserve warnings for uncertain target evidence.

- [ ] **Step 1: Add the minimal prompt rules**

Replace the current layout rules 9 line with the following rules, preserving rules 1-8 exactly:

```ts
9. 页面只包含独立权利图、图片对比区域、封面、报告标题、案件基本信息表或其他明确不属于上述四类目标区域的内容时，该页 regions 和 warnings 均返回空数组。
10. 不得仅因页面没有 certificate、rights_screenshot 或 summary_table 而生成告警，也不得把“没有有效区域”本身写成告警。
11. 只有页面中可能存在目标区域，但由于清晰度、遮挡、边界、类型或必需序号不确定而无法可靠定位时，才写入 warnings 并降低 confidence。
12. confidence 表示对该页定位结果完整性和分类正确性的把握；若能明确确认页面没有目标区域，可以返回高置信度。
13. warnings 必须使用简洁中文，明确说明需要人工核对的目标区域和原因。
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```powershell
node --import tsx --test tests/bailian-client.test.ts
```

Expected: every Bailian client test passes with zero failures.

- [ ] **Step 3: Confirm prohibited filtering was not introduced**

Run:

```powershell
git diff -- lib/ai/prompts.ts tests/bailian-client.test.ts
```

Expected: the implementation changes only prompt text and prompt-contract assertions; `lib/audit-result.ts`, schemas, pipeline aggregation, and UI warning rendering remain unchanged.

- [ ] **Step 4: Commit the implementation**

```powershell
git add -- lib/ai/prompts.ts tests/bailian-client.test.ts
git commit -m "fix: distinguish harmless layout exclusions"
```

Expected: one implementation commit containing only the two intended files.

---

### Task 3: Run Full Local Verification

**Files:**
- Verify: `lib/ai/prompts.ts`
- Verify: `tests/bailian-client.test.ts`
- Verify: generated build output without committing it

**Interfaces:**
- Consumes: repository npm scripts and bundled Node.js 24 runtime.
- Produces: fresh evidence that unit tests, source tests, type checking, linting, and production build all pass.

- [ ] **Step 1: Run the full test and production build sequence on Node 24**

```powershell
$env:Path = 'C:\Users\10794\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
npm test
```

Expected: unit tests, the five-stage Vinext build, and source tests finish with zero failures.

- [ ] **Step 2: Run type checking**

```powershell
npm run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run linting**

```powershell
npm run lint
```

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 4: Verify repository state**

```powershell
git diff HEAD^ --check
git status --short
git log -3 --oneline
```

Expected: no whitespace errors, no uncommitted generated files, and the implementation commit follows the approved design and plan commits.

---

### Task 4: Publish and Deploy the Immutable Release

**Files:**
- Publish: current branch commit to `origin/main`
- Deploy: `/opt/pdf-checker/releases/$commit`
- Switch: `/opt/pdf-checker/current`

**Interfaces:**
- Consumes: authenticated Git push, SSH key `C:\Users\10794\.ssh\codex_win_SH_pdf.pem`, and server `ubuntu@124.221.73.13`.
- Produces: GitHub `main` and the active Tencent Cloud release at the same commit.

- [ ] **Step 1: Push the verified commit to GitHub main**

```powershell
git push origin HEAD:main
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

Expected: remote `main` equals local `HEAD`.

- [ ] **Step 2: Create and upload an archive of the exact commit**

```powershell
$commit = git rev-parse HEAD
$archive = "D:\Code\PPT\PDF-checker\pdf-checker-$commit.tar.gz"
git archive --format=tar.gz --output $archive $commit
scp -4 -i "$HOME\.ssh\codex_win_SH_pdf.pem" -o IdentitiesOnly=yes -o BatchMode=yes $archive "ubuntu@124.221.73.13:/tmp/pdf-checker-$commit.tar.gz"
```

Expected: upload exits 0 and the archive contains no local environment file.

- [ ] **Step 3: Build the new release before switching**

Run over SSH using the exact commit from Step 2:

```bash
sudo install -d -o ubuntu -g ubuntu "/opt/pdf-checker/releases/$commit"
tar -xzf "/tmp/pdf-checker-$commit.tar.gz" -C "/opt/pdf-checker/releases/$commit"
cd "/opt/pdf-checker/releases/$commit"
npm ci --no-audit --no-fund
npm run build
```

Expected: installation and Node 24 production build complete while the previous release remains active.

- [ ] **Step 4: Atomically switch the release and restart**

```bash
sudo ln -sfn "/opt/pdf-checker/releases/$commit" /opt/pdf-checker/current.next
sudo mv -Tf /opt/pdf-checker/current.next /opt/pdf-checker/current
sudo systemctl restart pdf-checker
sudo systemctl is-active pdf-checker
readlink -f /opt/pdf-checker/current
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/
```

Expected: service is `active`, the symlink resolves to the new commit, and HTTP status is 200.

---

### Task 5: Reprocess the Four-Page Regression Case

**Files:**
- Runtime browser input: `（2026）沪0115民初36914号-2-外网溯源结果报告.pdf`
- Read-only evidence: browser task state and `/var/log/nginx/access.log`

**Interfaces:**
- Consumes: the user's existing server page, deployed `/api/audit/*` routes, and real Bailian credentials.
- Produces: a completed zero-issue result without the two harmless layout warnings, plus server request evidence.

- [ ] **Step 1: Reclaim the existing server tab without reloading**

Use the browser runtime to claim the most recent `http://124.221.73.13/` tab. Read a DOM snapshot and select the latest four-page task named `（2026）沪0115民初36914号-2-外网溯源结果报告.pdf`. Do not reload because the browser's in-memory file is needed by “重新处理”.

- [ ] **Step 2: Trigger one reprocessing action**

Locate the unique `重新处理` button in the selected task, confirm its count is 1, click it once, and verify the task enters a processing state.

- [ ] **Step 3: Wait for the terminal task state**

Poll scoped task/result state at short intervals until it reaches `核验通过`, `需人工复核`, `发现问题`, or `处理失败`. Capture console warnings/errors and verify `已处理 4 / 4 页`.

- [ ] **Step 4: Verify the expected result and full API chain**

Expected browser result:

```text
核验通过 · 0 项
```

The “处理警告” section must not contain the former Page 1/Page 4 English messages. Over SSH, run:

```bash
sudo grep '/api/audit/' /var/log/nginx/access.log | tail -n 20
```

Expected: layout, recognize-evidence, review-url, extract-table, associate, and finalize requests return HTTP 200. If a new genuine low-confidence or incomplete-evidence reason appears, preserve it and report the exact reason instead of suppressing it.

- [ ] **Step 5: Verify release consistency and clean the local archive**

Confirm local `HEAD`, GitHub `main`, and `/opt/pdf-checker/current` use the same commit. Remove only the exact local archive created in Task 4, then finalize browser control while leaving the user's tab open.
