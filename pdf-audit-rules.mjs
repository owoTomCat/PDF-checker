/**
 * PDF 外网溯源报告核验规则模块
 *
 * 用途：供后续 Codex Sites/Node.js 站点接入 PDF 渲染、OCR 或视觉模型后复用。
 * 本文件不负责读取 PDF；调用方需要先把 PDF 页面转换成结构化识别结果，
 * 再调用 validatePdfAudit() 和 formatPdfAuditReport()。
 */

export const PDF_AUDIT_RULES = Object.freeze({
  version: "1.0.0",
  firstPage: {
    tableFields: ["案号", "反馈时间", "权利人名称", "作品类型"],
    certificateTitle: "作品登记证书",
    certificateFields: ["著作权人", "作品类型"],
    noCertificateAction: "未提供「作品登记证书」，无需核验。",
  },
  resultTable: {
    columns: [
      "序号",
      "网络出处",
      "上传者",
      "网址",
      "图片对比结果",
      "网络端发表时间",
      "查重时间",
    ],
    ignoredColumns: ["图片对比结果"],
  },
  grouping: {
    rule: "PDF 中每个结果表格都必须独立核验，不得因帖子相同而合并或去重。",
    labelPattern: "权利图-x",
  },
  extraction: {
    rule: "帖子信息必须从“结果n出处截图和信息截图”独立提取，禁止用表格反填。",
    postFields: ["发布平台", "发布者", "发布时间", "发布网址"],
    unreadableRule: "无法辨认时标记为无法识别，不得猜测。",
  },
  comparisons: {
    fields: ["网络出处", "上传者", "网址", "网络端发表时间"],
    datePrecision:
      "表格只有日期、截图包含时分秒时，只要自然日相同即视为一致。",
    urlNormalization:
      "协议、www、末尾斜杠和明确的分享追踪参数差异不构成错误；帖子标识必须一致。",
    textNormalization:
      "只忽略排版造成的空格和换行；账号正文中的文字、数字、符号不得随意删除。",
  },
  chronology: {
    invalidResult: "无效查重的网络端发表时间应晚于查重时间。",
    otherResult: "其他类型查重的网络端发表时间应早于或等于查重时间。",
  },
});

export const PDF_AUDIT_WORKFLOW = Object.freeze([
  "渲染 PDF 第一页，读取案号、反馈时间、权利人名称、作品类型。",
  "检查第一页的1至2张图片中是否存在标题为“作品登记证书”的图片。",
  "存在证书时，独立提取著作权人和作品类型，并与首页表格核验。",
  "扫描整份 PDF，定位每一个结果表格及其所属权利图编号。",
  "每个表格单独建立权利图分组；结果编号在不同表格中可重复。",
  "定位每个“结果n出处截图和信息截图”页面，独立提取帖子信息。",
  "将截图信息与同组表格对应行逐字段比较，并检查序号空白行。",
  "根据表格所属查重类型，检查发表时间与查重时间的先后关系。",
  "汇总全部错误并按固定中文格式输出；无错误时输出统一结论。",
]);

export const RESULT_KIND = Object.freeze({
  VALID: "VALID",
  POSSIBLY_VALID: "POSSIBLY_VALID",
  PARTIALLY_VALID: "PARTIALLY_VALID",
  INVALID: "INVALID",
  OTHER_NON_INVALID: "OTHER_NON_INVALID",
});

/**
 * @typedef {Object} FirstPageTable
 * @property {string} caseNumber
 * @property {string} feedbackDate
 * @property {string} rightsHolderName
 * @property {string} workType
 */

/**
 * @typedef {Object} CertificateExtraction
 * @property {boolean} isRegistrationCertificate
 * @property {string|null} copyrightOwner
 * @property {string|null} workType
 * @property {number|null} [sourcePage]
 */

/**
 * @typedef {Object} ScreenshotPostExtraction
 * @property {string} resultId 例如“结果1”
 * @property {string|null} platform
 * @property {string|null} publisher
 * @property {string|null} publishedAt
 * @property {string|null} url
 * @property {number|null} [sourcePage]
 */

/**
 * @typedef {Object} ResultTableRow
 * @property {string|null} resultId 序号列为空时必须传 null
 * @property {string} networkSource
 * @property {string} uploader
 * @property {string} url
 * @property {string} imageComparisonResult 仅保存，不参与额外核验
 * @property {string} networkPublishedAt
 * @property {string} checkedAt 合并单元格的值应复制到所属的每一行
 * @property {string} resultKind 使用 RESULT_KIND 中的值
 */

/**
 * @typedef {Object} RightImageGroup
 * @property {string} label 例如“权利图-1”
 * @property {number} tablePage
 * @property {ResultTableRow[]} tableRows
 * @property {ScreenshotPostExtraction[]} screenshotResults
 */

/**
 * @typedef {Object} PdfAuditInput
 * @property {FirstPageTable} firstPageTable
 * @property {CertificateExtraction|null} certificate
 * @property {RightImageGroup[]} groups
 */

/**
 * @typedef {Object} AuditIssue
 * @property {string} code
 * @property {"CERTIFICATE"|"RESULT"|"CHRONOLOGY"|"STRUCTURE"} scope
 * @property {string|null} groupLabel
 * @property {string|null} resultId
 * @property {string} message
 */

const TRACKING_QUERY_KEYS = new Set([
  "app_platform",
  "app_version",
  "ignoreengage",
  "sec_source",
  "share_from_user_hidden",
  "type",
  "xsec_source",
  "xsec_token",
]);

const PLATFORM_ALIASES = new Map([
  ["douyin", "抖音"],
  ["抖音", "抖音"],
  ["xiaohongshu", "小红书"],
  ["小红书", "小红书"],
  ["weibo", "微博"],
  ["微博", "微博"],
  ["facebook", "Facebook"],
  ["汇图网", "汇图网"],
]);

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function compactText(value) {
  return text(value).replace(/\s+/g, "");
}

function normalizeOwner(value) {
  return compactText(value).replace(
    /[（(][^）)]*[＊*]{2,}[^）)]*[）)]/g,
    "",
  );
}

function displayCertificateOwner(value) {
  return normalizeOwner(value) || "无法识别";
}

export function normalizePlatform(value) {
  const normalized = compactText(value);
  return PLATFORM_ALIASES.get(normalized.toLowerCase()) ??
    PLATFORM_ALIASES.get(normalized) ??
    normalized;
}

/**
 * 生成用于帖子身份比较的规范网址。不会返回给用户展示。
 */
export function canonicalPostUrl(value) {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return "";

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;

  try {
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const params = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING_QUERY_KEYS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = new URLSearchParams(params).toString();
    return `${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return raw
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "");
  }
}

function parseDateTime(value) {
  const normalized = text(value)
    .replace(/[年/.]/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, " ");
  const match = normalized.match(
    /(\d{2,4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/,
  );
  if (!match) return null;

  let year = Number(match[1]);
  if (year < 100) year += 2000;

  const parts = {
    year,
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
    hasTime: match[4] !== undefined,
    hasSecond: match[6] !== undefined,
  };
  parts.timestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return parts;
}

function samePublishedAt(left, right) {
  const a = parseDateTime(left);
  const b = parseDateTime(right);
  if (!a || !b) return compactText(left) === compactText(right);

  const sameDate =
    a.year === b.year && a.month === b.month && a.day === b.day;
  if (!sameDate) return false;

  // 任一侧只有日期时，以自然日为比较精度。
  if (!a.hasTime || !b.hasTime) return true;
  if (a.hour !== b.hour || a.minute !== b.minute) return false;
  if (!a.hasSecond || !b.hasSecond) return true;
  return a.second === b.second;
}

function compareDateTime(left, right) {
  const a = parseDateTime(left);
  const b = parseDateTime(right);
  if (!a || !b) return null;

  const sameDate =
    a.year === b.year && a.month === b.month && a.day === b.day;
  // 任一侧只有日期时，同一自然日不能推定具体先后。
  if (sameDate && (!a.hasTime || !b.hasTime)) return 0;
  return Math.sign(a.timestamp - b.timestamp);
}

function makeIssue(code, scope, message, groupLabel = null, resultId = null) {
  return { code, scope, groupLabel, resultId, message };
}

function valueOrUnreadable(value) {
  return text(value) || "无法识别";
}

function resultPrefix(groupLabel, resultId) {
  return `${groupLabel}${resultId ? ` ${resultId}` : ""}`;
}

/**
 * 对已经完成 OCR/视觉识别的结构化数据执行全部规则核验。
 * @param {PdfAuditInput} input
 */
export function validatePdfAudit(input) {
  if (!input?.firstPageTable || !Array.isArray(input.groups)) {
    throw new TypeError("缺少 firstPageTable 或 groups，无法执行核验。");
  }

  /** @type {AuditIssue[]} */
  const certificateIssues = [];
  /** @type {AuditIssue[]} */
  const resultIssues = [];
  const certificate = input.certificate;

  if (certificate?.isRegistrationCertificate) {
    if (!text(certificate.copyrightOwner)) {
      certificateIssues.push(
        makeIssue(
          "CERTIFICATE_OWNER_UNREADABLE",
          "CERTIFICATE",
          "作品登记证书中的著作权人无法识别",
        ),
      );
    } else if (
      normalizeOwner(certificate.copyrightOwner) !==
      normalizeOwner(input.firstPageTable.rightsHolderName)
    ) {
      certificateIssues.push(
        makeIssue(
          "RIGHTS_HOLDER_MISMATCH",
          "CERTIFICATE",
          `权利人名称填写错误，应为${displayCertificateOwner(certificate.copyrightOwner)}，现错误填写为${text(input.firstPageTable.rightsHolderName)}`,
        ),
      );
    }

    if (!text(certificate.workType)) {
      certificateIssues.push(
        makeIssue(
          "CERTIFICATE_WORK_TYPE_UNREADABLE",
          "CERTIFICATE",
          "作品登记证书中的作品类型无法识别",
        ),
      );
    } else if (
      compactText(certificate.workType) !==
      compactText(input.firstPageTable.workType)
    ) {
      certificateIssues.push(
        makeIssue(
          "WORK_TYPE_MISMATCH",
          "CERTIFICATE",
          `作品类型填写错误，应为${text(certificate.workType)}，现错误填写为${text(input.firstPageTable.workType)}`,
        ),
      );
    }
  }

  for (const group of input.groups) {
    const groupLabel = text(group.label) || "未标注权利图";
    const screenshotByResult = new Map(
      (group.screenshotResults ?? []).map((item) => [
        compactText(item.resultId),
        item,
      ]),
    );

    for (const row of group.tableRows ?? []) {
      const resultId = compactText(row.resultId);
      if (!resultId) {
        resultIssues.push(
          makeIssue(
            "EMPTY_SEQUENCE",
            "STRUCTURE",
            `${groupLabel}表格中存在序号为空的行，无法确定其对应结果`,
            groupLabel,
          ),
        );
        continue;
      }

      const screenshot = screenshotByResult.get(resultId);
      if (!screenshot) {
        resultIssues.push(
          makeIssue(
            "SCREENSHOT_NOT_FOUND",
            "STRUCTURE",
            `${resultPrefix(groupLabel, resultId)}未找到对应的出处截图和信息截图`,
            groupLabel,
            resultId,
          ),
        );
        continue;
      }

      const expectedPlatform = valueOrUnreadable(screenshot.platform);
      const expectedPublisher = valueOrUnreadable(screenshot.publisher);
      const expectedUrl = valueOrUnreadable(screenshot.url);
      const expectedPublishedAt = valueOrUnreadable(screenshot.publishedAt);

      if (!text(screenshot.platform)) {
        resultIssues.push(
          makeIssue(
            "SCREENSHOT_PLATFORM_UNREADABLE",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}截图中的发布平台无法识别`,
            groupLabel,
            resultId,
          ),
        );
      } else if (
        normalizePlatform(screenshot.platform) !==
        normalizePlatform(row.networkSource)
      ) {
        resultIssues.push(
          makeIssue(
            "PLATFORM_MISMATCH",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}表格中网络出处填写错误，应为${expectedPlatform}，表格中错误写为${text(row.networkSource)}`,
            groupLabel,
            resultId,
          ),
        );
      }

      if (!text(screenshot.publisher)) {
        resultIssues.push(
          makeIssue(
            "SCREENSHOT_PUBLISHER_UNREADABLE",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}截图中的发布者无法识别`,
            groupLabel,
            resultId,
          ),
        );
      } else if (
        compactText(screenshot.publisher) !== compactText(row.uploader)
      ) {
        resultIssues.push(
          makeIssue(
            "PUBLISHER_MISMATCH",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}表格中发布者填写错误，应为${expectedPublisher}，表格中错误写为${text(row.uploader)}`,
            groupLabel,
            resultId,
          ),
        );
      }

      if (!text(screenshot.url)) {
        resultIssues.push(
          makeIssue(
            "SCREENSHOT_URL_UNREADABLE",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}截图中的发布网址无法识别`,
            groupLabel,
            resultId,
          ),
        );
      } else if (canonicalPostUrl(screenshot.url) !== canonicalPostUrl(row.url)) {
        resultIssues.push(
          makeIssue(
            "URL_MISMATCH",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}表格中发布网址填写错误，应为${expectedUrl}，表格中错误写为${text(row.url)}`,
            groupLabel,
            resultId,
          ),
        );
      }

      if (!text(screenshot.publishedAt)) {
        resultIssues.push(
          makeIssue(
            "SCREENSHOT_PUBLISHED_AT_UNREADABLE",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}截图中的发布时间无法识别`,
            groupLabel,
            resultId,
          ),
        );
      } else if (!samePublishedAt(screenshot.publishedAt, row.networkPublishedAt)) {
        resultIssues.push(
          makeIssue(
            "PUBLISHED_AT_MISMATCH",
            "RESULT",
            `${resultPrefix(groupLabel, resultId)}表格中网络端发表时间填写错误，应为${expectedPublishedAt}，表格中错误写为${text(row.networkPublishedAt)}`,
            groupLabel,
            resultId,
          ),
        );
      }

      const chronology = compareDateTime(
        row.networkPublishedAt,
        row.checkedAt,
      );
      if (chronology === null) {
        resultIssues.push(
          makeIssue(
            "CHRONOLOGY_UNREADABLE",
            "CHRONOLOGY",
            `${resultPrefix(groupLabel, resultId)}无法判断网络端发表时间与查重时间的先后关系`,
            groupLabel,
            resultId,
          ),
        );
      } else if (
        row.resultKind === RESULT_KIND.INVALID &&
        chronology <= 0
      ) {
        resultIssues.push(
          makeIssue(
            "INVALID_RESULT_TIME_ORDER",
            "CHRONOLOGY",
            `${resultPrefix(groupLabel, resultId)}属于无效查重，但网络端发表时间${text(row.networkPublishedAt)}未晚于查重时间${text(row.checkedAt)}`,
            groupLabel,
            resultId,
          ),
        );
      } else if (
        row.resultKind !== RESULT_KIND.INVALID &&
        chronology > 0
      ) {
        resultIssues.push(
          makeIssue(
            "NON_INVALID_RESULT_TIME_ORDER",
            "CHRONOLOGY",
            `${resultPrefix(groupLabel, resultId)}不属于无效查重，但网络端发表时间${text(row.networkPublishedAt)}晚于查重时间${text(row.checkedAt)}`,
            groupLabel,
            resultId,
          ),
        );
      }
    }
  }

  return {
    input,
    certificateIssues,
    resultIssues,
    issues: [...certificateIssues, ...resultIssues],
  };
}

/**
 * 输出用户约定的中文格式。
 * @param {ReturnType<typeof validatePdfAudit>} report
 */
export function formatPdfAuditReport(report) {
  const { input, certificateIssues, issues } = report;
  const lines = ["{", "【权利人名称、作品类型 - 识别结果】"];
  const certificate = input.certificate;

  if (!certificate?.isRegistrationCertificate) {
    lines.push("未提供「作品登记证书」，无需核验。");
  } else {
    lines.push(
      `提取著作权人：${displayCertificateOwner(certificate.copyrightOwner)}`,
      `提取作品类型：${valueOrUnreadable(certificate.workType)}`,
    );
    if (certificateIssues.length === 0) {
      lines.push("核验「权利人名称」与「作品类型」无错误。");
    } else {
      for (const issue of certificateIssues) {
        lines.push(`错误${issues.indexOf(issue) + 1} ：${issue.message}`);
      }
    }
  }

  lines.push("", "【权利图 - 识别结果】");
  for (const group of input.groups) {
    lines.push("", `【${text(group.label) || "未标注权利图"}】`);
    for (const result of group.screenshotResults ?? []) {
      lines.push(
        `【${text(result.resultId)}识别结果】`,
        `发布平台：${valueOrUnreadable(result.platform)}`,
        `发布者：${valueOrUnreadable(result.publisher)}`,
        `发布时间：${valueOrUnreadable(result.publishedAt)}`,
        `发布网址：${valueOrUnreadable(result.url)}`,
      );
    }
  }

  lines.push("", "【评估结果】：");
  if (issues.length === 0) {
    lines.push("经核查，pdf中无错误");
  } else {
    issues.forEach((issue, index) => {
      lines.push(`错误${index + 1} ：${issue.message}`);
    });
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * 可直接交给视觉模型/OCR编排层的提取约束。
 */
export const PDF_AUDIT_EXTRACTION_PROMPT = `
你正在核验一份“外网溯源结果报告”PDF。

1. 首页：
   - 提取案号、反馈时间、权利人名称、作品类型。
   - 检查附图是否有标题为“作品登记证书”的证书。
   - 只有确认是作品登记证书时，才提取著作权人和作品类型。

2. 结果表格：
   - 定位整份PDF中的每一个表格，按“权利图-x”分别建组。
   - 不得因不同表格出现同一帖子而合并或去重。
   - 提取序号、网络出处、上传者、网址、图片对比结果、网络端发表时间、查重时间。
   - 序号单元格为空时必须保留为空，不能自动补结果编号。
   - 合并的查重时间单元格应归属于它覆盖的每一行。

3. 出处截图：
   - 从每个“结果n出处截图和信息截图”页面独立提取发布平台、发布者、发布时间、发布网址。
   - 禁止参考表格来补全截图中看不清的信息；无法识别时返回 null。

4. 返回结构必须符合本模块 PdfAuditInput 的 JSDoc 数据契约。
`.trim();
