import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseBoundedFormData,
  parseBoundedJson,
  readBoundedRequestBytes,
  RequestBodyTooLargeError,
} from "../lib/server/bounded-request";

async function encodedMultipart() {
  const form = new FormData();
  form.set("title", "incremental");
  form.set("file", new File(["%PDF-streamed"], "sample.pdf", { type: "application/pdf" }));
  const encoded = new Request("https://pdf.example/encode", {
    method: "POST",
    body: form,
  });
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get("content-type")!,
  };
}

function chunkedMultipartRequest(
  bytes: Uint8Array,
  contentType: string,
  chunkSize: number,
  onCancel?: () => void,
) {
  let offset = 0;
  let pulls = 0;
  const request = new Request("https://pdf.example/upload", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() {
        onCancel?.();
      },
    }, { highWaterMark: 0 }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, pulls: () => pulls };
}

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

test("bounded multipart parsing consumes a progressive stream and preserves fields", async () => {
  const { bytes, contentType } = await encodedMultipart();
  const source = chunkedMultipartRequest(bytes, contentType, 7);

  const parsed = await parseBoundedFormData(source.request, bytes.byteLength);

  assert.equal(parsed.get("title"), "incremental");
  const file = parsed.get("file");
  assert.ok(file instanceof File);
  assert.equal(await file.text(), "%PDF-streamed");
  assert.ok(source.pulls() > 2);
});

test("bounded multipart parsing cancels its source and preserves the 413 error on overflow", async () => {
  const { bytes, contentType } = await encodedMultipart();
  let cancelCalls = 0;
  const source = chunkedMultipartRequest(bytes, contentType, 11, () => {
    cancelCalls += 1;
  });

  await assert.rejects(
    parseBoundedFormData(source.request, bytes.byteLength - 1),
    RequestBodyTooLargeError,
  );
  assert.equal(cancelCalls, 1);
  const reader = source.request.body!.getReader();
  const next = await reader.read();
  reader.releaseLock();
  assert.equal(next.done, true);
});

test("multipart parsing does not route through the whole-body byte collector", async () => {
  const source = await readFile(new URL("../lib/server/bounded-request.ts", import.meta.url), "utf8");
  const formParser = source.slice(
    source.indexOf("export async function parseBoundedFormData"),
    source.indexOf("export async function parseBoundedJson"),
  );
  assert.doesNotMatch(formParser, /readBoundedRequestBytes/);
});
