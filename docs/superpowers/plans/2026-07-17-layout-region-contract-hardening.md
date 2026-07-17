# Layout Region Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject incomplete or semantically impossible layout regions before evidence recognition and guide Qwen to omit non-web images.

**Architecture:** Keep the existing five-stage pipeline and retry mechanism. Make the layout prompt precise enough to distinguish report artifacts, and encode the same structural rules in Zod so malformed model output triggers the existing correction retry at the producer boundary.

**Tech Stack:** TypeScript, Zod 4, Node test runner, Next.js/vinext, Qwen `qwen3.7-plus`.

## Global Constraints

- Preserve strict evidence isolation and deterministic screenshot-to-table association.
- Do not infer missing rights-image or result indices.
- Keep the evidence API rejection behavior unchanged.
- Use the existing single correction retry for invalid model JSON.

---

### Task 1: Add layout contract regression coverage

**Files:**
- Modify: `tests/ai-contracts.test.ts`
- Modify: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: `LayoutBatchSchema`, `LAYOUT_SYSTEM_PROMPT`, `createBailianClient()`.
- Produces: regression tests for region invariants, prompt exclusions, and invalid-layout retry.

- [ ] **Step 1: Write failing schema tests**

Add cases that reject a `rights_screenshot` with a null index, a `certificate` or `summary_table` with non-null indices, and an `address_bar` whose indices differ from its parent.

- [ ] **Step 2: Write failing prompt and retry tests**

Assert that the prompt excludes standalone rights images, comparison images, and case information tables. Return an invalid screenshot region on the first mocked model call and `strictLayout` on the second, then assert two calls.

- [ ] **Step 3: Run the focused tests to verify failure**

Run: `npm run test:unit -- --test-name-pattern="layout|prompt|index|indices"`

Expected: the newly added assertions fail because the current schema accepts incomplete indices and the prompt lacks the exclusions.

### Task 2: Enforce type-specific layout invariants

**Files:**
- Modify: `lib/ai/contracts.ts`

**Interfaces:**
- Consumes: existing `PageLayoutSchema` and its per-page `byId` map.
- Produces: `LayoutBatchSchema` that rejects structurally unusable regions.

- [ ] **Step 1: Implement minimal schema validation**

Within `PageLayoutSchema.superRefine`, require null indices for `certificate` and `summary_table`, require both indices for `rights_screenshot`, and require an `address_bar` to match both parent indices.

- [ ] **Step 2: Run the contract and client tests**

Run: `npm run test:unit -- --test-name-pattern="layout|index|indices|correction"`

Expected: schema and invalid-layout retry tests pass; prompt assertions still fail.

### Task 3: Clarify the layout prompt

**Files:**
- Modify: `lib/ai/prompts.ts`

**Interfaces:**
- Consumes: the four existing layout region types.
- Produces: an unambiguous model instruction aligned with `PageLayoutSchema`.

- [ ] **Step 1: Add type definitions and exclusions**

Define complete web screenshots and detailed result summary tables, list excluded report artifacts, state all index rules, and direct the model to omit uncertain regions with a warning.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:unit -- --test-name-pattern="layout|prompt|index|indices|correction"`

Expected: all focused tests pass.

### Task 4: Verify and exercise the real case

**Files:**
- No production file changes expected.

**Interfaces:**
- Consumes: local dev server, configured `.env.local`, and the 4-page test PDF.
- Produces: completed browser audit report or concrete evidence for the next defect.

- [ ] **Step 1: Run static and full test verification**

Run: `npm run typecheck` and `npm test` under bundled Node 24.

Expected: zero type errors; all unit, build, and source checks pass.

- [ ] **Step 2: Restart the development server**

Restart `npm run dev` so the corrected Base URL and new server code are loaded.

- [ ] **Step 3: Reprocess the real PDF**

Upload `D:\Code\PPT\本地测试案例\7.17\（2026）苏0281民初7549号-3-外网溯源结果报告.pdf`, wait for all model stages, and confirm the UI reaches a final audit outcome instead of the metadata error.

- [ ] **Step 4: Inspect logs and browser console**

Confirm API requests complete without unhandled server errors and browser console contains no application errors.

### Task 5: Normalize evidence bookkeeping IDs

**Files:**
- Modify: `app/api/audit/recognize-evidence/route.ts`
- Modify: `lib/ai/prompts.ts`
- Test: `tests/audit-api.test.ts`
- Test: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: validated evidence `regionId` values returned for requested regions.
- Produces: `screenshotId` values deterministically equal to their verified `regionId`.

- [ ] **Step 1: Add a failing API test for a model-provided example screenshot ID**

Return `screenshotId: "screenshot-1"` with a valid `regionId: "page-3-screenshot-1"`, then require HTTP 200 and the page-scoped ID in the response.

- [ ] **Step 2: Normalize the redundant ID and clarify the prompt**

Set each response `screenshotId` from its validated `regionId`; require the evidence model to copy all `REGION_META` identifiers instead of the JSON example.

- [ ] **Step 3: Run focused and full verification**

Run the two regression tests, `npm run typecheck`, and `npm test`.

Expected: the regression tests pass and the full suite stays green.

### Task 6: Make cross-page association deterministic

**Files:**
- Modify: `app/api/audit/associate/route.ts`
- Modify: `lib/ai/prompts.ts`
- Test: `tests/audit-api.test.ts`
- Test: `tests/bailian-client.test.ts`

**Interfaces:**
- Consumes: screenshot and table-row locators containing `rightsImageIndex` and `resultIndex`.
- Produces: a one-to-one mapping when the locator pair is unique on both sides, regardless of physical page number.

- [ ] **Step 1: Add a failing cross-page association test**

Provide a page-3 screenshot and page-2 table row with the same `(1, 1)` locator while the mocked model returns `null`; require the API to return `table-row-1` at confidence 1 with no warning.

- [ ] **Step 2: Implement unique-key association and prompt rules**

Use `(rightsImageIndex, resultIndex)` as the deterministic key. Map only when unique on both sides; otherwise return `null` and a stable warning. State explicitly that different pages do not conflict.

- [ ] **Step 3: Re-run the real PDF**

Expected: every API stage returns HTTP 200, no cross-page warning remains, and the final report contains the actual deterministic comparison result.
