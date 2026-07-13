# Qwen3.7-plus PDF 核验链路实施计划

## 目标

在不上传和持久化原始 PDF 的前提下，用 `qwen3.7-plus` 完成页面视觉识别、字段提取和跨页归并，并保留确定性规则作为最终复核。

## 任务 1：建立配置与数据契约

- 文件：`.gitignore`、`.env.example`、`package.json`、`lib/ai/contracts.ts`、`tests/ai-contracts.test.ts`
- 依赖：安装 `pdfjs-dist`、`zod`、`tsx`。
- RED：为页级输出、最终输出、`needs_review` 安全门和输入上限写失败测试。
- GREEN：实现严格 Zod schema、推导类型和安全结论函数。
- 验证：`npm run test:unit`、`npm run typecheck`。
- 完成标准：不完整/无表格结果无法被标记为 `passed`。

## 任务 2：实现百炼客户端与安全边界

- 文件：`lib/ai/prompts.ts`、`lib/server/bailian-client.ts`、`lib/server/request-guards.ts`、`tests/bailian-client.test.ts`、`tests/request-guards.test.ts`
- 依赖：任务 1 的 schema。
- RED：验证模型名、JSON 模式、关闭思考、无 `max_tokens`、提示注入隔离、超时和通用错误。
- GREEN：实现页级/归并请求构造、上游调用、JSON 解析、schema 校验和请求保护。
- 验证：定向单测；使用 mock fetch，不在测试中消耗真实模型额度。
- 完成标准：密钥只从服务端环境读取，模型输出不能绕过 schema。

### 检查点 A

审查契约、提示词、威胁模型和请求载荷，确认没有把 API key、系统提示或未受限文件暴露给客户端。

## 任务 3：实现两段式 API

- 文件：`app/api/audit/extract/route.ts`、`app/api/audit/finalize/route.ts`、`lib/audit-result.ts`、`tests/audit-api.test.ts`、`pdf-audit-rules.mjs`
- 依赖：任务 1、2。
- RED：覆盖合法批次、文件类型/大小、页码错配、无效模型响应、最终 `needs_review`。
- GREEN：实现批次提取和跨页归并 API，把模型规范化结果交给确定性规则。
- 验证：API 集成测试、类型检查。
- 完成标准：API 只返回稳定契约和通用错误；模型不完整时安全降级。

## 任务 4：实现浏览器渲染与完整 UI 流程

- 文件：`lib/client/pdf-renderer.ts`、`lib/client/audit-pipeline.ts`、`lib/types.ts`、`app/AuditConsole.tsx`、`tests/client-pipeline.test.ts`
- 依赖：任务 3 API、PDF.js。
- RED：覆盖 20 MiB/80 页限制、6 页批次、阶段进度、原始 PDF 不进入请求。
- GREEN：实现页面 JPEG 渲染、逐批调用、最终汇总、历史记录和四种结论 UI。
- 验证：单测、lint、类型检查、浏览器手动流程。
- 完成标准：页面文案准确披露图片发送给百炼，`needs_review` 不显示通过。

### 检查点 B

使用一个小样本做真实模型冒烟测试，核对页码、表格行、截图字段、跨页归并和 UI 进度；记录但不提交测试 PDF 或模型原文。

## 任务 5：移除旧链路并完成发布验证

- 文件：删除 `lib/pdf-text-extractor.ts`、旧 `app/api/tasks/**` 与 `lib/server/storage.ts`；更新 `tests/rendered-html.test.mjs`、`README.md`
- 依赖：任务 4 完整通过。
- RED：源码测试先断言不再出现本地解析器和旧上传 API。
- GREEN：移除死代码、旧依赖/配置说明，完善部署环境变量与隐私说明。
- 验证：`npm test`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm audit`、Git diff 密钥扫描。
- 完成标准：Git 工作区只包含本次范围文件，所有检查通过，分支推送并创建 Draft PR。

## 风险与缓解

- 模型视觉误识别：严格 schema、置信度/警告、安全降级和人工复核状态。
- 大文件成本与延迟：20 MiB/80 页、6 页批次、JPEG 压缩、串行批次、请求超时。
- 提示注入：不可信文档系统提示、固定 JSON 契约、本地 schema 校验、无工具权限。
- 密钥滥用：仅服务端环境变量、同源校验、可配置认证、部署层访问控制。
- PDF.js/vinext 兼容：先做小切片构建验证，再接入完整 UI。
- GitHub Git 端点网络不稳定：保留本地原子提交，发布阶段通过受控重试完成同步。
