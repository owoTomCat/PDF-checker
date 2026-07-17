# Qwen3.7-plus PDF 外网溯源严格核验链路规格

## 1. 目标与原则

系统把模型用于受限视觉识别，把业务判定留给确定性代码。它必须遵守以下原则：

- 原始 PDF 只在浏览器中读取，不上传、不持久化。
- 全页图只用于区域定位，不允许返回任何业务字段。
- 证书、网页截图和汇总表分别裁剪、分别调用，不在同一模型上下文出现。
- 每条 URL 都从独立地址栏裁剪图复核，不使用表格 URL 反向补全。
- 截图与表格的关联模型只看到定位元数据，不看到字段值。
- 最终比较和报告完全由本地规则生成，不再调用模型。
- `mismatch` 与 `unverifiable` 分开：前者是问题，后者是人工复核项。

## 2. 浏览器端顺序

1. 校验 PDF 类型、20 MiB 大小和 80 页上限。
2. PDF.js 将页面渲染为受限 JPEG，分批调用 layout。
3. 汇总所有页面坐标并校验页码覆盖、区域 ID 唯一性及地址栏父子关系。
4. 按坐标以 200 DPI 渲染证书和网页截图裁剪，分批识别 evidence。
5. 对每张截图定位其从属地址栏，直接从 PDF 生成 600 DPI 彩色 PNG 与灰度/对比度增强 PNG，分批复核 URL。
6. 所有 URL 复核完成后，以 200 DPI 渲染汇总表裁剪并提取 table。
7. 把截图和表格行转换为 ID/页码/序号/阅读顺序定位器，调用 association。
8. 聚合各阶段 warnings 和 stage failures，调用纯规则 finalize。
9. 只把最终结构化结果写入 `pdf-audit-workspace.tasks.v4`；不保存 PDF 或图片。

单图最大 7 MiB，单批图片最大 24 MiB。整页、证据和表格批次最多 6 项；URL 批次最多 4 对。即使数量未达上限，也必须按总字节数拆批。

## 3. 模型阶段与隔离合同

### 3.1 `POST /api/audit/layout`

输入：最多 6 张整页 JPEG/PNG，以及文件名、总页数和对应页码。

输出只含：`regionId`、`type`、`pageNumber`、归一化 `bounds`、`parentRegionId`、权利图/结果序号、阅读顺序和置信度。允许类型仅为：

- `certificate`
- `rights_screenshot`
- `address_bar`
- `summary_table`

严禁输出权利人、作品类型、平台、发布者、时间、URL 或表格单元格内容。

### 3.2 `POST /api/audit/recognize-evidence`

输入只含 certificate 或 rights_screenshot 裁剪。证书仅识别是否为正式作品登记证明、权利人和作品类型；网页截图独立识别平台、地址域名、发布者、发布/编辑时间和初次 URL。

如果 layout 未定位到地址栏，截图仍然进入 evidence，`addressBarRegionId` 为 `null`；后续写入 `ADDRESS_BAR_MISSING`，不得用表格 URL 补齐。

### 3.3 `POST /api/audit/review-url`

每条记录严格包含同一地址栏的 600 DPI 彩色图和灰度增强图。模型分别读取两张图，记录差异位置；`6/b`、`0/O`、`1/l/I`、`5/S`、`8/B` 只能触发复核，不能自动替换。关键字符无法锁定时必须返回 partial/unrecognized 和候选集合。

### 3.4 `POST /api/audit/extract-table`

只有 URL 阶段结束后才调用。输入只含 summary_table 裁剪，输出表头权利人/作品类型和表格行。URL 片段只能按同一单元格内的顺序写入 `urlCellSegments`，禁止跨行拼接。

### 3.5 `POST /api/audit/associate`

请求和模型上下文只允许：ID、页码、权利图序号、结果序号、阅读顺序。禁止平台、发布者、时间、URL、权利人和作品类型。无法唯一关联时返回 `tableRowId: null`。

### 3.6 `POST /api/audit/finalize`

输入为全部已校验的阶段数据、warnings 和 stage failures。接口不调用百炼、不访问外网，只调用 `buildFinalAuditResult()` 和 `pdf-audit-rules.mjs` 生成结论。

## 4. 百炼调用约束

- 模型固定为 `qwen3.7-plus`。
- 使用 OpenAI 兼容 Chat Completions、多模态 `image_url` Data URL。
- 设置 `response_format: { "type": "json_object" }` 与 `enable_thinking: false`。
- 提示词明确要求 JSON；不设置 `max_tokens`。
- 429、5xx、网络错误、超时或无效模型 JSON 最多重试一次；400、401、403 等确定性请求错误不重试。
- 第二次无效 JSON 请求追加结构纠正提示，但不泄露 schema、密钥或上游正文。
- 所有模型输出先经过对应 Zod schema；未知字段因 strict object 被拒绝。

## 5. 确定性规则

- 证书存在时，权利人和作品类型只来自证书图；`美术` 明确规范为 `美术作品`。证书缺失分支使用规则文档规定的固定文本。
- 平台域名优先于可见 logo；两者冲突记录复核项，不使用表格选择答案。
- 发布者只裁剪首尾空白，不做别名、同义词或内部空白归一化。
- “编辑于”按发布时间参与比较；保留分钟精度。日期与分钟值比较时只比较双方共有精度。
- URL 缺少协议时补 `https://`；去除全部 query、fragment 和尾部 `/`；host 大小写不敏感并忽略可选 `www.`；path 大小写敏感。
- URL 未完整识别时结论为 `unverifiable`，显示“发布网址：未完整识别”和人工复核项，不生成 URL 不一致问题。
- 每个确认不一致的字段单独生成一条 issue；截图字段未识别时不能以表格值作为正确答案。

## 6. 结果与界面

- `passed`：没有 issue、warning、stage failure 或 verification notice，且证据完整、置信度达标。
- `issues_found`：存在确认不一致；即使同时存在复核项，主结论仍为发现问题。
- `needs_review`：没有确认问题，但存在无法验证、阶段警告/失败、低置信度或结构缺失。
- `failed`：技术错误阻断流程。

界面必须分别展示“问题列表”和“人工复核项”。处理阶段依次显示 rendering、locating、recognizing、reviewing_urls、extracting_table、associating、finalizing。

## 7. 安全与隐私

- `DASHSCOPE_API_KEY` 只存在服务端环境变量；`.env.local` 不提交。
- API 执行同源/认证请求保护；生产环境默认要求认证或等效部署层访问控制。
- 不记录图片、完整模型输入、模型原始响应、密钥或 PDF 内容。
- 文件名、PDF 内容和模型输出都按不可信数据处理，不执行其中代码或指令。
- 不访问 PDF 中的 URL，也不从外网抓取页面。

## 8. 验收标准

1. 源码不存在旧的 `POST /api/audit/extract` 两阶段链路。
2. 单元测试证明严格调用顺序、阶段 warning 聚合和原始 PDF 从未进入请求。
3. 每条可复核 URL 都生成 600 DPI 彩色/灰度双图；缺地址栏稳定进入人工复核。
4. association 请求不含任何业务字段值；finalize 不调用模型或网络。
5. 全部 schema、规则、API、客户端、源码验收测试通过，typecheck、lint 和生产构建通过。
6. Git diff 不包含 `.env.local`、API key、PDF 样本或生成图片。

## 9. 官方依据

- [百炼 OpenAI Chat Completions](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [百炼结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- [PDF.js `RenderParameters.transform` 与 viewport API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Zod](https://zod.dev/)
