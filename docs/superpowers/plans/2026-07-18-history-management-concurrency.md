# History Management and Five-Way Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add searchable, time-filtered, individually and bulk-deletable browser history while processing at most five PDFs concurrently per upload batch.

**Architecture:** Move history collection operations and bounded concurrency into two pure client modules with direct Node tests. Keep `AuditConsole` responsible for browser persistence and UI state, but use functional task-state updates plus a post-hydration persistence effect so concurrent progress callbacks cannot overwrite each other.

**Tech Stack:** TypeScript 5.9, React 19, Node test runner, Next.js/vinext, browser `localStorage`.

## Global Constraints

- Keep storage key `pdf-audit-workspace.tasks.v4` and the existing `AuditTaskDetail` shape unchanged.
- Keep at most 80 persisted tasks sorted by descending `createdAt`.
- Use task `createdAt` for all time filters; a custom end date includes the entire selected day.
- Never delete tasks whose status is active.
- Process at most 5 PDFs concurrently; extra PDFs remain queued and begin when a slot is free.
- One task failure must not stop the remaining batch.
- Do not add server persistence, cancellation, new dependencies, or changes to the audit APIs.

---

### Task 1: Pure history collection operations

**Files:**
- Create: `lib/client/task-history.ts`
- Create: `tests/task-history.test.ts`

**Interfaces:**
- Consumes: `AuditTaskDetail` from `lib/types.ts`.
- Produces: `HistoryDateFilter`, `HistoryFilterOptions`, `filterHistoryTasks()`, `upsertHistoryTask()`, and `removeHistoryTasks()`.

- [ ] **Step 1: Write failing history tests**

Create `tests/task-history.test.ts` with this fixture helper and the following tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { AuditTaskDetail } from "../lib/types";
import {
  filterHistoryTasks,
  removeHistoryTasks,
  upsertHistoryTask,
} from "../lib/client/task-history";

function task(id: string, fileName: string, createdAt: Date): AuditTaskDetail {
  return {
    id,
    fileName,
    fileSize: 100,
    fileType: "application/pdf",
    status: "completed",
    outcome: "passed",
    model: "qwen3.7-plus",
    progress: 100,
    processedPages: 1,
    totalPages: 1,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    startedAt: createdAt.toISOString(),
    completedAt: createdAt.toISOString(),
    errorMessage: null,
    issueCount: 0,
    summary: null,
    reportText: null,
    report: null,
  };
}

const now = new Date(2026, 6, 18, 12, 0, 0);
const tasks = [
  task("today", "Alpha Report.pdf", new Date(2026, 6, 18, 9)),
  task("six-days-ago", "Beta.pdf", new Date(2026, 6, 12, 9)),
  task("custom-end", "Delta.pdf", new Date(2026, 5, 3, 23, 59)),
  task("custom-start", "Gamma.pdf", new Date(2026, 5, 1, 0)),
  task("old", "Archive.pdf", new Date(2026, 4, 1, 9)),
];

test("filters task names without case or surrounding-space sensitivity", () => {
  const filtered = filterHistoryTasks(tasks, {
    query: "  ALPHA  ",
    dateFilter: "all",
    customStart: "",
    customEnd: "",
  }, new Date(2026, 6, 18, 12));
  assert.deepEqual(filtered.map((item) => item.id), ["today"]);
});

test("combines preset and inclusive custom date filters", () => {
  const sevenDayOptions = {
    query: "",
    dateFilter: "7d" as const,
    customStart: "",
    customEnd: "",
  };
  const customOptions = {
    query: "",
    dateFilter: "custom" as const,
    customStart: "2026-06-01",
    customEnd: "2026-06-03",
  };
  assert.deepEqual(
    filterHistoryTasks(tasks, sevenDayOptions, now).map((task) => task.id),
    ["today", "six-days-ago"],
  );
  assert.deepEqual(
    filterHistoryTasks(tasks, customOptions, now).map((task) => task.id),
    ["custom-end", "custom-start"],
  );
});

test("upserts without losing concurrent tasks and removes only requested IDs", () => {
  const first = task("first", "First.pdf", new Date(2026, 6, 1));
  const second = task("second", "Second.pdf", new Date(2026, 6, 2));
  const updatedSecond = {
    ...second,
    status: "failed" as const,
    createdAt: new Date(2026, 6, 3).toISOString(),
  };
  const next = upsertHistoryTask([first, second], updatedSecond);
  assert.deepEqual(next.map((task) => task.id), ["second", "first"]);
  assert.deepEqual(removeHistoryTasks(next, new Set(["second"])).map((task) => task.id), ["first"]);
});

test("treats invalid custom dates as open boundaries and caps history at eighty", () => {
  assert.equal(filterHistoryTasks(tasks, {
    query: "",
    dateFilter: "custom",
    customStart: "invalid",
    customEnd: "",
  }, now).length, tasks.length);
  const many = Array.from({ length: 81 }, (_, index) =>
    task(String(index), `${index}.pdf`, new Date(2026, 0, index + 1)),
  );
  assert.equal(upsertHistoryTask(many.slice(1), many[0]).length, 80);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --import tsx --test tests/task-history.test.ts
```

Expected: FAIL because `lib/client/task-history.ts` does not exist.

- [ ] **Step 3: Implement the pure history module**

Create `lib/client/task-history.ts` with these exact exports:

```ts
export type HistoryDateFilter = "all" | "today" | "7d" | "30d" | "custom";

export type HistoryFilterOptions = {
  query: string;
  dateFilter: HistoryDateFilter;
  customStart: string;
  customEnd: string;
};

export function filterHistoryTasks(
  tasks: AuditTaskDetail[],
  options: HistoryFilterOptions,
  now?: Date,
): AuditTaskDetail[];

export function upsertHistoryTask(
  tasks: AuditTaskDetail[],
  task: AuditTaskDetail,
  limit?: number,
): AuditTaskDetail[];

export function removeHistoryTasks(
  tasks: AuditTaskDetail[],
  ids: ReadonlySet<string>,
): AuditTaskDetail[];
```

Parse `YYYY-MM-DD` custom dates as local calendar dates. Use `[start, endExclusive)` comparisons, with preset starts at local midnight for today, six days earlier for `7d`, and twenty-nine days earlier for `30d`.

- [ ] **Step 4: Run the history tests and verify GREEN**

Run the Step 2 command.

Expected: all history tests pass with no warnings.

- [ ] **Step 5: Commit Task 1**

```powershell
git add lib/client/task-history.ts tests/task-history.test.ts
git commit -m "feat: add history filtering utilities"
```

### Task 2: Bounded concurrency executor

**Files:**
- Create: `lib/client/concurrency.ts`
- Create: `tests/concurrency.test.ts`

**Interfaces:**
- Consumes: an item array, positive integer concurrency limit, and asynchronous worker.
- Produces: `runWithConcurrency<T, R>()` returning results in input order as `PromiseSettledResult<R>[]`.

- [ ] **Step 1: Write failing concurrency tests**

Create `tests/concurrency.test.ts` with real asynchronous workers that track `active` and `peakActive`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runWithConcurrency } from "../lib/client/concurrency";

function fulfilledValue<T>(result: PromiseSettledResult<T>) {
  assert.equal(result.status, "fulfilled");
  return result.value;
}

test("runs no more than five items concurrently and preserves result order", async () => {
  const items = [1, 2, 3, 4, 5, 6];
  let active = 0;
  let peakActive = 0;
  let releaseGate!: () => void;
  let reportFiveStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const fiveStarted = new Promise<void>((resolve) => { reportFiveStarted = resolve; });
  const run = runWithConcurrency(items, 5, async (item) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    if (active === 5) reportFiveStarted();
    await gate;
    active -= 1;
    return item * 2;
  });
  await fiveStarted;
  assert.equal(peakActive, 5);
  releaseGate();
  const results = await run;
  assert.deepEqual(results.map(fulfilledValue), items.map((item) => item * 2));
});

test("continues after one worker rejects", async () => {
  const results = await runWithConcurrency([1, 2, 3], 2, async (item) => {
    if (item === 2) throw new Error("expected failure");
    return item;
  });
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("handles empty input and rejects invalid limits", async () => {
  assert.deepEqual(await runWithConcurrency([], 1, async () => 1), []);
  await assert.rejects(
    runWithConcurrency([1], 0, async (item) => item),
    RangeError,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --import tsx --test tests/concurrency.test.ts
```

Expected: FAIL because `lib/client/concurrency.ts` does not exist.

- [ ] **Step 3: Implement the bounded worker pool**

Create the following interface in `lib/client/concurrency.ts`:

```ts
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]>;
```

Validate `limit` with `Number.isInteger(limit) && limit >= 1`. Allocate a result array matching input length, share a monotonically increasing next index between at most `Math.min(limit, items.length)` workers, catch each item error into a rejected result, and continue the loop.

- [ ] **Step 4: Run the concurrency tests and verify GREEN**

Run the Step 2 command.

Expected: all concurrency tests pass, peak activity is exactly five for six or more gated items, and later items run after a rejection.

- [ ] **Step 5: Commit Task 2**

```powershell
git add lib/client/concurrency.ts tests/concurrency.test.ts
git commit -m "feat: add bounded task concurrency"
```

### Task 3: Integrate concurrent task state and persistence

**Files:**
- Modify: `app/AuditConsole.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `runWithConcurrency()`, `upsertHistoryTask()`, existing `processTask()` and `readStoredTasks()`.
- Produces: functional concurrent task updates and a five-slot upload batch.

- [ ] **Step 1: Add failing source integration assertions**

Extend `tests/rendered-html.test.mjs` to assert:

```js
assert.match(consoleSource, /MAX_PARALLEL_TASKS\s*=\s*5/);
assert.match(consoleSource, /runWithConcurrency\(queuedTasks, MAX_PARALLEL_TASKS/);
assert.match(consoleSource, /setTasks\(\(current\)\s*=>\s*upsertHistoryTask\(current, task\)\)/);
assert.doesNotMatch(consoleSource, /for \(const task of queuedTasks\)/);
```

Add these exact persistence assertions:

```js
assert.match(consoleSource, /const \[historyReady, setHistoryReady\] = useState\(false\)/);
assert.match(consoleSource, /if \(!historyReady\) return/);
assert.match(consoleSource, /writeStoredTasks\(tasks\)/);
```

- [ ] **Step 2: Run the source test and verify RED**

Run:

```powershell
node --test tests/rendered-html.test.mjs
```

Expected: FAIL because the console still contains the serial task loop and no concurrency wiring.

- [ ] **Step 3: Replace storage-based upsert with functional state updates**

In `app/AuditConsole.tsx`:

- import `runWithConcurrency` and `upsertHistoryTask`;
- define `const MAX_PARALLEL_TASKS = 5`;
- replace `saveTask()` usage with `setTasks((current) => upsertHistoryTask(current, task))`;
- add `historyReady` state;
- finish initial `readStoredTasks()` hydration before setting `historyReady`;
- add an effect that writes the current `tasks` only when `historyReady` is true and catches storage errors by setting notice to `历史记录未能保存到浏览器。`.

- [ ] **Step 4: Replace the serial batch loop**

After creating all queued tasks and storing their `File` objects, call:

```ts
await runWithConcurrency(
  queuedTasks,
  MAX_PARALLEL_TASKS,
  async (task) => {
    const file = fileCacheRef.current.get(task.id);
    if (file) await processTask(task, file);
  },
);
```

Update the accepted-files notice to mention `最多同时处理 5 个`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --import tsx --test tests/concurrency.test.ts tests/task-history.test.ts
node --test tests/rendered-html.test.mjs
```

Expected: pure utility tests and source integration checks all pass.

- [ ] **Step 6: Commit Task 3**

```powershell
git add app/AuditConsole.tsx tests/rendered-html.test.mjs
git commit -m "feat: process five PDFs concurrently"
```

### Task 4: Add filtering, selection, and deletion UI

**Files:**
- Modify: `app/AuditConsole.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `filterHistoryTasks()`, `removeHistoryTasks()`, `ACTIVE_STATUSES`, and current task state.
- Produces: accessible history controls and deletion behavior persisted through the Task 3 effect.

- [ ] **Step 1: Add failing history-management source assertions**

Extend `tests/rendered-html.test.mjs` with these assertions:

```js
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
assert.doesNotMatch(consoleSource, /<button[\s\S]{0,160}className=\{`task-row/);
```

- [ ] **Step 2: Run the source test and verify RED**

Run:

```powershell
node --test tests/rendered-html.test.mjs
```

Expected: FAIL because the management controls are not rendered.

- [ ] **Step 3: Add filter and selection state**

In `AuditConsole`, add state for:

```ts
const [historyQuery, setHistoryQuery] = useState("");
const [historyDateFilter, setHistoryDateFilter] = useState<HistoryDateFilter>("all");
const [customStart, setCustomStart] = useState("");
const [customEnd, setCustomEnd] = useState("");
const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(new Set());
```

Compute `filteredTasks` with `filterHistoryTasks()`. Filter selection candidates through `!ACTIVE_STATUSES.has(task.status)`. Clear `checkedTaskIds` in every query/date input handler before updating the filter value.

- [ ] **Step 4: Implement deletion callbacks**

Create one `deleteTaskIds(ids)` callback that removes active IDs from the requested set, confirms the final count, removes files from `fileCacheRef`, calls `setTasks((current) => removeHistoryTasks(current, deletableIds))`, clears deleted checks, and resets `selectedId` when needed. Single-row deletion passes a one-ID set and includes the file name in its confirmation message.

- [ ] **Step 5: Render accessible management controls**

Add a search input, date preset select, conditional custom start/end date inputs, current-result count, select-all toggle, and bulk-delete button above the list. Render each task row as a container containing:

- an accessible checkbox disabled for active tasks;
- a dedicated button that selects/opens the task;
- a separate `删除任务：<fileName>` button disabled for active tasks.

Use `filteredTasks` for list rendering and selected-result fallback. Show distinct empty copy for no stored tasks versus no filter matches.

- [ ] **Step 6: Style desktop and mobile layouts**

In `app/globals.css`, add focused rules for `.history-controls`, `.history-search`, `.history-date-controls`, `.history-batch-bar`, `.task-check`, `.task-open`, and `.task-delete`. Preserve the current visual language and make controls stack or wrap below 620px.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Step 2 command plus:

```powershell
node --import tsx --test tests/task-history.test.ts
```

Expected: source checks and pure filter/delete tests pass.

- [ ] **Step 8: Commit Task 4**

```powershell
git add app/AuditConsole.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: manage task history in bulk"
```

### Task 5: Full verification and browser acceptance

**Files:**
- Modify only if an acceptance defect is reproduced with a failing test first.

**Interfaces:**
- Consumes: completed history UI, localStorage persistence, and five-slot worker pool.
- Produces: verified local feature ready for branch integration.

- [ ] **Step 1: Run static and full automated verification**

Using bundled Node 24, run:

```powershell
npm run typecheck
npm test
```

Expected: zero type errors; all unit tests, vinext production build, and source checks pass.

- [ ] **Step 2: Start or restart the development server**

Run `npm run dev` at `http://localhost:3000`, confirm the page returns HTTP 200, and verify `.env.local` remains untracked.

- [ ] **Step 3: Verify history management in the browser**

Seed or create history with different names and dates. Confirm search, each preset, custom inclusive range, no-results copy, selection reset on filter change, select all current results, single deletion, bulk deletion, and persistence after refresh. Confirm active rows cannot be checked or deleted.

- [ ] **Step 4: Verify five-way concurrency in the browser**

Upload at least six small valid PDFs. Observe that five advance beyond `queued` before the sixth, no more than five model pipelines are active at once, and the sixth starts after a slot completes. Confirm a failed task does not block remaining queued tasks.

- [ ] **Step 5: Inspect runtime evidence**

Confirm browser error logs are empty, no hydration warning appears, and server logs show successful concurrent route calls without unhandled errors.

- [ ] **Step 6: Final clean-state check**

Run:

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: no unstaged or uncommitted implementation changes and the feature commits appear at branch HEAD.
