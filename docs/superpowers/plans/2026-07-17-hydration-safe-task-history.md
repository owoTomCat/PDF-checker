# Hydration-Safe Task History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent React hydration mismatches while preserving browser-local audit task history.

**Architecture:** Render `AuditConsole` with the same empty task state on the server and during the browser's first render. Restore validated task history from `localStorage` only after mount with `useEffect`, leaving the existing persistence and audit pipeline unchanged.

**Tech Stack:** React 19, TypeScript, vinext/Next.js, Node.js test runner

## Global Constraints

- Keep the storage key `pdf-audit-workspace.tasks.v4` and existing task normalization unchanged.
- Do not disable SSR and do not suppress hydration warnings.
- Do not change the Qwen audit workflow, API contracts, or local history format.

---

### Task 1: Add the hydration regression and minimal fix

**Files:**
- Modify: `tests/rendered-html.test.mjs`
- Modify: `app/AuditConsole.tsx:3,178-186`

**Interfaces:**
- Consumes: `readStoredTasks(): AuditTaskDetail[]`
- Produces: hydration-safe `tasks: AuditTaskDetail[]` state restored after mount

- [ ] **Step 1: Write the failing source regression test**

Add these assertions after the existing `localStorage` assertion:

```js
assert.match(consoleSource, /useState<AuditTaskDetail\[\]>\(\[\]\)/);
assert.match(
  consoleSource,
  /useEffect\(\(\) => \{\s*const loadTimer = window\.setTimeout\(\(\) => \{\s*setTasks\(readStoredTasks\(\)\);\s*\}, 0\);\s*return \(\) => window\.clearTimeout\(loadTimer\);\s*\}, \[\]\)/s,
);
assert.doesNotMatch(
  consoleSource,
  /useState<AuditTaskDetail\[\]>\(readStoredTasks\)/,
);
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `npm run test:source`

Expected: FAIL because `AuditConsole` still initializes state with `readStoredTasks`.

- [ ] **Step 3: Implement the minimal hydration-safe initialization**

Change the React import to include `useEffect`, initialize `tasks` with `[]`, and restore history after mount:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const [tasks, setTasks] = useState<AuditTaskDetail[]>([]);

useEffect(() => {
  const loadTimer = window.setTimeout(() => {
    setTasks(readStoredTasks());
  }, 0);
  return () => window.clearTimeout(loadTimer);
}, []);
```

- [ ] **Step 4: Run the regression test and verify GREEN**

Run: `npm run test:source`

Expected: all source tests pass.

- [ ] **Step 5: Run complete verification**

Run: `npm run test:unit`, `npm run typecheck`, `npm run lint`, and `npm run build`.

Expected: every command exits with code 0 and no test failures, type errors, lint errors, or build failures.

- [ ] **Step 6: Verify the browser behavior**

Open the local page with one valid task already stored under `pdf-audit-workspace.tasks.v4`.

Expected: no hydration mismatch is logged, the SSR response starts at zero tasks, and the saved task appears after mount.

- [ ] **Step 7: Commit the fix**

```bash
git add tests/rendered-html.test.mjs app/AuditConsole.tsx docs/superpowers/plans/2026-07-17-hydration-safe-task-history.md
git commit -m "fix: hydrate task history after mount"
```
