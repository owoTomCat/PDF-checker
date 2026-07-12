type DecodedStream = {
  dictionary: string;
  text: string;
};

export type ExtractedPdfText = {
  text: string;
  pageCount: number | null;
};

const latin1Decoder = new TextDecoder("latin1");
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function bytesToBinaryString(bytes: Uint8Array) {
  let result = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    result += String.fromCharCode(...chunk);
  }
  return result;
}

function binaryStringToBytes(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

async function inflate(bytes: Uint8Array) {
  if (!("DecompressionStream" in globalThis)) {
    return null;
  }

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(
      new DecompressionStream("deflate"),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function hexToUnicode(hex: string) {
  const clean = hex.replace(/\s+/g, "");
  if (!clean) return "";

  const codeUnits: number[] = [];
  const step = clean.length % 4 === 0 ? 4 : 2;
  for (let index = 0; index + step <= clean.length; index += step) {
    const value = Number.parseInt(clean.slice(index, index + step), 16);
    if (Number.isFinite(value) && value > 0) {
      codeUnits.push(value);
    }
  }
  return String.fromCharCode(...codeUnits);
}

function parseCMap(streams: DecodedStream[]) {
  const cmap = new Map<string, string>();

  for (const stream of streams) {
    if (!stream.text.includes("beginbf")) continue;

    for (const block of stream.text.matchAll(
      /beginbfchar([\s\S]*?)endbfchar/g,
    )) {
      for (const line of block[1].split(/\r?\n/)) {
        const match = line.match(/<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/);
        if (match) {
          cmap.set(match[1].toLowerCase(), hexToUnicode(match[2]));
        }
      }
    }

    for (const block of stream.text.matchAll(
      /beginbfrange([\s\S]*?)endbfrange/g,
    )) {
      for (const line of block[1].split(/\r?\n/)) {
        const direct = line.match(
          /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/,
        );
        if (direct) {
          const start = Number.parseInt(direct[1], 16);
          const end = Number.parseInt(direct[2], 16);
          const dest = Number.parseInt(direct[3], 16);
          for (let value = start; value <= end && value - start < 512; value += 1) {
            const source = value.toString(16).padStart(direct[1].length, "0");
            const target = (dest + value - start).toString(16).padStart(4, "0");
            cmap.set(source.toLowerCase(), hexToUnicode(target));
          }
          continue;
        }

        const array = line.match(
          /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+\[([\s\S]+)\]/,
        );
        if (array) {
          const start = Number.parseInt(array[1], 16);
          const values = [...array[3].matchAll(/<([0-9A-Fa-f]+)>/g)];
          values.forEach((value, offset) => {
            const source = (start + offset)
              .toString(16)
              .padStart(array[1].length, "0");
            cmap.set(source.toLowerCase(), hexToUnicode(value[1]));
          });
        }
      }
    }
  }

  return cmap;
}

function decodePdfLiteralString(value: string) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, escaped: string) => {
      const replacements: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\",
      };
      return replacements[escaped] ?? escaped;
    })
    .replace(/\\(\d{1,3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
}

function decodeHexText(hex: string, cmap: Map<string, string>) {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  if (!clean) return "";

  let output = "";
  for (let index = 0; index < clean.length; ) {
    const four = clean.slice(index, index + 4);
    const two = clean.slice(index, index + 2);

    if (four.length === 4 && cmap.has(four)) {
      output += cmap.get(four);
      index += 4;
    } else if (two.length === 2 && cmap.has(two)) {
      output += cmap.get(two);
      index += 2;
    } else if (four.length === 4) {
      const value = Number.parseInt(four, 16);
      output += value >= 32 ? String.fromCharCode(value) : "";
      index += 4;
    } else {
      const value = Number.parseInt(two, 16);
      output += value >= 32 ? String.fromCharCode(value) : "";
      index += 2;
    }
  }
  return output;
}

function extractTextOperators(streamText: string, cmap: Map<string, string>) {
  const chunks: string[] = [];

  for (const match of streamText.matchAll(
    /\[((?:\s*(?:<[^>]+>|\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?))*\s*)\]\s*TJ/g,
  )) {
    let line = "";
    for (const token of match[1].matchAll(
      /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\)])*)\)/g,
    )) {
      line += token[1]
        ? decodeHexText(token[1], cmap)
        : decodePdfLiteralString(token[2] ?? "");
    }
    if (line.trim()) chunks.push(line);
  }

  for (const match of streamText.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    const text = decodeHexText(match[1], cmap);
    if (text.trim()) chunks.push(text);
  }

  for (const match of streamText.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    const text = decodePdfLiteralString(match[1]);
    if (text.trim()) chunks.push(text);
  }

  return chunks.join("\n");
}

async function decodeStreams(bytes: Uint8Array, raw: string) {
  const streams: DecodedStream[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const streamToken = raw.indexOf("stream", cursor);
    if (streamToken < 0) break;

    const dictionaryEnd = raw.lastIndexOf(">>", streamToken);
    const dictionaryStart = raw.lastIndexOf("<<", dictionaryEnd);
    if (
      dictionaryStart < 0 ||
      dictionaryEnd < dictionaryStart ||
      streamToken - dictionaryStart > 5000
    ) {
      cursor = streamToken + 6;
      continue;
    }

    let start = streamToken + 6;
    if (raw[start] === "\r" && raw[start + 1] === "\n") {
      start += 2;
    } else if (raw[start] === "\n" || raw[start] === "\r") {
      start += 1;
    }

    const end = raw.indexOf("endstream", start);
    if (end < 0) break;

    const dictionary = raw.slice(dictionaryStart, dictionaryEnd + 2);
    const declaredLength = dictionary.match(/\/Length\s+(\d+)\b/)?.[1];
    let streamEnd = end;
    if (declaredLength) {
      const exactEnd = start + Number.parseInt(declaredLength, 10);
      if (exactEnd > start && exactEnd <= bytes.length) {
        streamEnd = exactEnd;
      }
    } else {
      while (
        streamEnd > start &&
        (raw[streamEnd - 1] === "\n" || raw[streamEnd - 1] === "\r")
      ) {
        streamEnd -= 1;
      }
    }
    const streamBytes = bytes.subarray(start, streamEnd);
    const decodedBytes = /\/FlateDecode\b/.test(dictionary)
      ? await inflate(streamBytes)
      : streamBytes;

    if (decodedBytes) {
      const text = utf8Decoder.decode(decodedBytes);
      streams.push({ dictionary, text });
    }

    cursor = end + 9;
  }

  return streams;
}

function fallbackReadableText(raw: string) {
  const utf16 = [...raw.matchAll(/(?:[\x00][\u0020-\u007e\u4e00-\u9fff]){3,}/g)]
    .map((match) => match[0].replace(/\x00/g, ""))
    .join("\n");
  const ascii = raw
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff]+/g, " ")
    .replace(/[ \t]{2,}/g, " ");
  return `${utf16}\n${ascii}`;
}

export async function extractPdfText(
  arrayBuffer: ArrayBuffer,
): Promise<ExtractedPdfText> {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = bytesToBinaryString(bytes);
  const pageMatches = raw.match(/\/Type\s*\/Page\b/g);
  const pageCount = pageMatches?.length ?? null;
  const streams = await decodeStreams(bytes, raw);
  const cmap = parseCMap(streams);
  const extracted = streams
    .map((stream) => extractTextOperators(stream.text, cmap))
    .filter(Boolean)
    .join("\n");

  const fallback = extracted.length < 100
    ? fallbackReadableText(latin1Decoder.decode(bytes))
    : "";
  const text = [extracted, fallback]
    .filter(Boolean)
    .join("\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, pageCount };
}
