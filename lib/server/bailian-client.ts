import * as z from "zod";
import {
  AssociationBatchSchema,
  AssociationRequestSchema,
  EvidenceBatchSchema,
  LayoutBatchSchema,
  MAX_BATCH_PAGES,
  MAX_PDF_PAGES,
  TableBatchSchema,
  UrlReviewBatchSchema,
  type AssociationBatch,
  type EvidenceBatch,
  type LayoutBatch,
  type TableBatch,
  type UrlReviewBatch,
} from "../ai/contracts";
import {
  ASSOCIATION_SYSTEM_PROMPT,
  EVIDENCE_SYSTEM_PROMPT,
  LAYOUT_SYSTEM_PROMPT,
  TABLE_SYSTEM_PROMPT,
  URL_REVIEW_SYSTEM_PROMPT,
} from "../ai/prompts";

const QWEN_MODEL = "qwen3.7-plus";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_ATTEMPTS = 2;

const dataUrl = z
  .string()
  .max(12 * 1024 * 1024)
  .regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/);
const pageNumber = z.number().int().min(1).max(MAX_PDF_PAGES);

const PageImageInputSchema = z.strictObject({
  pageNumber,
  dataUrl,
});

const LayoutModelInputSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  pages: z.array(PageImageInputSchema).min(1).max(MAX_BATCH_PAGES),
});

function layoutBatchSchemaForPages(expectedPageNumbers: readonly number[]) {
  const expected = [...expectedPageNumbers].sort((a, b) => a - b);
  return LayoutBatchSchema.superRefine((batch, context) => {
    const returned = batch.pages
      .map((page) => page.pageNumber)
      .sort((a, b) => a - b);
    const isExactMatch =
      expected.length === returned.length &&
      expected.every((pageNumber, index) => pageNumber === returned[index]);
    if (!isExactMatch) {
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "\u9875\u9762\u5b9a\u4f4d\u7ed3\u679c\u5fc5\u987b\u5b8c\u6574\u8986\u76d6\u672c\u6279\u6b21\u8bf7\u6c42\u9875\u7801\u3002",
      });
    }
  });
}

const EvidenceModelInputSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  regions: z
    .array(
      z.strictObject({
        regionId: z.string().min(1).max(100),
        type: z.enum(["certificate", "rights_screenshot"]),
        pageNumber,
        rightsImageIndex: z.number().int().min(1).max(10_000).nullable(),
        resultIndex: z.number().int().min(1).max(10_000).nullable(),
        addressBarRegionId: z.string().min(1).max(100).nullable(),
        readingOrder: z.number().int().min(1).max(100_000),
        dataUrl,
      }),
    )
    .min(1)
    .max(MAX_BATCH_PAGES),
});

const UrlReviewModelInputSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  pairs: z
    .array(
      z.strictObject({
        screenshotId: z.string().min(1).max(100),
        pageNumber,
        addressBarRegionId: z.string().min(1).max(100),
        colorDataUrl: dataUrl,
        grayscaleDataUrl: dataUrl,
      }),
    )
    .min(1)
    .max(4),
});

const TableModelInputSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  regions: z
    .array(
      z.strictObject({
        regionId: z.string().min(1).max(100),
        pageNumber,
        readingOrder: z.number().int().min(1).max(100_000),
        dataUrl,
      }),
    )
    .min(1)
    .max(MAX_BATCH_PAGES),
});

const ChatCompletionEnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image_url"; image_url: { url: string } };
type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<TextContent | ImageContent> };

export type BailianChatRequest = {
  model: typeof QWEN_MODEL;
  messages: Message[];
  response_format: { type: "json_object" };
  enable_thinking: false;
};

export type LayoutModelInput = z.infer<typeof LayoutModelInputSchema>;
export type EvidenceModelInput = z.infer<typeof EvidenceModelInputSchema>;
export type UrlReviewModelInput = z.infer<typeof UrlReviewModelInputSchema>;
export type TableModelInput = z.infer<typeof TableModelInputSchema>;
export type AssociationModelInput = z.infer<typeof AssociationRequestSchema>;

export class BailianClientError extends Error {
  constructor(
    public readonly code:
      | "CONFIG_ERROR"
      | "UPSTREAM_ERROR"
      | "UPSTREAM_TIMEOUT"
      | "ABORTED"
      | "INVALID_MODEL_OUTPUT",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BailianClientError";
  }
}

function baseRequest(messages: Message[]): BailianChatRequest {
  return {
    model: QWEN_MODEL,
    messages,
    response_format: { type: "json_object" },
    enable_thinking: false,
  };
}

function image(url: string): ImageContent {
  return { type: "image_url", image_url: { url } };
}

export function buildLayoutRequest(
  rawInput: LayoutModelInput,
): BailianChatRequest {
  const input = LayoutModelInputSchema.parse(rawInput);
  const content: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: `请只定位区域并返回 JSON。元数据：${JSON.stringify({
        totalPages: input.totalPages,
        pageNumbers: input.pages.map((page) => page.pageNumber),
      })}`,
    },
  ];
  for (const page of input.pages) {
    content.push(
      { type: "text", text: `PAGE_${page.pageNumber}` },
      image(page.dataUrl),
    );
  }
  return baseRequest([
    { role: "system", content: LAYOUT_SYSTEM_PROMPT },
    { role: "user", content },
  ]);
}

export function buildEvidenceRequest(
  rawInput: EvidenceModelInput,
): BailianChatRequest {
  const input = EvidenceModelInputSchema.parse(rawInput);
  const content: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: `请独立识别裁剪证据并返回 JSON。总页数：${input.totalPages}`,
    },
  ];
  for (const region of input.regions) {
    const { dataUrl: regionDataUrl, ...metadata } = region;
    content.push(
      { type: "text", text: `REGION_META ${JSON.stringify(metadata)}` },
      image(regionDataUrl),
    );
  }
  return baseRequest([
    { role: "system", content: EVIDENCE_SYSTEM_PROMPT },
    { role: "user", content },
  ]);
}

export function buildUrlReviewRequest(
  rawInput: UrlReviewModelInput,
): BailianChatRequest {
  const input = UrlReviewModelInputSchema.parse(rawInput);
  const content: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: `请逐对独立复核地址栏并返回 JSON。总页数：${input.totalPages}`,
    },
  ];
  for (const pair of input.pairs) {
    content.push(
      {
        type: "text",
        text: `PAIR_META ${JSON.stringify({
          screenshotId: pair.screenshotId,
          pageNumber: pair.pageNumber,
          addressBarRegionId: pair.addressBarRegionId,
        })}`,
      },
      { type: "text", text: "COLOR" },
      image(pair.colorDataUrl),
      { type: "text", text: "GRAYSCALE" },
      image(pair.grayscaleDataUrl),
    );
  }
  return baseRequest([
    { role: "system", content: URL_REVIEW_SYSTEM_PROMPT },
    { role: "user", content },
  ]);
}

export function buildTableRequest(
  rawInput: TableModelInput,
): BailianChatRequest {
  const input = TableModelInputSchema.parse(rawInput);
  const content: Array<TextContent | ImageContent> = [
    {
      type: "text",
      text: `请独立提取汇总表并返回 JSON。总页数：${input.totalPages}`,
    },
  ];
  for (const region of input.regions) {
    const { dataUrl: regionDataUrl, ...metadata } = region;
    content.push(
      { type: "text", text: `TABLE_META ${JSON.stringify(metadata)}` },
      image(regionDataUrl),
    );
  }
  return baseRequest([
    { role: "system", content: TABLE_SYSTEM_PROMPT },
    { role: "user", content },
  ]);
}

export function buildAssociationRequest(
  rawInput: AssociationModelInput,
): BailianChatRequest {
  const input = AssociationRequestSchema.parse(rawInput);
  return baseRequest([
    { role: "system", content: ASSOCIATION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `请仅按定位元数据建立 ID 映射并返回 JSON：${JSON.stringify(
        input,
      )}`,
    },
  ]);
}

function normalizeBaseUrl(rawBaseUrl: string) {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new BailianClientError("CONFIG_ERROR", "百炼服务地址配置无效。");
  }

  const allowedHost =
    url.hostname === "dashscope.aliyuncs.com" ||
    url.hostname.endsWith(".maas.aliyuncs.com");
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    !url.pathname.endsWith("/compatible-mode/v1") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BailianClientError("CONFIG_ERROR", "百炼服务地址配置无效。");
  }

  return url.toString().replace(/\/$/, "");
}

function parseModelContent<T>(rawEnvelope: string, schema: z.ZodType<T>): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawEnvelope);
  } catch {
    throw new BailianClientError(
      "INVALID_MODEL_OUTPUT",
      "模型返回了无法解析的响应。",
      true,
    );
  }

  const parsedEnvelope = ChatCompletionEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    throw new BailianClientError(
      "INVALID_MODEL_OUTPUT",
      "模型返回结构不符合预期。",
      true,
    );
  }

  let modelJson: unknown;
  try {
    modelJson = JSON.parse(parsedEnvelope.data.choices[0].message.content);
  } catch {
    throw new BailianClientError(
      "INVALID_MODEL_OUTPUT",
      "模型没有返回有效 JSON。",
      true,
    );
  }

  const parsedModelJson = schema.safeParse(modelJson);
  if (!parsedModelJson.success) {
    throw new BailianClientError(
      "INVALID_MODEL_OUTPUT",
      "模型返回的数据不完整，请重新处理或人工复核。",
      true,
    );
  }
  return parsedModelJson.data;
}

function withCorrectionPrompt(
  request: BailianChatRequest,
  correctionDetail?: string,
): BailianChatRequest {
  const correction: TextContent = {
    type: "text",
    text: [
      "上一次响应未通过 JSON schema 校验。请严格按系统指定的 JSON 结构重新返回，不要增加字段。",
      correctionDetail,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n"),
  };
  const messages = request.messages.map((message, index) => {
    if (index !== request.messages.length - 1 || message.role !== "user") {
      return message;
    }
    if (typeof message.content === "string") {
      return {
        ...message,
        content: `${message.content}\n${correction.text}`,
      };
    }
    return { ...message, content: [...message.content, correction] };
  });
  return { ...request, messages };
}

type BailianClientOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createBailianClient(options: BailianClientOptions) {
  if (!options.apiKey.trim()) {
    throw new BailianClientError("CONFIG_ERROR", "百炼 API Key 未配置。");
  }
  if ((options.model ?? QWEN_MODEL) !== QWEN_MODEL) {
    throw new BailianClientError(
      "CONFIG_ERROR",
      "当前链路只允许使用 qwen3.7-plus。",
    );
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function complete<T>(
    request: BailianChatRequest,
    schema: z.ZodType<T>,
    correctionDetail?: string,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    let activeRequest = request;
    let finalError: BailianClientError | null = null;

    for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt += 1) {
      if (externalSignal?.aborted) {
        throw new BailianClientError("ABORTED", "模型请求已停止。");
      }
      const controller = new AbortController();
      let timedOut = false;
      const abortForExternalSignal = () => controller.abort(externalSignal?.reason);
      if (externalSignal) {
        externalSignal.addEventListener("abort", abortForExternalSignal, { once: true });
      }
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(activeRequest),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new BailianClientError(
            "UPSTREAM_ERROR",
            "模型服务暂时不可用，请稍后重试。",
            response.status === 429 || response.status >= 500,
          );
        }

        const rawEnvelope = await response.text();
        if (
          new TextEncoder().encode(rawEnvelope).byteLength >
          MAX_UPSTREAM_RESPONSE_BYTES
        ) {
          throw new BailianClientError(
            "INVALID_MODEL_OUTPUT",
            "模型返回的数据超过安全限制。",
            true,
          );
        }
        return parseModelContent(rawEnvelope, schema);
      } catch (error) {
        if (externalSignal?.aborted) {
          throw new BailianClientError("ABORTED", "模型请求已停止。");
        }
        const normalizedError =
          error instanceof BailianClientError
            ? error
            : controller.signal.aborted && timedOut
              ? new BailianClientError(
                  "UPSTREAM_TIMEOUT",
                  "模型处理超时，请稍后重试。",
                  true,
                )
              : new BailianClientError(
                  "UPSTREAM_ERROR",
                  "模型服务暂时不可用，请稍后重试。",
                  true,
                );
        finalError = normalizedError;
        if (
          attempt + 1 < MAX_MODEL_ATTEMPTS &&
          normalizedError.retryable
        ) {
          if (normalizedError.code === "INVALID_MODEL_OUTPUT") {
            activeRequest = withCorrectionPrompt(activeRequest, correctionDetail);
          }
          continue;
        }
        throw normalizedError;
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abortForExternalSignal);
      }
    }

    throw (
      finalError ??
      new BailianClientError(
        "UPSTREAM_ERROR",
        "模型服务暂时不可用，请稍后重试。",
      )
    );
  }

  return {
    locateRegions(input: LayoutModelInput, signal?: AbortSignal): Promise<LayoutBatch> {
      const parsedInput = LayoutModelInputSchema.parse(input);
      const expectedPageNumbers = parsedInput.pages.map(
        (page) => page.pageNumber,
      );
      return complete(
        buildLayoutRequest(parsedInput),
        layoutBatchSchemaForPages(expectedPageNumbers),
        `\u9875\u9762\u5b9a\u4f4d\u7ed3\u679c\u5fc5\u987b\u5305\u542b\u9875\u7801 ${JSON.stringify(expectedPageNumbers)}\uff0c\u6bcf\u9875\u6070\u597d\u8fd4\u56de\u4e00\u6b21\uff1b\u5373\u4f7f\u67d0\u9875\u6ca1\u6709\u76ee\u6807\u533a\u57df\uff0c\u4e5f\u5fc5\u987b\u8fd4\u56de\u8be5\u9875\u5e76\u5c06 regions \u8bbe\u7f6e\u4e3a\u7a7a\u6570\u7ec4\u3002`,
        signal,
      );
    },
    recognizeEvidence(input: EvidenceModelInput, signal?: AbortSignal): Promise<EvidenceBatch> {
      return complete(buildEvidenceRequest(input), EvidenceBatchSchema, undefined, signal);
    },
    reviewUrls(input: UrlReviewModelInput, signal?: AbortSignal): Promise<UrlReviewBatch> {
      return complete(buildUrlReviewRequest(input), UrlReviewBatchSchema, undefined, signal);
    },
    extractTable(input: TableModelInput, signal?: AbortSignal): Promise<TableBatch> {
      return complete(
        buildTableRequest(input),
        TableBatchSchema,
        "顶层只能包含 headers、rows、warnings；rows[].tableRowId 必须非空且唯一；所有 regionId 只能使用本批次提供的区域 ID。",
        signal,
      );
    },
    associateRows(input: AssociationModelInput, signal?: AbortSignal): Promise<AssociationBatch> {
      return complete(buildAssociationRequest(input), AssociationBatchSchema, undefined, signal);
    },
  };
}

export function createBailianClientFromEnv() {
  return createBailianClient({
    apiKey: process.env.DASHSCOPE_API_KEY ?? "",
    baseUrl: process.env.DASHSCOPE_BASE_URL ?? "",
    model: process.env.QWEN_MODEL ?? QWEN_MODEL,
  });
}
