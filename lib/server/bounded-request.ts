export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds its configured limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

function declaredLengthExceeds(request: Request, maxBytes: number): boolean {
  const value = request.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value.trim())) return false;
  return Number(value) > maxBytes;
}

export async function readBoundedRequestBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (declaredLengthExceeds(request, maxBytes)) throw new RequestBodyTooLargeError();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requestWithBody(request: Request, body: ReadableStream<Uint8Array> | undefined): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function limitedRequestBody(
  request: Request,
  maxBytes: number,
): {
  body: ReadableStream<Uint8Array> | undefined;
  cancel: (reason?: unknown) => Promise<void>;
} {
  if (declaredLengthExceeds(request, maxBytes)) throw new RequestBodyTooLargeError();
  if (!request.body) return { body: undefined, cancel: async () => undefined };

  const reader = request.body.getReader();
  let length = 0;
  let settled = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancel = async (reason?: unknown) => {
    if (settled) return;
    settled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // A source cancellation failure must not replace the public parse/limit error.
    } finally {
      release();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settled = true;
          release();
          controller.close();
          return;
        }
        length += next.value.byteLength;
        if (length > maxBytes) {
          const error = new RequestBodyTooLargeError();
          await cancel(error);
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        settled = true;
        release();
        controller.error(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  return { body, cancel };
}

export async function parseBoundedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const limited = limitedRequestBody(request, maxBytes);
  try {
    return await requestWithBody(request, limited.body).formData();
  } finally {
    await limited.cancel();
  }
}

export async function parseBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedRequestBytes(request, maxBytes);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("Request body is not valid UTF-8.");
  }
  return JSON.parse(source);
}
