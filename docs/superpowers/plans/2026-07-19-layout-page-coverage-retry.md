# Layout Page Coverage Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a structurally valid but page-incomplete Bailian layout response trigger the existing one-time model correction retry instead of immediately failing the PDF task.

**Architecture:** Build a request-scoped Zod schema inside the Bailian client that extends `LayoutBatchSchema` with exact page-set coverage. Pass a layout-specific correction message through the existing retry loop; retain the API route's current page comparison as defense in depth.

**Tech Stack:** TypeScript 5.9, Node.js 24, Zod 4, Node test runner, Next.js/Vinext, Alibaba Bailian compatible chat-completions API.

## Global Constraints

- Keep `qwen3.7-plus`, `MAX_MODEL_ATTEMPTS = 2`, six-page batches, and three-file concurrency unchanged.
- Never synthesize a missing page, skip it silently, or downgrade it to an empty page outside the model response.
- Do not log or persist the PDF, page images, API key, or raw model response.
- A page with no target regions is valid only when the model explicitly returns that page with `regions: []`.
- After the second incomplete response, return the existing stable `INVALID_MODEL_OUTPUT`/HTTP 502 behavior.

---

### Task 1: Reproduce Missing-Page Output in the Bailian Client

**Files:**
- Modify: `tests/bailian-client.test.ts`
- Test: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: `createBailianClient(options)` and `client.locateRegions(input)` from `lib/server/bailian-client.ts`.
- Produces: Regression expectations for exact requested-page coverage, two-attempt correction, and stable failure after the second incomplete response.

- [ ] **Step 1: Add a two-page layout input and complete output fixture**

Add beside `layoutInput`:

```ts
const twoPageLayoutInput = {
  ...layoutInput,
  totalPages: 2,
  pages: [
    layoutInput.pages[0],
    { pageNumber: 2, dataUrl: pageDataUrl },
  ],
};

const completeTwoPageLayout = {
  ...strictLayout,
  pages: [
    strictLayout.pages[0],
    {
      pageNumber: 2,
      regions: [],
      warnings: [],
      confidence: 0.99,
    },
  ],
};
```

- [ ] **Step 2: Add the failing correction-retry test**

```ts
test("retries a layout that omits one requested page", async () => {
  const bodies: string[] = [];
  const client = clientWithFetch(async (_url, init) => {
    bodies.push(String(init?.body));
    return modelResponse(
      bodies.length === 1 ? strictLayout : completeTwoPageLayout,
    );
  });

  const output = await client.locateRegions(twoPageLayoutInput);

  assert.deepEqual(
    output.pages.map((page) => page.pageNumber),
    [1, 2],
  );
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /\[1,2\]/);
  assert.match(bodies[1], /regions/);
});
```

- [ ] **Step 3: Add the failing retry-exhaustion test**

```ts
test("rejects a layout that still omits a requested page after correction", async () => {
  let calls = 0;
  const client = clientWithFetch(async () => {
    calls += 1;
    return modelResponse(strictLayout);
  });

  await assert.rejects(
    client.locateRegions(twoPageLayoutInput),
    (error: unknown) =>
      error instanceof BailianClientError &&
      error.code === "INVALID_MODEL_OUTPUT",
  );
  assert.equal(calls, 2);
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --import tsx --test tests/bailian-client.test.ts
```

Expected: the first new test returns only page 1 after one call, and the second new test resolves instead of rejecting. Existing tests remain green.

---

### Task 2: Move Exact Page Coverage Into the Model Retry Boundary

**Files:**
- Modify: `lib/server/bailian-client.ts`
- Test: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: `LayoutBatchSchema`, `LayoutModelInput`, `complete<T>()`, and `withCorrectionPrompt()`.
- Produces: internal `layoutBatchSchemaForPages(expectedPages)` and an optional correction detail accepted by `complete<T>()`.

- [ ] **Step 1: Add a request-scoped layout schema**

Add after `LayoutModelInputSchema`:

```ts
function layoutBatchSchemaForPages(expectedPageNumbers: readonly number[]) {
  const expected = [...expectedPageNumbers].sort((a, b) => a - b);
  return LayoutBatchSchema.superRefine((batch, context) => {
    const returned = batch.pages
      .map((page) => page.pageNumber)
      .sort((a, b) => a - b);
    const isExactMatch =
      expected.length === returned.length &&
      expected.every((pageNumber, index) => pageNumber === returned[index]);
    if (!isExactMatch) {
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "页面定位结果必须完整覆盖本批次请求页码。",
      });
    }
  });
}
```

- [ ] **Step 2: Allow a stage-specific correction detail**

Change `withCorrectionPrompt` to accept an optional detail and append it to the existing generic correction text:

```ts
function withCorrectionPrompt(
  request: BailianChatRequest,
  correctionDetail?: string,
): BailianChatRequest {
  const correction: TextContent = {
    type: "text",
    text: [
      "上一次响应未通过 JSON schema 校验。请严格按系统指定的 JSON 结构重新返回，不要增加字段。",
      correctionDetail,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n"),
  };
  const messages = request.messages.map((message, index) => {
    if (index !== request.messages.length - 1 || message.role !== "user") {
      return message;
    }
    if (typeof message.content === "string") {
      return {
        ...message,
        content: `${message.content}\n${correction.text}`,
      };
    }
    return { ...message, content: [...message.content, correction] };
  });
  return { ...request, messages };
}
```

- [ ] **Step 3: Thread the correction detail through `complete<T>()`**

Add the third parameter to the existing `complete<T>()` signature:

```ts
async function complete<T>(
  request: BailianChatRequest,
  schema: z.ZodType<T>,
  correctionDetail?: string,
): Promise<T>
```

Inside the existing retry branch, replace the current one-argument correction call with this exact statement:

```ts
activeRequest = withCorrectionPrompt(activeRequest, correctionDetail);
```

- [ ] **Step 4: Apply the dynamic schema only to layout recognition**

Replace the `locateRegions` implementation with:

```ts
locateRegions(input: LayoutModelInput): Promise<LayoutBatch> {
  const parsedInput = LayoutModelInputSchema.parse(input);
  const expectedPageNumbers = parsedInput.pages.map(
    (page) => page.pageNumber,
  );
  return complete(
    buildLayoutRequest(parsedInput),
    layoutBatchSchemaForPages(expectedPageNumbers),
    `页面定位结果必须包含页码 ${JSON.stringify(expectedPageNumbers)}，每页恰好返回一次；即使某页没有目标区域，也必须返回该页并将 regions 设置为空数组。`,
  );
},
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
node --import tsx --test tests/bailian-client.test.ts
```

Expected: all Bailian client tests pass; the two new tests report two upstream calls.

- [ ] **Step 6: Run all unit tests**

Run:

```powershell
npm run test:unit
```

Expected: every unit test passes with zero failures.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- lib/server/bailian-client.ts tests/bailian-client.test.ts
git commit -m "fix: retry incomplete layout page coverage"
```

---

### Task 3: Full Local Verification

**Files:**
- Verify: `lib/server/bailian-client.ts`
- Verify: `tests/bailian-client.test.ts`
- Verify: generated `dist/` output without committing it

**Interfaces:**
- Consumes: repository npm scripts and Node.js 24 runtime.
- Produces: fresh evidence that unit tests, source tests, type checking, linting, and production build pass.

- [ ] **Step 1: Run the complete test/build script on Node 24**

```powershell
$env:Path = 'C:\Users\10794\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
npm run test
```

Expected: unit tests, five-stage Vinext production build, and source tests all pass.

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

- [ ] **Step 4: Verify the committed diff and clean worktree**

```powershell
git diff HEAD^ --check
git status -sb
git log -2 --oneline
```

Expected: no whitespace errors; only the intended implementation commit follows the design commit; no uncommitted files.

---

### Task 4: Publish and Deploy the Immutable Release

**Files:**
- Publish: current branch commit to `origin/main`
- Deploy: `/opt/pdf-checker/releases/$commit`
- Switch: `/opt/pdf-checker/current`

**Interfaces:**
- Consumes: authenticated Git push, SSH key `C:\Users\10794\.ssh\codex_win_SH_pdf.pem`, server `ubuntu@124.221.73.13`.
- Produces: GitHub `main` and the active Tencent Cloud release pointing to the same commit.

- [ ] **Step 1: Push the reviewed commits to GitHub main**

```powershell
git push origin HEAD:main
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

Expected: the remote `main` hash equals local `HEAD`.

- [ ] **Step 2: Create and upload a commit archive**

```powershell
$commit = git rev-parse HEAD
$archive = "D:\Code\PPT\PDF-checker\pdf-checker-$commit.tar.gz"
git archive --format=tar.gz --output $archive $commit
scp -4 -i "$HOME\.ssh\codex_win_SH_pdf.pem" -o IdentitiesOnly=yes -o BatchMode=yes $archive "ubuntu@124.221.73.13:/tmp/pdf-checker-$commit.tar.gz"
```

Expected: archive upload exits 0 without including local environment files.

- [ ] **Step 3: Build the new release before switching**

Run over SSH using the exact `$commit` from Step 2:

```bash
sudo install -d -o ubuntu -g ubuntu "/opt/pdf-checker/releases/$commit"
tar -xzf "/tmp/pdf-checker-$commit.tar.gz" -C "/opt/pdf-checker/releases/$commit"
cd "/opt/pdf-checker/releases/$commit"
npm ci --no-audit --no-fund
npm run build
```

Expected: dependency installation and Node 24 production build finish successfully while the old release continues serving traffic.

- [ ] **Step 4: Atomically switch and restart**

```bash
sudo ln -sfn "/opt/pdf-checker/releases/$commit" /opt/pdf-checker/current.next
sudo mv -Tf /opt/pdf-checker/current.next /opt/pdf-checker/current
sudo systemctl restart pdf-checker
sudo systemctl is-active pdf-checker
readlink -f /opt/pdf-checker/current
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/
```

Expected: service is `active`, symlink resolves to the new commit, and HTTP status is 200.

---

### Task 5: Reprocess the Failed Eight-Page PDF and Verify the Full Chain

**Files:**
- Runtime input already held by the user's open browser tab: `（2026）沪0115民初36914号-1-外网溯源结果报告.pdf`
- Read-only evidence: browser task state and `/var/log/nginx/access.log`

**Interfaces:**
- Consumes: the open failed task's in-memory `File`, the deployed `/api/audit/*` routes, and real Bailian credentials on the server.
- Produces: a completed or rule-level review result that has passed every technical stage, plus request-log evidence.

- [ ] **Step 1: Reclaim the existing server tab without reloading it**

Use the browser runtime to claim the most recent `http://124.221.73.13/` tab. Do not reload, because the tab's in-memory file cache is needed by “重新处理”. Read a DOM snapshot and confirm the failed 8-page task is selected.

- [ ] **Step 2: Trigger one authorized reprocessing action**

From the fresh snapshot, locate the unique `重新处理` button, confirm its count is 1, click it once, and verify the task enters `渲染页面` or `定位证据区域`.

- [ ] **Step 3: Wait on task state rather than a fixed long sleep**

Poll a scoped task/result status at short intervals until it reaches `已完成`, `需人工复核`, `发现问题`, or `处理失败`. Capture console warnings/errors and the final `已处理 8 / 8 页` text.

- [ ] **Step 4: Verify server API stages**

```bash
sudo grep '/api/audit/' /var/log/nginx/access.log | tail -n 20
```

Expected: the reprocessed task's layout batches return 200 and subsequent applicable `recognize-evidence`, `review-url`, `extract-table`, `associate`, and `finalize` calls return 200. A rule-level `需人工复核` or `发现问题` result is acceptable; a technical `处理失败` is not.

- [ ] **Step 5: Final consistency check and cleanup**

Verify GitHub `main`, local `HEAD`, and `/opt/pdf-checker/current` share the same hash; remove only the locally created archive; finalize browser control while keeping the user's tab open.
