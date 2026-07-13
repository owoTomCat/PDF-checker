# PDF-checker

使用阿里云百炼 `qwen3.7-plus` 对“外网溯源结果报告”进行页面视觉识别、字段提取、跨页归并和确定性规则复核。

## 处理链路

1. 浏览器使用 PDF.js 读取 PDF 并逐页渲染为 JPEG。
2. 页面图片每 6 页一批发送到 `/api/audit/extract`。
3. 服务端调用百炼 OpenAI 兼容接口，由 `qwen3.7-plus` 识别首页字段、证书、结果表格和出处截图。
4. 所有页级 JSON 送到 `/api/audit/finalize`，再次由 `qwen3.7-plus` 完成跨页归并。
5. 经过 Zod 严格校验后，`pdf-audit-rules.mjs` 执行网址、时间和字段一致性的确定性复核。
6. 最终结果保存在当前浏览器 `localStorage`，不保存 PDF 或页面图片。

原始 PDF 不会发送到服务端；渲染后的页面图片会发送到应用服务端和阿里云百炼处理。模型输出不完整、未识别到表格或置信度不足时，结果强制为“需人工复核”，不会误报“通过”。

## 环境要求

- Node.js `>=22.13.0`
- npm
- 阿里云百炼业务空间 API Key
- 可调用 `qwen3.7-plus` 的百炼 OpenAI 兼容地址

## 本地配置

复制环境变量模板：

```bash
cp .env.example .env.local
```

填写以下服务端变量：

```dotenv
DASHSCOPE_API_KEY=你的百炼APIKey
DASHSCOPE_BASE_URL=https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-plus
PDF_AUDIT_REQUIRE_AUTH=false
```

安全约束：

- `.env.local` 已被 Git 忽略，不得提交到 GitHub。
- 不要使用 `NEXT_PUBLIC_` 前缀，否则密钥会进入客户端 bundle。
- 生产环境应设置 `PDF_AUDIT_REQUIRE_AUTH=true` 并使用 OpenAI Sites 认证头，或在腾讯云/Nginx 等部署层提供等效的登录、访问控制和限流。
- 部署平台的 API Key 应通过 Secret/环境变量配置，不要把本地 `.env.local` 上传到服务器镜像或仓库。

## 启动

```bash
npm install
npm run dev
```

默认本地地址为 `http://localhost:3000`。

## 输入限制

- 仅支持 PDF。
- 单文件最大 20 MiB。
- 最多 80 页。
- 每个模型识别批次最多 6 页。
- 单页图片最大 7 MiB，单批图片最大 24 MiB。

## 结果状态

- `passed`：提取完整、置信度达标且规则未发现问题。
- `issues_found`：提取完整且规则发现问题。
- `needs_review`：证据不完整、存在识别警告、低置信度、没有表格或缺少截图对应关系。
- `failed`：PDF、网络、配置或模型响应导致任务无法完成。

## 验证命令

```bash
npm run test:unit
npm run test:source
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

`npm test` 会依次运行单元/集成测试、生产构建和源码验收测试。

## 主要目录

- `app/AuditConsole.tsx`：上传、进度、历史和结果 UI。
- `lib/client/pdf-renderer.ts`：PDF.js 页面机械渲染，不提取本地文本。
- `lib/client/audit-pipeline.ts`：6 页批次编排和两段式 API 调用。
- `app/api/audit/`：页级识别与最终归并接口。
- `lib/server/bailian-client.ts`：百炼请求构造、超时、错误隔离和模型 JSON 校验。
- `lib/ai/contracts.ts`：所有输入、模型输出和 API 响应 schema。
- `pdf-audit-rules.mjs`：确定性核验规则。
- `docs/spec-qwen-ai-pipeline.md`：完整产品与技术规格。

## 官方资料

- [百炼 OpenAI Chat Completions](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [百炼视觉理解](https://help.aliyun.com/zh/model-studio/vision-model/)
- [百炼结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/)
- [Vite 静态资源 URL 导入](https://vite.dev/guide/assets.html#explicit-url-imports)
- [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Zod 基础校验](https://zod.dev/basics)
