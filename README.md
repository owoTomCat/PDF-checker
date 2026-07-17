# PDF-checker

使用阿里云百炼 `qwen3.7-plus` 对“PDF 外网溯源报告”执行隔离式视觉识别和确定性规则复核。

## 严格处理链路

1. 浏览器使用 PDF.js 打开原始 PDF；原文件始终留在浏览器内。
2. 受限整页 JPEG 每 6 页一批发送到 `/api/audit/layout`。这个模型只返回证书、网页截图、地址栏和汇总表的坐标，禁止转录业务字段。
3. 浏览器按坐标生成证书和网页截图裁剪图，发送到 `/api/audit/recognize-evidence`。截图裁剪看不到汇总表，证书裁剪也不会混入表格内容。
4. 每条网页截图的地址栏直接从 PDF 生成 600 DPI 彩色图和灰度/对比度增强图，成对发送到 `/api/audit/review-url`；字符不确定时只标记人工复核，不自动替换。
5. 完成全部 URL 复核后，才把汇总表裁剪图发送到 `/api/audit/extract-table`。URL 换行片段只能在同一单元格内拼接。
6. `/api/audit/associate` 只接收 ID、页码、权利图序号、结果序号和阅读顺序，不接收平台、发布者、时间、URL、权利人或作品类型。
7. `/api/audit/finalize` 不调用模型，只运行 `pdf-audit-rules.mjs` 中的确定性规则并生成报告。

所有模型请求固定使用 `qwen3.7-plus`、JSON 模式、`enable_thinking: false`，且不设置 `max_tokens`。原始 PDF、页面图、裁剪图和模型原始响应都不持久化；最终结果只保存在当前浏览器的 `localStorage`。

## 规则结果

- `passed`：证据完整、置信度达标、没有阶段警告或人工复核项，且确定性规则未发现问题。
- `issues_found`：存在已经确认的字段不一致。
- `needs_review`：证据不足、地址栏字符未完整识别、阶段警告/失败、低置信度或关联不完整；这些情况不会被误判为错误或通过。
- `failed`：PDF、网络、配置或模型响应导致流程无法完成。

确认不一致显示在“问题列表”，无法验证的内容显示在“人工复核项”，两者不会混合。

## 环境要求与配置

- Node.js `>=22.13.0`
- npm
- 可调用 `qwen3.7-plus` 的阿里云百炼业务空间 API Key 和 OpenAI 兼容地址

复制 `.env.example` 为 `.env.local`，然后填写：

```dotenv
DASHSCOPE_API_KEY=你的百炼APIKey
DASHSCOPE_BASE_URL=https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-plus
PDF_AUDIT_REQUIRE_AUTH=false
```

`.env.local` 已被 Git 忽略。不要使用 `NEXT_PUBLIC_` 前缀。生产环境应设置 `PDF_AUDIT_REQUIRE_AUTH=true` 并提供可信认证头，或在部署层提供等效的认证、访问控制和限流。

## 启动与验证

```bash
npm install
npm run dev
```

默认本地地址为 `http://localhost:3000`。输入限制为单个 PDF 最大 20 MiB、最多 80 页；单图最大 7 MiB、单批图片最大 24 MiB；整页/普通裁剪批次最多 6 项，URL 复核批次最多 4 对。

```bash
npm run test:unit
npm run test:source
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

## 主要文件

- `lib/client/pdf-renderer.ts`：整页及区域级 PDF.js 渲染、600 DPI 地址栏图和灰度增强。
- `lib/client/audit-pipeline.ts`：严格顺序编排、批次限制和 warning 聚合。
- `app/api/audit/`：五个隔离模型阶段及一个确定性汇总接口。
- `lib/server/bailian-client.ts`：百炼请求、一次受控重试、超时和模型 JSON 校验。
- `lib/ai/contracts.ts`：各阶段严格 schema 和禁止跨阶段字段的合同。
- `pdf-audit-rules.mjs`：网址、时间、平台和字段一致性的确定性规则。
- `docs/spec-qwen-ai-pipeline.md`：完整产品与技术规格。

## 官方资料

- [百炼 OpenAI Chat Completions](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [百炼结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Zod](https://zod.dev/)
