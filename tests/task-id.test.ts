import assert from "node:assert/strict";
import test from "node:test";
import { createTaskId } from "../lib/client/task-id";

test("uses crypto.randomUUID when the browser provides it", () => {
  const id = createTaskId({
    randomUUID: () => "12345678-1234-4234-8234-123456789abc",
  });

  assert.equal(id, "12345678-1234-4234-8234-123456789abc");
});

test("creates a UUID when randomUUID is unavailable on an HTTP page", () => {
  let nextByte = 0;
  const id = createTaskId({
    getRandomValues: (bytes) => {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = nextByte;
        nextByte += 1;
      }
      return bytes;
    },
  });

  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
