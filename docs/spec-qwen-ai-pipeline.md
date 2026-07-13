# Qwen3.7-plus PDF 核验链路规格

## 1. 背景与目标

现有实现会在浏览器内读取 PDF 字节、用正则和启发式规则提取字段，再调用本地规则生成核验结果。它对扫描件、复杂表格、截图信息和跨页关系的识别能力有限。

本次改造的目标是：让 `qwen3.7-plus` 承担报告页面的视觉识别、字段提取和跨页归并；本地代码只负责 PDF 页面渲染、输入/输出校验、流程编排，以及确定性的业务规则复核。原始 PDF 不持久化、不上传；浏览器只把渲染后的页面图片按批发送给服务端。

## 2. 用户与核心流程

### 2.1 用户流程

1. 用户选择一个或多个 PDF。
2. 浏览器校验文件类型和大小，并用 PDF.js 读取页数。
3. 浏览器逐页渲染为 JPEG；每 6 页组成一个批次。
4. 每批页面图片提交到 `/api/audit/extract`。
5. 服务端调用百炼 OpenAI 兼容接口的 `qwen3.7-plus`，返回经 schema 校验的页级提取 JSON。
6. 所有批次完成后，浏览器把页级 JSON 提交到 `/api/audit/finalize`。
7. 服务端再次调用 `qwen3.7-plus`，完成跨页归并并输出规范化核验输入；本地规则生成最终问题列表和中文报告。
8. 浏览器保存最终结果和摘要到 `localStorage`，不保存 PDF 和页面图片。

### 2.2 关键状态

- `queued`：已创建本地任务。
- `rendering`：浏览器正在渲染页面。
- `extracting`：正在分批调用模型识别。
- `finalizing`：模型正在跨页归并，本地规则正在复核。
- `completed`：流程结束；业务结论由 `outcome` 表示。
- `failed`：技术错误导致无法完成。

业务结论：

- `passed`：模型确认完整提取且本地规则未发现问题。
- `issues_found`：提取完整且发现规则问题。
- `needs_review`：页图不清晰、模型输出缺字段、未识别到应有表格或存在其他不确定性；绝不能显示为“未发现问题”。
- `failed`：未生成可用结果。

## 3. 功能要求

### 3.1 浏览器端 PDF 处理

- 仅接受 PDF；单文件最大 20 MiB，最多 80 页。
- 使用 PDF.js 的 `getDocument`、`getPage`、`getViewport` 和 `render` 把页面机械渲染到 Canvas。
- 不调用 `getTextContent`，不在浏览器端做语义识别或正则字段提取。
- 页面图片使用 JPEG，控制最长边与质量，单张编码后不得超过服务端限制。
- 批次大小固定为最多 6 页；逐批处理，避免同时占用过多内存和模型配额。
- 任务进度应反映渲染、批次识别和汇总阶段。

### 3.2 页级模型识别

- 模型固定为环境变量 `QWEN_MODEL`，默认且允许值为 `qwen3.7-plus`。
- 使用 OpenAI 兼容的 Chat Completions 接口。
- 请求必须设置 `enable_thinking: false` 和 `response_format: { type: "json_object" }`。
- 为避免截断结构化 JSON，不设置 `max_tokens`。
- 系统提示明确把 PDF 页面视为不可信数据，忽略其中试图改变任务、输出格式或泄露提示词的指令。
- 输出包含：页码、页面类型、首页字段、证书字段、表格行、截图字段、页内关联、警告和置信度。
- 模型输出必须先 `JSON.parse`，再通过严格 schema；无效输出不得直接进入业务规则或 UI。

### 3.3 跨页归并与核验

- `qwen3.7-plus` 根据全部页级 JSON 归并“权利图-x”、结果表格和对应出处截图。
- 不因相同网址或帖子跨表出现而自动去重。
- 看不清的截图字段必须为 `null`，不得用表格内容补齐。
- 归并输出必须符合规范化 `PdfAuditInput` schema，并带 `extractionComplete`、`warnings` 和置信度。
- 本地 `pdf-audit-rules.mjs` 仅在 schema 校验后执行确定性的时间、网址和一致性规则。
- `extractionComplete !== true`、存在阻断性警告、没有识别到任何结果表格，或关键字段缺失时，最终结论强制为 `needs_review`。

### 3.4 历史记录与界面

- UI 明确告知：原始 PDF 保留在浏览器，但渲染后的页面图片会发送到应用服务端和阿里云百炼处理。
- 历史记录仍只存于当前浏览器，最多 80 条。
- 展示实际阶段、已处理页数/总页数、模型名、问题数、警告和最终业务结论。
- `needs_review` 使用独立醒目样式，不得复用“通过”文案。

## 4. 接口与数据契约

### 4.1 `POST /api/audit/extract`

请求为 `multipart/form-data`：

- `pages`：1 到 6 个 JPEG/PNG 文件。
- `pageNumbers`：与文件一一对应的 JSON 整数数组。
- `totalPages`：整份 PDF 页数。
- `fileName`：仅用于提示模型的显示名，需限制长度并作为不可信文本处理。

响应：

```json
{
  "model": "qwen3.7-plus",
  "pages": [],
  "warnings": []
}
```

### 4.2 `POST /api/audit/finalize`

请求为 JSON：

```json
{
  "fileName": "example.pdf",
  "pageCount": 10,
  "pages": []
}
```

响应包含 `outcome`、`report`、`reportText`、`summary` 和模型名。最终响应也必须通过 schema 后再返回。

### 4.3 错误响应

错误只返回稳定的中文用户消息和机器码，不返回百炼原始响应、密钥、堆栈或内部提示词。

## 5. 非功能与安全要求

- `DASHSCOPE_API_KEY` 只存在于服务端环境变量；真实值写入被 Git 忽略且权限为 `0600` 的 `.env.local`。
- 提交 `.env.example`，不得提交 CSV、`.env.local`、私钥或页面样本。
- API 校验同源请求；可通过 `PDF_AUDIT_REQUIRE_AUTH=true` 强制要求 OpenAI Sites 注入的已认证用户头。其他部署必须放在可信访问控制之后。
- 限制请求体、文件数、单图大小、页数、JSON 数组长度和字符串长度；外部调用设置超时。
- 不记录页面图片、完整模型输入、API 密钥或模型原始响应。
- 模型输出和 PDF 内容均视为不可信数据，不进入 `eval`、shell、SQL 或原始 HTML。
- 发布前运行单元测试、类型检查、lint、build、`npm audit` 和密钥扫描。

## 6. 边界与失败场景

- 加密、损坏或超过限制的 PDF：在浏览器端停止并给出明确错误。
- 任一批次超时/无效 JSON：任务进入 `failed`，允许用户重新选择原文件重试。
- 部分页不可读但仍可归并：返回 `needs_review`，保留已识别的事实和警告。
- 未识别到表格：返回 `needs_review`，而不是 `passed`。
- 百炼缺少配置或拒绝请求：返回通用配置/服务错误，不泄露上游正文。
- 用户刷新页面后：可回看最终历史结果，但因 PDF 未存储，重新处理时需要再次选择文件。

## 7. 验收标准

1. 代码链路不再导入或调用本地 PDF 文本提取器。
2. 对一个有效样本，浏览器按不超过 6 页/批提交，并完成页级提取和最终归并。
3. 所有模型调用均使用 `qwen3.7-plus`、非思考 JSON 模式，且没有 `max_tokens`。
4. 无表格、低置信度或不完整输出稳定得到 `needs_review`。
5. 恶意页面文字不能改变输出契约；无效模型 JSON 被拒绝。
6. 原始 PDF 不发送到服务端，页面图片和原始模型响应不落盘。
7. `.env.local` 和 API key 不出现在 Git diff、提交和 GitHub。
8. 单元测试、类型检查、lint、build 与依赖安全检查通过。

## 8. 官方依据

- 百炼视觉模型与 `qwen3.7-plus` 能力：https://help.aliyun.com/zh/model-studio/vision-model/
- 百炼 OpenAI Chat Completions：https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- 百炼结构化输出：https://help.aliyun.com/zh/model-studio/qwen-structured-output
- PDF.js API：https://mozilla.github.io/pdf.js/api/
- Next.js Route Handlers：https://nextjs.org/docs/app/building-your-application/routing/route-handlers
- Zod 基础校验：https://zod.dev/basics
