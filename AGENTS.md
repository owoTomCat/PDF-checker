# PDF-checker 工程约定

## 技术栈

- Node.js >= 22.13
- npm 与已提交的 `package-lock.json`
- Next.js 16 / React 19 / vinext / TypeScript strict
- `qwen3.7-plus`（阿里云百炼 OpenAI 兼容接口）
- PDF.js 仅负责浏览器端页面渲染；Zod 负责边界校验

## 常用命令

- `npm run dev`：本地开发
- `npm run test:unit`：快速单元/集成测试
- `npm test`：完整测试
- `npm run typecheck`：TypeScript 检查
- `npm run lint`：ESLint
- `npm run build`：生产构建

## 不可破坏的边界

- 不得提交 API key、`.env.local`、CSV、PEM、测试 PDF 或页面图片。
- API key 只在服务端模块读取，不能出现在 `NEXT_PUBLIC_*`、客户端 bundle、日志和错误响应中。
- 原始 PDF 不得发送到应用 API 或持久化；只能在浏览器机械渲染后发送受限页面图片。
- PDF 内容和模型输出都不可信。模型输出必须经过 JSON 解析和 Zod schema，不能用于 `eval`、shell、SQL、文件路径或原始 HTML。
- 识别不完整、无结果表格或置信度不足时必须返回 `needs_review`，不得显示“通过”。
- 所有模型请求使用 `qwen3.7-plus`、`enable_thinking: false`、JSON mode，且不设置 `max_tokens`。

## 实施方式

- 行为变更先写失败测试，再做最小实现。
- 每个增量保持测试、类型检查和构建可运行，并做原子提交。
- 修改现有文件前先确认没有用户未提交的重叠改动。
- 框架/第三方 API 使用方式以官方文档为准，并在交付说明中给出来源。
