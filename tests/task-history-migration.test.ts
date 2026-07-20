import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_MIGRATION_MARKER_KEY,
  LEGACY_TASK_STORAGE_KEY,
  migrateLegacyTaskHistory,
} from "../lib/client/task-history";
import type { AuditTaskDetail } from "../lib/types";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function legacyTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-1",
    fileName: "legacy.pdf",
    fileSize: 100,
    fileType: "application/pdf",
    status: "completed",
    outcome: "passed",
    model: "qwen3.7-plus",
    progress: 100,
    processedPages: 1,
    totalPages: 1,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:01:00.000Z",
    startedAt: "2026-07-18T00:00:00.000Z",
    completedAt: "2026-07-18T00:01:00.000Z",
    errorCode: null,
    errorMessage: null,
    issueCount: 0,
    summary: null,
    reportText: null,
    report: null,
    localAbsolutePath: "C:\\private\\case.pdf",
    fileBlob: { unsafe: true },
    ...overrides,
  };
}

test("migration imports only bounded terminal schema fields and writes the marker", async () => {
  const storage = new MemoryStorage();
  storage.setItem(
    LEGACY_TASK_STORAGE_KEY,
    JSON.stringify([
      legacyTask(),
      legacyTask({ id: "active", status: "rendering", outcome: null }),
      { id: "broken" },
    ]),
  );
  let imported: AuditTaskDetail[] = [];

  const result = await migrateLegacyTaskHistory(storage, async (tasks) => {
    imported = tasks;
    return tasks.length;
  });

  assert.equal(result.status, "imported");
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.id, "legacy-1");
  assert.equal(imported[0]?.pdfAvailable, false);
  assert.equal(imported[0]?.pdfExpiresAt, null);
  assert.equal("localAbsolutePath" in (imported[0] as object), false);
  assert.equal("fileBlob" in (imported[0] as object), false);
  assert.ok(storage.getItem(LEGACY_MIGRATION_MARKER_KEY));
});

test("marker makes migration idempotent without another service call", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_TASK_STORAGE_KEY, JSON.stringify([legacyTask()]));
  storage.setItem(LEGACY_MIGRATION_MARKER_KEY, "2026-07-20T00:00:00.000Z");
  let calls = 0;

  const result = await migrateLegacyTaskHistory(storage, async () => {
    calls += 1;
    return 1;
  });

  assert.equal(result.status, "already-migrated");
  assert.equal(calls, 0);
});

test("failed imports remain retryable but issue only one request per invocation", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_TASK_STORAGE_KEY, JSON.stringify([legacyTask()]));
  let calls = 0;
  const importer = async () => {
    calls += 1;
    throw new Error("offline");
  };

  await assert.rejects(migrateLegacyTaskHistory(storage, importer), /offline/);
  assert.equal(calls, 1);
  assert.equal(storage.getItem(LEGACY_MIGRATION_MARKER_KEY), null);
  await assert.rejects(migrateLegacyTaskHistory(storage, importer), /offline/);
  assert.equal(calls, 2);
});

test("malformed and byte-oversized storage are skipped permanently without calling the API", async () => {
  for (const raw of [
    "not-json",
    "x".repeat(1_000_001),
    JSON.stringify([legacyTask({ reportText: "中".repeat(400_000) })]),
  ]) {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_TASK_STORAGE_KEY, raw);
    let calls = 0;
    const result = await migrateLegacyTaskHistory(storage, async () => {
      calls += 1;
      return 0;
    });
    assert.equal(result.status, "skipped");
    assert.equal(calls, 0);
    assert.ok(storage.getItem(LEGACY_MIGRATION_MARKER_KEY));
  }
});
