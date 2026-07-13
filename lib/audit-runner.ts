import type { ExtractionSummary } from "./types";
import { extractPdfText } from "./pdf-text-extractor";
import {
  RESULT_KIND,
  formatPdfAuditReport,
  validatePdfAudit,
} from "../pdf-audit-rules.mjs";

type FirstPageTable = {
  caseNumber: string;
  feedbackDate: string;
  rightsHolderName: string;
  workType: string;
};

type CertificateExtraction = {
  isRegistrationCertificate: boolean;
  copyrightOwner: string | null;
  workType: string | null;
  sourcePage?: number | null;
};

type ResultTableRow = {
  resultId: string | null;
  networkSource: string;
  uploader: string;
  url: string;
  imageComparisonResult: string;
  networkPublishedAt: string;
  checkedAt: string;
  resultKind: string;
};

type ScreenshotPostExtraction = {
  resultId: string;
  platform: string | null;
  publisher: string | null;
  publishedAt: string | null;
  url: string | null;
  sourcePage?: number | null;
};

type RightImageGroup = {
  label: string;
  tablePage: number;
  tableRows: ResultTableRow[];
  screenshotResults: ScreenshotPostExtraction[];
};

type PdfAuditInput = {
  firstPageTable: FirstPageTable;
  certificate: CertificateExtraction | null;
  groups: RightImageGroup[];
};

export type AuditRunStoredResult = {
  input: PdfAuditInput;
  report: {
    certificateIssues: unknown[];
    resultIssues: unknown[];
    issues: unknown[];
  };
  summary: ExtractionSummary;
};

const PLATFORM_PATTERN = /(抖音|小红书|微博|Facebook|facebook|汇图网|douyin|xiaohongshu|weibo)/i;
const DATE_PATTERN = /\d{2,4}[-/.年]\d{1,2}[-/.月](?:3[01]|[12]\d|0?\d)(?:日)?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?/g;

function clean(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function compact(value: string | null | undefined) {
  return clean(value).replace(/\s+/g, "");
}

function makeParserText(value: string) {
  const lines = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const singleCharacterLines = lines.filter((line) => {
    const normalized = line.replace(/\s+/g, "");
    return normalized.length === 1;
  }).length;

  if (lines.length > 30 && singleCharacterLines / lines.length > 0.65) {
    return lines.join("");
  }

  return value;
}

function firstMatch(text: string, pattern: RegExp) {
  return clean(text.match(pattern)?.[1] ?? "");
}

function extractFirstPage(text: string): FirstPageTable {
  const firstChunk = text.slice(0, Math.min(text.length, 8000));
  const caseAndFeedback = firstChunk.match(
    /案号\s*([\s\S]{2,80}?)\s*反馈时间\s*([0-9年月日\-/.]+)/,
  );
  const holderAndType = firstChunk.match(
    /权利人名称\s*([\s\S]{2,160}?)\s*作品类型\s*(美术作品|摄影作品|文字作品|音乐作品|视听作品|录音制品|录像制品|图形作品|模型作品|其他作品|[^\n\r]{2,20})/,
  );

  return {
    caseNumber: clean(caseAndFeedback?.[1] ?? ""),
    feedbackDate: clean(caseAndFeedback?.[2] ?? ""),
    rightsHolderName: clean(holderAndType?.[1] ?? ""),
    workType: clean(holderAndType?.[2] ?? ""),
  };
}

function extractCertificate(text: string): CertificateExtraction | null {
  if (!/作品登记证书/.test(text)) {
    return { isRegistrationCertificate: false, copyrightOwner: null, workType: null };
  }

  const certificateWindow = text.slice(
    Math.max(0, text.indexOf("作品登记证书") - 1000),
    text.indexOf("作品登记证书") + 3000,
  );
  return {
    isRegistrationCertificate: true,
    copyrightOwner:
      firstMatch(certificateWindow, /著作权人[:：]?\s*([^\n\r]+)/) || null,
    workType:
      firstMatch(certificateWindow, /作品类型[:：]?\s*([^\n\r]+)/) || null,
  };
}

function getResultKind(block: string) {
  if (/无效查重结果|无效结果/.test(block)) return RESULT_KIND.INVALID;
  if (/部分有效/.test(block)) return RESULT_KIND.PARTIALLY_VALID;
  if (/可能有效|疑似有效/.test(block)) return RESULT_KIND.POSSIBLY_VALID;
  if (/有效查重结果|有效结果/.test(block)) return RESULT_KIND.VALID;
  return RESULT_KIND.OTHER_NON_INVALID;
}

function normalizeUrlFromBlock(block: string) {
  const squashed = compact(block);
  const url = squashed.match(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/);
  return url?.[0] ?? "";
}

function inferUploader(block: string, platform: string, url: string) {
  const lines = block
    .split(/\n+/)
    .map(clean)
    .filter(Boolean)
    .filter((line) => !/^结果\d+/.test(line))
    .filter((line) => !line.includes("审查员"))
    .filter((line) => !line.includes(url))
    .filter((line) => !PLATFORM_PATTERN.test(line))
    .filter((line) => !DATE_PATTERN.test(line))
    .filter((line) => !/疑似重复|完全重复|不重复|有效|无效|查重/.test(line));

  const candidate = lines.find((line) => line.length <= 40);
  return candidate ?? platform;
}

function extractDates(block: string, resultKind: string) {
  const dates = [...block.matchAll(DATE_PATTERN)].map((match) => clean(match[0]));
  if (dates.length === 0) {
    return { networkPublishedAt: "", checkedAt: "" };
  }
  if (dates.length === 1) {
    return { networkPublishedAt: dates[0], checkedAt: dates[0] };
  }

  const [first, second] = dates.slice(-2);
  if (resultKind === RESULT_KIND.INVALID) {
    return { networkPublishedAt: second, checkedAt: first };
  }
  return { networkPublishedAt: first > second ? second : first, checkedAt: first > second ? first : second };
}

function extractRowsFromTableBlock(block: string) {
  const resultKind = getResultKind(block);
  const tableStart = block.indexOf("查重时间");
  const rowArea = tableStart >= 0
    ? block.slice(tableStart + "查重时间".length)
    : block;
  const matches = [...rowArea.matchAll(/结果\s*(\d+)/g)];
  const rows: ResultTableRow[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const rowBlock = rowArea.slice(current.index, next?.index ?? rowArea.length);
    const platform = clean(rowBlock.match(PLATFORM_PATTERN)?.[1] ?? "");
    const url = normalizeUrlFromBlock(rowBlock);
    const { networkPublishedAt, checkedAt } = extractDates(rowBlock, resultKind);

    rows.push({
      resultId: `结果${current[1]}`,
      networkSource: platform,
      uploader: inferUploader(rowBlock, platform, url),
      url,
      imageComparisonResult: clean(
        rowBlock.match(/(疑似重复|完全重复|不重复|高度相似|相似)/)?.[1] ?? "",
      ),
      networkPublishedAt,
      checkedAt,
      resultKind,
    });
  }

  return rows;
}

function splitTableBlocks(text: string) {
  const starts = [...text.matchAll(/(?:疑似有效|有效|无效|部分有效|可能有效|其他).*?查重结果[:：]/g)];
  if (starts.length === 0) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1]?.index ?? text.length;
    const earlyScreenshot = text.indexOf("出处截图和信息截图", start.index);
    const screenshotHeadingStart =
      earlyScreenshot > start.index && earlyScreenshot < end
        ? text.lastIndexOf("结果", earlyScreenshot)
        : -1;
    const boundedEnd =
      screenshotHeadingStart > start.index ? screenshotHeadingStart : end;
    return text.slice(start.index, boundedEnd);
  });
}

function extractScreenshotResults(text: string) {
  const results = new Map<string, ScreenshotPostExtraction>();
  const matches = [...text.matchAll(/结果\s*(\d+)\s*出处截图和信息截图/g)];

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const block = text.slice(current.index, next?.index ?? current.index + 2500);
    const platform = clean(block.match(PLATFORM_PATTERN)?.[1] ?? "") || null;
    const url = normalizeUrlFromBlock(block) || null;
    const date = clean(block.match(DATE_PATTERN)?.[0] ?? "") || null;
    const publisher =
      firstMatch(block, /(?:发布者|上传者|作者|用户)[:：]?\s*([^\n\r]+)/) || null;

    results.set(`结果${current[1]}`, {
      resultId: `结果${current[1]}`,
      platform,
      publisher,
      publishedAt: date,
      url,
    });
  }

  return results;
}

function buildAuditInput(text: string): PdfAuditInput {
  const screenshotResults = extractScreenshotResults(text);
  const tableBlocks = splitTableBlocks(text);
  const groups = tableBlocks
    .map((block, index): RightImageGroup => {
      const tableRows = extractRowsFromTableBlock(block);
      return {
        label: `权利图-${index + 1}`,
        tablePage: index + 1,
        tableRows,
        screenshotResults: tableRows
          .map((row) => row.resultId)
          .filter((resultId): resultId is string => Boolean(resultId))
          .map(
            (resultId) =>
              screenshotResults.get(resultId) ?? {
                resultId,
                platform: null,
                publisher: null,
                publishedAt: null,
                url: null,
              },
          ),
      };
    })
    .filter((group) => group.tableRows.length > 0);

  return {
    firstPageTable: extractFirstPage(text),
    certificate: extractCertificate(text),
    groups,
  };
}

function summarize(
  input: PdfAuditInput,
  textLength: number,
  pageCount: number | null,
): ExtractionSummary {
  const tableRowCount = input.groups.reduce(
    (total, group) => total + group.tableRows.length,
    0,
  );
  const screenshotHeadingCount = input.groups.reduce(
    (total, group) =>
      total +
      group.screenshotResults.filter(
        (item) => item.platform || item.publisher || item.publishedAt || item.url,
      ).length,
    0,
  );
  const firstPageFields = Object.values(input.firstPageTable).filter(Boolean).length;
  const warnings: string[] = [];

  if (textLength < 100) {
    warnings.push("未能从 PDF 中提取到足够文字，可能需要 OCR 或视觉模型。");
  }
  if (firstPageFields < 4) {
    warnings.push("首页案号、反馈时间、权利人名称或作品类型存在未识别字段。");
  }
  if (tableRowCount === 0) {
    warnings.push("未识别到结果表格，请确认 PDF 是否为可选中文字或接入 OCR。");
  }
  if (tableRowCount > 0 && screenshotHeadingCount === 0) {
    warnings.push("出处截图大概率是图片内容，当前版本会将截图字段标记为无法识别。");
  }

  return {
    parserMode: "PDF 内嵌文本解析 + 规则核验",
    pageCount,
    extractedTextLength: textLength,
    firstPageFields,
    groupCount: input.groups.length,
    tableRowCount,
    screenshotHeadingCount,
    warnings,
  };
}

export async function runAuditFromPdf(
  arrayBuffer: ArrayBuffer,
): Promise<{ reportText: string; storedResult: AuditRunStoredResult }> {
  const extracted = await extractPdfText(arrayBuffer);
  const parserText = makeParserText(extracted.text);
  const input = buildAuditInput(parserText);
  const report = validatePdfAudit(input);
  const reportText = formatPdfAuditReport(report);
  const summary = summarize(input, parserText.length, extracted.pageCount);

  return {
    reportText,
    storedResult: {
      input,
      report: {
        certificateIssues: report.certificateIssues,
        resultIssues: report.resultIssues,
        issues: report.issues,
      },
      summary,
    },
  };
}
