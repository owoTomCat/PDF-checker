import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBoundedJson,
  readBoundedRequestBytes,
  RequestBodyTooLargeError,
} from "../lib/server/bounded-request";

function requestFromStream(
  stream: ReadableStream<Uint8Array>,
  contentLength?: string,
) {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("https://pdf.example/request", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

test("bounded request reader rejects declared oversized bodies without consuming them", async () => {
  const request = requestFromStream(new ReadableStream<Uint8Array>({
    pull() {},
  }), "11");

  await assert.rejects(
    readBoundedRequestBytes(request, 10),
    RequestBodyTooLargeError,
  );
  assert.equal(request.bodyUsed, false);
});

test("bounded request reader cancels an overflowing stream without replacing its 413 error", async () => {
  let cancelCalls = 0;
  const request = requestFromStream(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(11));
    },
    cancel() {
      cancelCalls += 1;
      throw new Error("the stream cancel hook failed");
    },
  }));

  await assert.rejects(
    readBoundedRequestBytes(request, 10),
    RequestBodyTooLargeError,
  );
  assert.equal(cancelCalls, 1);

  const reader = request.body!.getReader();
  const next = await reader.read();
  reader.releaseLock();
  assert.equal(next.done, true);
});

test("bounded request reader accepts empty and normal JSON bodies", async () => {
  const empty = await readBoundedRequestBytes(
    new Request("https://pdf.example/request", { method: "POST" }),
    10,
  );
  assert.deepEqual(empty, new Uint8Array());

  const parsed = await parseBoundedJson(
    new Request("https://pdf.example/request", {
      method: "POST",
      body: JSON.stringify({ accepted: true }),
    }),
    32,
  );
  assert.deepEqual(parsed, { accepted: true });
});
