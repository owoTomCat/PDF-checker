import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPostUrl,
  comparePublishedAt,
  comparePublisher,
  formatPdfAuditReport,
  normalizeWorkType,
  validatePdfAudit,
} from "../pdf-audit-rules.mjs";
import {
  strictAssociation,
  strictEvidence,
  strictTable,
  strictUrlReview,
} from "./strict-fixtures";

function auditInput(overrides: Record<string, unknown> = {}) {
  return {
    certificatePresence: "provided",
    certificate: strictEvidence.certificates[0],
    tableHeader: strictTable.headers[0],
    screenshots: strictEvidence.screenshots,
    tableRows: strictTable.rows,
    urlReviews: strictUrlReview.reviews,
    associations: strictAssociation.associations,
    ...overrides,
  };
}

test("removes every URL query and fragment but keeps path case", () => {
  assert.equal(
    canonicalPostUrl("HTTPS://WWW.Example.com/Post/AbC/?token=1#part"),
    "example.com/Post/AbC",
  );
  assert.notEqual(
    canonicalPostUrl("example.com/Post/AbC"),
    canonicalPostUrl("example.com/post/abc"),
  );
});

test("publisher comparison trims only the ends", () => {
  assert.equal(comparePublisher("  张 三  ", "张 三"), true);
  assert.equal(comparePublisher("张 三", "张三"), false);
});

test("normalizes explicit work types and compares time at common precision", () => {
  assert.equal(normalizeWorkType(" 美术 "), "美术作品");
  assert.equal(
    comparePublishedAt(
      "编辑于 2026-01-01 10:30",
      "2026年1月1日",
      true,
    ),
    "match",
  );
  assert.equal(
    comparePublishedAt("22-5-1 09:30", "2022-05-01 09:30", true),
    "match",
  );
});

test("unresolved screenshot URL is unverifiable instead of an error", () => {
  const report = validatePdfAudit(
    auditInput({
      urlReviews: [
        {
          ...strictUrlReview.reviews[0],
          finalRead: null,
          status: "partial",
          confidence: 0.5,
          unresolvedCharacters: [{ index: 38, candidates: ["6", "b"] }],
        },
      ],
    }),
  );

  assert.equal(report.issues.some((issue) => issue.code === "URL_MISMATCH"), false);
  assert.equal(report.verificationNotices[0]?.code, "URL_UNVERIFIABLE");
  assert.match(report.verificationNotices[0]?.message ?? "", /截图未完整识别/);
});

test("creates one issue for each confirmed mismatching field", () => {
  const report = validatePdfAudit(
    auditInput({
      tableRows: [
        {
          ...strictTable.rows[0],
          publisher: {
            ...strictTable.rows[0].publisher,
            rawText: "错误账号",
          },
          urlCellSegments: ["https://xiaohongshu.com/explore/Different"],
        },
      ],
    }),
  );

  assert.deepEqual(
    report.resultIssues.map((issue) => issue.code),
    ["PUBLISHER_MISMATCH", "URL_MISMATCH"],
  );
});

test("records a platform and host conflict without using the table to choose", () => {
  const report = validatePdfAudit(
    auditInput({
      screenshots: [
        {
          ...strictEvidence.screenshots[0],
          visiblePlatform: {
            ...strictEvidence.screenshots[0].visiblePlatform,
            rawText: "微博",
          },
        },
      ],
    }),
  );

  assert.equal(
    report.verificationNotices.some(
      (notice) => notice.code === "PLATFORM_SOURCE_CONFLICT",
    ),
    true,
  );
  assert.equal(
    report.issues.some((issue) => issue.code === "PLATFORM_MISMATCH"),
    false,
  );
});

test("uses the fixed no-certificate recognition and evaluation text", () => {
  const report = validatePdfAudit(
    auditInput({ certificatePresence: "not_provided", certificate: null }),
  );
  const text = formatPdfAuditReport(report);

  assert.match(text, /pdf文件中未提供作品登记证书/);
  assert.match(
    text,
    /权利人名称、作品类型：pdf文件中未提供作品登记证书，不进行核查/,
  );
  assert.doesNotMatch(text, /提取著作权人/);
});
