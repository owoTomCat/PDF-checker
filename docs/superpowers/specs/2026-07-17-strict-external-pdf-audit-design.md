# PDF 外网溯源严格识别流水线设计

## 1. 背景与目标

本设计把《PDF 外网溯源报告识别与评估规则》落实为可部署、可验证的 API 流水线。目标不是依赖一段更长的提示词，而是用图像隔离、独立模型调用、不可混用的数据契约和服务端确定性规则，保证以下业务约束：

- 截图识别不得读取或借助汇总表补全字段。
- 汇总表必须作为第二份独立数据源提取。
- 每条截图 URL 必须经过地址栏高清局部复核。
- 模型只负责识别原始证据和结构，归一化、比较与最终状态由代码决定。
- “确认不一致”和“无法验证”必须分开，无法验证不得算作错误。
- 原始 PDF 仍只在浏览器中机械渲染，不发送到应用 API，也不持久化。

本轮继续使用阿里云百炼 `qwen3.7-plus`、JSON mode、`enable_thinking: false`，且不设置 `max_tokens`。本轮不抽象多模型供应商、不增加数据库或任务队列、不部署或推送远端。

## 2. 总体架构

业务上的三阶段保持为“截图独立识别 -> 汇总表独立提取 -> 归一化比较”。为使前两个阶段在图像层面真正隔离，在业务阶段之前增加无文本抄录能力的区域定位预处理：

1. 浏览器以受限尺寸渲染完整页面。
2. `layout` 调用只返回证书、网页截图、地址栏和汇总表的坐标、页码与顺序，不允许输出任何权利人、账号、时间或 URL 文本。
3. 浏览器按坐标从 PDF 重新渲染并裁剪证书/网页截图；`evidence` 调用只接收这些裁剪图，因此看不到汇总表。
4. 每条网页截图的地址栏均以至少 600 DPI 从 PDF 重新渲染，生成彩色裁剪图和灰度/对比度增强图；`url-review` 对两张图分别识别后再给出结论。
5. URL 复核全部结束后，浏览器才裁剪并发送汇总表区域；`table` 调用看不到证书和网页截图裁剪图，也不接收第一阶段结果。
6. `association` 调用只接收区域 ID、权利图序号、结果序号、页码和顺序等定位元数据，只能返回 `screenshotId -> tableRowId`，不能接收或输出业务字段值。
7. `finalize` 不再调用模型，只在服务端完成归一化、逐字段比较、错误/无法验证分类、状态门控和标准文本生成。

区域定位是无状态的独立模型调用。它虽然接收完整页面，但其 schema 中没有文本字段，输出不会传给截图识别提示词；后续模型调用也不共享会话，从而避免汇总表内容污染截图识别。

## 3. API 边界

新增或重构为以下端点：

- `POST /api/audit/layout`：接收最多 6 张完整页面图，只返回区域坐标与结构 ID。
- `POST /api/audit/recognize-evidence`：只接收证书和网页截图裁剪图，返回证书观察值与截图观察值。
- `POST /api/audit/review-url`：接收地址栏彩色/灰度图对，返回两次独立读取和最终复核状态。
- `POST /api/audit/extract-table`：只接收汇总表裁剪图，返回表头权利信息和逐行原始文本。
- `POST /api/audit/associate`：只接收定位元数据并返回 ID 映射。
- `POST /api/audit/finalize`：接收所有已通过 Zod 校验的阶段结果，执行纯代码判定。

旧的 `/api/audit/extract` 在迁移后删除，避免同一调用同时提取截图和表格。现有 `/api/audit/finalize` 的模型调用被移除。

所有图像端点继续执行同源/认证检查、Content-Length 上限、单图和批次大小限制、JPEG/PNG magic byte 校验。模型错误只返回稳定的通用错误，不泄露上游响应、API key 或文档内容。

## 4. 数据契约

### 4.1 通用类型

```ts
type RecognitionStatus = "recognized" | "partial" | "unrecognized";

type BoundingBox = {
  x: number;      // 0..1，页面或父裁剪图归一化坐标
  y: number;
  width: number;
  height: number;
};

type Observation = {
  rawText: string | null;
  status: RecognitionStatus;
  confidence: number; // 0..1
  pageNumber: number;
  regionId: string;
};
```

模型输出只保留观察到的原文。除两位年份是否具备明确上下文、时间属于“发布”还是“编辑”等视觉语义外，不允许模型直接输出用于比较的归一化值。

### 4.2 区域定位

```ts
type LayoutRegion = {
  regionId: string;
  type: "certificate" | "rights_screenshot" | "address_bar" | "summary_table";
  pageNumber: number;
  bounds: BoundingBox;
  parentRegionId: string | null;
  rightsImageIndex: number | null;
  resultIndex: number | null;
  readingOrder: number;
  confidence: number;
};
```

`layout` schema 不含任何自由文本识别字段。地址栏必须从属于一张网页截图。区域越界、重叠关系非法、重复 ID 或序号不合法时直接拒绝。

### 4.3 证书与截图证据

证书按页面分别输出候选观察：

```ts
type CertificateObservation = {
  regionId: string;
  pageNumber: number;
  isFormalCertificate: "yes" | "no" | "uncertain";
  owner: Observation;
  workType: Observation;
};
```

全局证书状态由代码聚合：任一可靠正式证书为 `provided`；所有页面定位成功且没有证书区域时为 `not_provided`；页面失败、候选冲突或证书性质不确定时为 `uncertain`。`uncertain` 不能按未提供证书处理。

每张网页截图输出：

```ts
type ScreenshotObservation = {
  screenshotId: string;
  regionId: string;
  pageNumber: number;
  rightsImageIndex: number;
  resultIndex: number;
  visiblePlatform: Observation;
  addressHost: Observation;
  publisher: Observation;
  publishedAt: Observation & {
    kind: "published" | "edited" | "unknown";
    yearContextClear: boolean;
  };
  initialUrl: Observation;
  addressBarRegionId: string | null;
};
```

平台标识和地址栏域名分别保留，冲突由代码记录，域名映射优先。发布者只保留截图原文，不允许模型做别名或同义替换。“编辑于”由 `kind: "edited"` 表示，并在最终规则中作为发布时间。

### 4.4 URL 高清复核

每条截图 URL 都必须有复核记录，不以是否出现易混淆字符为前提：

```ts
type UrlReview = {
  screenshotId: string;
  colorRead: string | null;
  grayscaleRead: string | null;
  differingPositions: Array<{
    index: number;
    colorCharacter: string | null;
    grayscaleCharacter: string | null;
  }>;
  unresolvedCharacters: Array<{
    index: number;
    candidates: string[];
  }>;
  finalRead: string | null;
  status: RecognitionStatus;
  confidence: number;
};
```

`6/b`、`0/O`、`1/l/I`、`5/S`、`8/B`只用于要求逐字符复查，绝不作为自动替换表。两次读取不一致时必须列出差异位置；关键域名、路径或内容 ID 仍不确定时，状态必须为 `partial` 或 `unrecognized`，最终展示“未完整识别”。

### 4.5 汇总表

```ts
type TableRow = {
  tableRowId: string;
  pageNumber: number;
  regionId: string;
  rightsImageIndex: number;
  resultIndex: number;
  platform: Observation;
  publisher: Observation;
  publishedAt: Observation;
  urlCellSegments: string[];
};
```

同一网址的换行内容以同一单元格内的 `urlCellSegments` 返回。服务端只允许拼接单个 `TableRow` 内的连续片段，禁止跨行或跨结果拼接。表头权利人和作品类型使用单独 `Observation` 字段。

### 4.6 关联与比较结果

关联调用只接收：`screenshotId`、`tableRowId`、页码、权利图序号、结果序号、区域顺序；不接收平台、发布者、时间、URL、证书或表头字段。

每个字段比较结果为：

```ts
type VerificationState = "match" | "mismatch" | "unverifiable";
```

- `mismatch` 进入 `issues`，每个字段独立一项。
- `unverifiable` 进入 `verificationNotices`，不计为错误，但强制整体 `needs_review`。
- 全部可验证且一致为 `passed`。
- 任一确认不一致为 `issues_found`。
- 没有确认不一致但存在无法验证、证书状态不确定、区域遗漏或关联不确定时为 `needs_review`。

若同时存在确认错误与无法验证，状态保持 `issues_found`，并同时展示人工复核提示，不能因已有错误而隐藏无法验证字段。

## 5. 客户端图像处理

完整页面继续沿用受限边长的浏览器端 PDF.js 渲染，只用于区域定位。

证书、截图和表格按定位坐标机械裁剪，不进行客户端 OCR。地址栏复核使用 `600 / 72` 的最小渲染缩放系数，从 PDF 页面直接生成裁剪大小的画布，并通过渲染变换只保留目标区域，避免把整页 600 DPI 图保存在内存中。若未来能稳定提取 PDF 内嵌原图，可优先使用原图；本轮使用规则允许的至少 600 DPI 回退路径。

每个地址栏生成：

1. 原始彩色 PNG。
2. 灰度并提高对比度的 PNG。

坐标缺失、裁剪为空、像素尺寸过小或超过安全上限时不得退回表格值，直接标记该 URL 无法完整验证。所有页面和裁剪图只存在于浏览器或单次请求内存中。

## 6. 确定性归一化规则

### 6.1 作品类型

先去除首尾空白，再使用显式映射，例如 `美术 -> 美术作品`。映射表只包含业务确认过的类别，不做模糊相似匹配。

### 6.2 平台

域名先转小写并去掉可选 `www.`，再映射到标准中文平台名，至少包含：

- `weibo.com -> 微博`
- `xiaohongshu.com -> 小红书`

域名与页面平台标识冲突时，使用域名映射值比较，同时记录冲突提示。未知域名不猜测平台。

### 6.3 发布者

只执行 `trim()` 后精确比较，不删除中间空格、不做大小写折叠、不推断别名。

### 6.4 时间

解析中文日期、`YYYY-M-D`、`YY-M-D` 及可选时分。两位年份只有在 `yearContextClear` 为真时才能扩展为四位年份。截图为“编辑于”时仍作为发布时间。

比较采用双方共同可验证的最高精度：任一方只有日期时比较年月日；双方都有时分时比较到分钟。识别结果始终保留截图中实际存在的分钟精度。

### 6.5 URL

- 仅接受 `http`/`https` 形式；无协议时补 `https://`。
- 删除全部查询参数和片段，而不是只删除常见跟踪参数。
- 删除路径末尾多余 `/`。
- 展示时主机名转小写；比较时额外忽略可选 `www.`。
- 路径与内容 ID 保留原始大小写并精确比较。
- 不自动替换任何易混淆字符。

截图 URL 只有在高清复核状态为 `recognized` 时才参与比较。否则展示“发布网址：未完整识别”，并输出“截图未完整识别，无法验证汇总表中的发布网址“{汇总表网址}””，不产生 URL 错误点。

## 7. 标准报告输出

结构化 JSON 是 UI 的数据源，同时由纯函数生成规则文档要求的标准文本。

未提供证书时固定输出：

```text
【权利人名称、作品类型 - 识别结果】
pdf文件中未提供作品登记证书
```

并固定评估文本：

```text
1. 权利人名称、作品类型：pdf文件中未提供作品登记证书，不进行核查
```

提供证书时输出“提取著作权人”和“提取作品类型”。权利图与结果数量严格按第一阶段截图区域实际识别的分组输出，不为适配表格增删分组。

确认不一致使用“应为{截图识别值}，现错误填写为{汇总表值}”；无法识别使用“截图未识别，无法验证汇总表中的{字段值}”。每个错误字段独立编号，权利信息和详细发布信息两个大类分别输出“评估无错误”或其错误列表。

## 8. 失败、重试与状态门控

- 网络超时、429、可重试的 5xx 最多重试一次。
- JSON 解析或 Zod 校验失败允许一次纠正性重试；第二次仍失败则记录阶段失败。
- 不重试明确的请求体、鉴权、图片格式或 schema 边界错误。
- 任一页面或区域失败必须保留页码/区域 ID 和稳定错误码，不能静默丢失。
- 批次 warning 必须在客户端聚合并传入最终结果。
- 没有表格、表格行无法关联、截图区域遗漏、证书状态不确定、字段低置信度或 URL 未完整识别均不得显示 `passed`。

日志只记录请求 ID、阶段、耗时、状态码和计数，不记录原始 PDF、图片 base64、账号、URL、证书文字或 API key。

## 9. 前端交互

保留现有页面结构，只更新进度状态和结果展示，不进行视觉重构。进度依次显示：

- 正在定位证书、截图和汇总表
- 正在独立识别证书和网页截图
- 正在高清复核地址栏 URL
- 正在独立提取汇总表
- 正在关联截图与表格行
- 正在生成评估结论

结果页同时展示结构化卡片和可复制的标准文本。`verificationNotices` 使用人工复核提示样式，与确认错误样式区分。平台/域名冲突作为识别提示展示，不自动计为汇总表错误。

## 10. 跨平台部署准备

现有 `package.json` 在 Windows 上使用 `WRANGLER_LOG_PATH=... command` 会直接失败。本轮将用小型 Node 启动脚本跨平台设置 `WRANGLER_LOG_PATH`，保持 `npm run dev/build/start` 命令和 vinext 架构不变，不引入仅为设置环境变量而存在的新依赖。

开发与验证继续要求 Node.js `>=22.13.0`。`.openai/hosting.json`、现有 package manager 和 lockfile保持不变；本轮只完成本地代码和构建验证，不执行发布。

## 11. 测试策略与验收标准

所有行为变更遵循测试先行。至少覆盖：

- layout schema 无任何业务文本输出，并拒绝非法坐标、重复 ID 和错误父子关系。
- evidence 和 table 请求无法携带对方阶段的数据，提示词和请求构造不共享上下文。
- 所有截图 URL 都要求彩色/灰度 600 DPI 复核记录。
- 两次 URL 读取不一致时列出差异字符，易混淆字符不被自动替换。
- 域名或路径不完整时产生 `unverifiable`，不产生 URL mismatch。
- URL 删除所有 query/hash/trailing slash，host/`www.` 等价而 path 大小写敏感。
- 发布者只 trim，作品类型显式映射，编辑时间按发布时间，分钟/日期按共同精度比较。
- 未提供证书时输出固定文本且不比较权利信息；证书状态不确定时 `needs_review`。
- 每个字段 mismatch 独立生成错误点，无法识别进入单独提示。
- 批次 warning 不丢失，阶段失败不能得到 `passed`。
- API 继续验证图片、大小、同源/认证和模型 schema，并保持通用错误响应。
- Windows、Linux 均能执行 `npm run build` 的脚本入口。

最终验证包括单元/API 测试、TypeScript typecheck、ESLint、生产构建和现有源代码安全测试。模型真实调用依赖用户配置的 `BAILIAN_API_KEY`，自动测试使用注入的模型客户端，不访问真实外部服务。

## 12. 非目标

- 不切换或抽象模型供应商。
- 不新增数据库、对象存储、后台队列或文档持久化。
- 不把 PDF、测试样例或识别图片提交到 Git。
- 不自动访问识别出的 URL，也不做网页反向搜索。
- 不执行部署、GitHub 推送或 PR 创建。
