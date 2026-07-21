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

function requestWithBytes(request: Request, bytes: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: new Uint8Array(bytes).buffer,
  });
}

export async function parseBoundedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const bytes = await readBoundedRequestBytes(request, maxBytes);
  return requestWithBytes(request, bytes).formData();
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
