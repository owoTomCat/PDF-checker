import assert from "node:assert/strict";
import test from "node:test";
import { runWithConcurrency } from "../lib/client/concurrency";

function fulfilledValue<T>(result: PromiseSettledResult<T>) {
  if (result.status !== "fulfilled") throw result.reason;
  return result.value;
}

test("runs no more than five items concurrently and preserves result order", async () => {
  const items = [1, 2, 3, 4, 5, 6];
  let active = 0;
  let peakActive = 0;
  let releaseGate!: () => void;
  let reportFiveStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const fiveStarted = new Promise<void>((resolve) => {
    reportFiveStarted = resolve;
  });

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
  const visited: number[] = [];
  const results = await runWithConcurrency([1, 2, 3], 2, async (item) => {
    visited.push(item);
    if (item === 2) throw new Error("expected failure");
    return item;
  });

  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.deepEqual(visited.sort(), [1, 2, 3]);
});

test("handles empty input and rejects invalid limits", async () => {
  assert.deepEqual(await runWithConcurrency([], 1, async () => 1), []);
  await assert.rejects(
    runWithConcurrency([1], 0, async (item) => item),
    RangeError,
  );
  await assert.rejects(
    runWithConcurrency([1], 1.5, async (item) => item),
    RangeError,
  );
});
