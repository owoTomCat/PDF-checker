/**
 * PDF 外网溯源报告严格核验规则。
 *
 * 本模块只消费已经隔离并通过 schema 校验的证书、截图、URL 复核和
 * 汇总表数据，不读取 PDF、不调用模型，也不访问识别出的 URL。
 */

export const PDF_AUDIT_RULES = Object.freeze({
  version: "2.0.0",
  workflow: ["截图独立识别", "汇总表独立提取", "归一化比较"],
  ambiguousUrlCharacters: ["6/b", "0/O", "1/l/I", "5/S", "8/B"],
  noCertificateRecognition: "pdf文件中未提供作品登记证书",
  noCertificateEvaluation:
    "pdf文件中未提供作品登记证书，不进行核查",
});

const WORK_TYPE_ALIASES = new Map([
  ["美术", "美术作品"],
  ["美术作品", "美术作品"],
]);

const PLATFORM_ALIASES = new Map([
  ["weibo", "微博"],
  ["微博", "微博"],
  ["xiaohongshu", "小红书"],
  ["小红书", "小红书"],
  ["douyin", "抖音"],
  ["抖音", "抖音"],
]);

const PLATFORM_BY_DOMAIN = new Map([
  ["weibo.com", "微博"],
  ["xiaohongshu.com", "小红书"],
]);

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function recognizedText(observation) {
  if (!observation || observation.status !== "recognized") return null;
  const value = text(observation.rawText);
  return value || null;
}

function displayObservation(observation) {
  const value = recognizedText(observation);
  if (value) return value;
  return observation?.status === "partial" ? "未完整识别" : "未识别";
}

export function normalizeWorkType(value) {
  const normalized = text(value);
  return WORK_TYPE_ALIASES.get(normalized) ?? normalized;
}

export function normalizePlatform(value) {
  const normalized = text(value);
  return (
    PLATFORM_ALIASES.get(normalized.toLowerCase()) ??
    PLATFORM_ALIASES.get(normalized) ??
    normalized
  );
}

export function comparePublisher(left, right) {
  return text(left) === text(right);
}

function hostFromValue(value) {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return "";
  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
    );
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      .toLowerCase()
      .replace(/^www\./, "");
  }
}

function platformFromHost(value) {
  const host = hostFromValue(value);
  for (const [domain, platform] of PLATFORM_BY_DOMAIN) {
    if (host === domain || host.endsWith(`.${domain}`)) return platform;
  }
  return "";
}

function resolvedScreenshotPlatform(screenshot) {
  const visible = recognizedText(screenshot?.visiblePlatform);
  const visiblePlatform = visible ? normalizePlatform(visible) : "";
  const host = recognizedText(screenshot?.addressHost);
  const domainPlatform = host ? platformFromHost(host) : "";
  return {
    value: domainPlatform || visiblePlatform,
    conflict:
      Boolean(domainPlatform) &&
      Boolean(visiblePlatform) &&
      domainPlatform !== visiblePlatform,
    visiblePlatform,
    domainPlatform,
  };
}

/**
 * 返回仅用于比较的规范 URL。协议、www、全部查询参数、片段和末尾斜杠
 * 不参与比较；路径大小写保持不变。
 */
export function canonicalPostUrl(value) {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return "";
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return "";
  }
}

export function stableDisplayUrl(value) {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return "";
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return "";
  }
}

function parsePublishedAt(value, yearContextClear) {
  const normalized = text(value)
    .replace(/^(?:编辑于|发布于|发表于)\s*/, "")
    .replace(/[年/.]/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, " ");
  const match = normalized.match(
    /(?:^|\D)(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/,
  );
  if (!match) return null;

  let year = Number(match[1]);
  if (year < 100) {
    if (!yearContextClear) return null;
    year += 2000;
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    hasTime: match[4] !== undefined,
  };
}

export function comparePublishedAt(
  screenshotValue,
  tableValue,
  yearContextClear = true,
) {
  const screenshot = parsePublishedAt(screenshotValue, yearContextClear);
  const table = parsePublishedAt(tableValue, true);
  if (!screenshot || !table) return "unverifiable";
  if (
    screenshot.year !== table.year ||
    screenshot.month !== table.month ||
    screenshot.day !== table.day
  ) {
    return "mismatch";
  }
  if (!screenshot.hasTime || !table.hasTime) return "match";
  return screenshot.hour === table.hour && screenshot.minute === table.minute
    ? "match"
    : "mismatch";
}

function finding(
  code,
  scope,
  rightsImageIndex,
  resultIndex,
  field,
  message,
) {
  return {
    code,
    scope,
    rightsImageIndex,
    resultIndex,
    field,
    message,
  };
}

function resultPrefix(screenshot) {
  return `权利图-${screenshot.rightsImageIndex}，结果${screenshot.resultIndex}`;
}

function tableUrl(row) {
  return (row?.urlCellSegments ?? []).map((segment) => text(segment)).join("");
}

function unverifiableMessage(prefix, fieldLabel, tableValue, partial = false) {
  const recognition = partial ? "截图未完整识别" : "截图未识别";
  return `${prefix}，${recognition}，无法验证汇总表中的${fieldLabel}“${text(tableValue)}”`;
}

/**
 * 对已经隔离的结构化证据执行确定性核验。
 */
export function validatePdfAudit(input) {
  if (
    !input ||
    !Array.isArray(input.screenshots) ||
    !Array.isArray(input.tableRows) ||
    !Array.isArray(input.urlReviews) ||
    !Array.isArray(input.associations)
  ) {
    throw new TypeError("缺少严格核验输入，无法执行核验。");
  }

  const certificateIssues = [];
  const resultIssues = [];
  const verificationNotices = [];

  if (input.certificatePresence === "uncertain") {
    verificationNotices.push(
      finding(
        "CERTIFICATE_PRESENCE_UNCERTAIN",
        "RIGHTS",
        null,
        null,
        "structure",
        "作品登记证书提供状态未识别，无法核查权利人名称和作品类型",
      ),
    );
  } else if (input.certificatePresence === "provided") {
    const certificate = input.certificate;
    const header = input.tableHeader;
    const owner = recognizedText(certificate?.owner);
    const tableOwner = recognizedText(header?.rightsHolderName);
    if (!owner || !tableOwner) {
      verificationNotices.push(
        finding(
          "RIGHTS_HOLDER_UNVERIFIABLE",
          "RIGHTS",
          null,
          null,
          "rightsHolderName",
          `截图未识别，无法验证汇总表中的权利人名称“${text(
            header?.rightsHolderName?.rawText,
          )}”`,
        ),
      );
    } else if (text(owner) !== text(tableOwner)) {
      certificateIssues.push(
        finding(
          "RIGHTS_HOLDER_MISMATCH",
          "RIGHTS",
          null,
          null,
          "rightsHolderName",
          `权利人填写错误，应为${owner}，现错误填写为${tableOwner}`,
        ),
      );
    }

    const workType = recognizedText(certificate?.workType);
    const tableWorkType = recognizedText(header?.workType);
    if (!workType || !tableWorkType) {
      verificationNotices.push(
        finding(
          "WORK_TYPE_UNVERIFIABLE",
          "RIGHTS",
          null,
          null,
          "workType",
          `截图未识别，无法验证汇总表中的作品类型“${text(
            header?.workType?.rawText,
          )}”`,
        ),
      );
    } else if (
      normalizeWorkType(workType) !== normalizeWorkType(tableWorkType)
    ) {
      certificateIssues.push(
        finding(
          "WORK_TYPE_MISMATCH",
          "RIGHTS",
          null,
          null,
          "workType",
          `作品类型填写错误，应为${normalizeWorkType(
            workType,
          )}，现错误填写为${tableWorkType}`,
        ),
      );
    }
  }

  const tableRows = new Map(
    input.tableRows.map((row) => [row.tableRowId, row]),
  );
  const urlReviews = new Map(
    input.urlReviews.map((review) => [review.screenshotId, review]),
  );
  const associations = new Map();
  for (const association of input.associations) {
    if (associations.has(association.screenshotId)) {
      verificationNotices.push(
        finding(
          "DUPLICATE_ASSOCIATION",
          "STRUCTURE",
          null,
          null,
          "association",
          `截图 ${association.screenshotId} 存在重复表格关联，需人工复核`,
        ),
      );
    }
    associations.set(association.screenshotId, association);
  }

  const usedTableRows = new Set();
  const screenshots = [...input.screenshots].sort(
    (left, right) =>
      left.rightsImageIndex - right.rightsImageIndex ||
      left.resultIndex - right.resultIndex ||
      left.pageNumber - right.pageNumber,
  );

  for (const screenshot of screenshots) {
    const prefix = resultPrefix(screenshot);
    const association = associations.get(screenshot.screenshotId);
    if (
      !association ||
      !association.tableRowId ||
      association.confidence < 0.8
    ) {
      verificationNotices.push(
        finding(
          "ASSOCIATION_UNVERIFIABLE",
          "STRUCTURE",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "association",
          `${prefix}，无法唯一关联汇总表结果行`,
        ),
      );
      continue;
    }

    const row = tableRows.get(association.tableRowId);
    if (!row) {
      verificationNotices.push(
        finding(
          "TABLE_ROW_UNVERIFIABLE",
          "STRUCTURE",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "association",
          `${prefix}，关联的汇总表结果行不存在`,
        ),
      );
      continue;
    }
    usedTableRows.add(row.tableRowId);

    const screenshotPlatform = resolvedScreenshotPlatform(screenshot);
    const rowPlatform = recognizedText(row.platform);
    if (screenshotPlatform.conflict) {
      verificationNotices.push(
        finding(
          "PLATFORM_SOURCE_CONFLICT",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "platform",
          `${prefix}，页面平台标识“${screenshotPlatform.visiblePlatform}”与地址栏域名平台“${screenshotPlatform.domainPlatform}”冲突，已按地址栏域名识别`,
        ),
      );
    }
    if (!screenshotPlatform.value || !rowPlatform) {
      verificationNotices.push(
        finding(
          "PLATFORM_UNVERIFIABLE",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "platform",
          unverifiableMessage(prefix, "发布平台", row.platform?.rawText),
        ),
      );
    } else if (
      screenshotPlatform.value !== normalizePlatform(rowPlatform)
    ) {
      resultIssues.push(
        finding(
          "PLATFORM_MISMATCH",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "platform",
          `${prefix}，发布平台错误，应为${screenshotPlatform.value}，现错误填写为${rowPlatform}`,
        ),
      );
    }

    const publisher = recognizedText(screenshot.publisher);
    const rowPublisher = recognizedText(row.publisher);
    if (!publisher || !rowPublisher) {
      verificationNotices.push(
        finding(
          "PUBLISHER_UNVERIFIABLE",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "publisher",
          unverifiableMessage(prefix, "发布者", row.publisher?.rawText),
        ),
      );
    } else if (!comparePublisher(publisher, rowPublisher)) {
      resultIssues.push(
        finding(
          "PUBLISHER_MISMATCH",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "publisher",
          `${prefix}，发布者错误，应为${publisher}，现错误填写为${rowPublisher}`,
        ),
      );
    }

    const publishedAt = recognizedText(screenshot.publishedAt);
    const rowPublishedAt = recognizedText(row.publishedAt);
    const timeState =
      publishedAt && rowPublishedAt
        ? comparePublishedAt(
            publishedAt,
            rowPublishedAt,
            screenshot.publishedAt.yearContextClear,
          )
        : "unverifiable";
    if (timeState === "unverifiable") {
      verificationNotices.push(
        finding(
          "PUBLISHED_AT_UNVERIFIABLE",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "publishedAt",
          unverifiableMessage(prefix, "发布时间", row.publishedAt?.rawText),
        ),
      );
    } else if (timeState === "mismatch") {
      resultIssues.push(
        finding(
          "PUBLISHED_AT_MISMATCH",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "publishedAt",
          `${prefix}，发布时间错误，应为${publishedAt}，现错误填写为${rowPublishedAt}`,
        ),
      );
    }

    const review = urlReviews.get(screenshot.screenshotId);
    const summaryUrl = tableUrl(row);
    const reviewedUrl =
      review?.status === "recognized" &&
      review.unresolvedCharacters.length === 0
        ? text(review.finalRead)
        : "";
    const screenshotCanonical = canonicalPostUrl(reviewedUrl);
    const tableCanonical = canonicalPostUrl(summaryUrl);
    if (!reviewedUrl || !screenshotCanonical || !tableCanonical) {
      verificationNotices.push(
        finding(
          "URL_UNVERIFIABLE",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "url",
          unverifiableMessage(prefix, "发布网址", summaryUrl, true),
        ),
      );
    } else if (screenshotCanonical !== tableCanonical) {
      resultIssues.push(
        finding(
          "URL_MISMATCH",
          "RESULT",
          screenshot.rightsImageIndex,
          screenshot.resultIndex,
          "url",
          `${prefix}，发布网址错误，应为${stableDisplayUrl(
            reviewedUrl,
          )}，现错误填写为${summaryUrl}`,
        ),
      );
    }
  }

  for (const row of input.tableRows) {
    if (!usedTableRows.has(row.tableRowId)) {
      verificationNotices.push(
        finding(
          "TABLE_ROW_WITHOUT_SCREENSHOT",
          "STRUCTURE",
          row.rightsImageIndex,
          row.resultIndex,
          "association",
          `权利图-${row.rightsImageIndex}，结果${row.resultIndex}，汇总表结果行没有可验证的截图对应项`,
        ),
      );
    }
  }

  return {
    input,
    certificateIssues,
    resultIssues,
    issues: [...certificateIssues, ...resultIssues],
    verificationNotices,
  };
}

function displayPublishedAt(observation) {
  const value = recognizedText(observation);
  return value
    ? value.replace(/^(?:编辑于|发布于|发表于)\s*/, "")
    : displayObservation(observation);
}

function formatCategory(lines, number, label, issues, notices) {
  if (issues.length === 0 && notices.length === 0) {
    lines.push(`${number}. ${label}：评估无错误`);
    return;
  }
  if (issues.length === 0) {
    lines.push(`${number}. ${label}：存在无法验证字段，需人工复核`);
  } else {
    lines.push(`${number}. ${label}：`);
    issues.forEach((issue, index) => {
      lines.push(`   - 错误点${index + 1}：${issue.message}`);
    });
  }
  notices.forEach((notice) => {
    lines.push(`   - 复核提示：${notice.message}`);
  });
}

/** 输出规则文档约定的中文结构。 */
export function formatPdfAuditReport(report) {
  const { input, certificateIssues, resultIssues, verificationNotices } = report;
  const lines = ["{", "【权利人名称、作品类型 - 识别结果】"];

  if (input.certificatePresence === "not_provided") {
    lines.push(PDF_AUDIT_RULES.noCertificateRecognition);
  } else if (input.certificatePresence === "uncertain") {
    lines.push("作品登记证书提供状态未识别");
  } else {
    lines.push(
      `提取著作权人：${displayObservation(input.certificate?.owner)}`,
      `提取作品类型：${normalizeWorkType(
        displayObservation(input.certificate?.workType),
      )}`,
    );
  }

  lines.push("", "【权利图 - 识别结果】");
  const groups = new Map();
  for (const screenshot of input.screenshots) {
    const group = groups.get(screenshot.rightsImageIndex) ?? [];
    group.push(screenshot);
    groups.set(screenshot.rightsImageIndex, group);
  }
  for (const [rightsImageIndex, screenshots] of [...groups.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    lines.push(`【权利图-${rightsImageIndex}】`);
    screenshots
      .sort((left, right) => left.resultIndex - right.resultIndex)
      .forEach((screenshot) => {
        const platform = resolvedScreenshotPlatform(screenshot).value;
        const review = input.urlReviews.find(
          (item) => item.screenshotId === screenshot.screenshotId,
        );
        const displayUrl =
          review?.status === "recognized" &&
          review.unresolvedCharacters.length === 0
            ? stableDisplayUrl(review.finalRead)
            : "";
        lines.push(
          `【结果${screenshot.resultIndex}识别结果】`,
          `发布平台：${platform || displayObservation(screenshot.visiblePlatform)}`,
          `发布者：${displayObservation(screenshot.publisher)}`,
          `发布时间：${displayPublishedAt(screenshot.publishedAt)}`,
          `发布网址：${displayUrl || "未完整识别"}`,
        );
      });
  }

  lines.push("", "【评估结果】");
  const rightsNotices = verificationNotices.filter(
    (notice) => notice.scope === "RIGHTS",
  );
  const detailNotices = verificationNotices.filter(
    (notice) => notice.scope !== "RIGHTS",
  );
  if (input.certificatePresence === "not_provided") {
    lines.push(
      `1. 权利人名称、作品类型：${PDF_AUDIT_RULES.noCertificateEvaluation}`,
    );
  } else {
    formatCategory(
      lines,
      1,
      "权利人名称、作品类型",
      certificateIssues,
      rightsNotices,
    );
  }
  formatCategory(
    lines,
    2,
    "详细发布信息",
    resultIssues,
    detailNotices,
  );

  lines.push("}");
  return lines.join("\n");
}
