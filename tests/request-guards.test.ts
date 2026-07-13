import assert from "node:assert/strict";
import test from "node:test";
import {
  RequestGuardError,
  assertModelRequestAllowed,
} from "../lib/server/request-guards";

test("accepts a same-origin request when authentication is not required", () => {
  const request = new Request("https://audit.example.com/api/audit/extract", {
    method: "POST",
    headers: { origin: "https://audit.example.com" },
  });

  assert.doesNotThrow(() =>
    assertModelRequestAllowed(request, { requireAuth: false }),
  );
});

test("rejects a cross-origin model request", () => {
  const request = new Request("https://audit.example.com/api/audit/extract", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });

  assert.throws(
    () => assertModelRequestAllowed(request, { requireAuth: false }),
    (error: unknown) => {
      assert.equal(error instanceof RequestGuardError, true);
      assert.equal((error as RequestGuardError).status, 403);
      assert.equal((error as RequestGuardError).code, "CROSS_ORIGIN");
      return true;
    },
  );
});

test("requires an authenticated user header when configured", () => {
  const anonymous = new Request(
    "https://audit.example.com/api/audit/finalize",
    {
      method: "POST",
      headers: { origin: "https://audit.example.com" },
    },
  );
  const authenticated = new Request(
    "https://audit.example.com/api/audit/finalize",
    {
      method: "POST",
      headers: {
        origin: "https://audit.example.com",
        "oai-authenticated-user-email": "user@example.com",
      },
    },
  );

  assert.throws(
    () => assertModelRequestAllowed(anonymous, { requireAuth: true }),
    (error: unknown) => {
      assert.equal((error as RequestGuardError).status, 401);
      assert.equal((error as RequestGuardError).code, "AUTH_REQUIRED");
      return true;
    },
  );
  assert.doesNotThrow(() =>
    assertModelRequestAllowed(authenticated, { requireAuth: true }),
  );
});

test("treats Sec-Fetch-Site cross-site as untrusted even without Origin", () => {
  const request = new Request("https://audit.example.com/api/audit/extract", {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
  });

  assert.throws(
    () => assertModelRequestAllowed(request, { requireAuth: false }),
    (error: unknown) => {
      assert.equal((error as RequestGuardError).code, "CROSS_ORIGIN");
      return true;
    },
  );
});
