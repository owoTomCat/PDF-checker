import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalAuditResult } from "../lib/audit-result";
import {
  strictFinalizeRequest,
  strictUrlReview,
} from "./strict-fixtures";

test("returns passed only after strict deterministic rules find no issues", () => {
  const result = buildFinalAuditResult(strictFinalizeRequest);

  assert.equal(result.outcome, "passed");
  assert.equal(result.report.issues.length, 0);
  assert.equal(result.report.verificationNotices.length, 0);
  assert.match(result.reportText, /详细发布信息：评估无错误/);
});

test("returns issues_found for confirmed mismatches", () => {
  const result = buildFinalAuditResult({
    ...strictFinalizeRequest,
    table: {
      ...strictFinalizeRequest.table,
      rows: [
        {
          ...strictFinalizeRequest.table.rows[0],
          publisher: {
            ...strictFinalizeRequest.table.rows[0].publisher,
            rawText: "错误账号",
          },
        },
      ],
    },
  });

  assert.equal(result.outcome, "issues_found");
  assert.deepEqual(
    result.report.issues.map((issue) => issue.code),
    ["PUBLISHER_MISMATCH"],
  );
});

test("returns needs_review without URL error for an unresolved address bar", () => {
  const result = buildFinalAuditResult({
    ...strictFinalizeRequest,
    urlReviews: {
      reviews: [
        {
          ...strictUrlReview.reviews[0],
          finalRead: null,
          status: "partial",
          confidence: 0.5,
          unresolvedCharacters: [{ index: 38, candidates: ["6", "b"] }],
        },
      ],
      warnings: [],
    },
  });

  assert.equal(result.outcome, "needs_review");
  assert.equal(result.report.issues.length, 0);
  assert.equal(result.report.verificationNotices[0]?.code, "URL_UNVERIFIABLE");
  assert.match(result.reportText, /发布网址：未完整识别/);
});

test("never returns passed when a stage warning or failure exists", () => {
  const warned = buildFinalAuditResult({
    ...strictFinalizeRequest,
    warnings: ["第 1 页区域置信度不足"],
  });
  const failed = buildFinalAuditResult({
    ...strictFinalizeRequest,
    stageFailures: [
      {
        stage: "url_review",
        code: "ADDRESS_BAR_MISSING",
        pageNumber: 1,
        regionId: "screenshot-1",
        message: "未定位到地址栏",
      },
    ],
  });

  assert.equal(warned.outcome, "needs_review");
  assert.equal(failed.outcome, "needs_review");
});

test("uses the no-certificate branch only when every page was scanned", () => {
  const layoutWithoutCertificate = {
    ...strictFinalizeRequest.layout,
    pages: strictFinalizeRequest.layout.pages.map((page) => ({
      ...page,
      regions: page.regions.filter((region) => region.type !== "certificate"),
    })),
  };
  const result = buildFinalAuditResult({
    ...strictFinalizeRequest,
    layout: layoutWithoutCertificate,
    evidence: { ...strictFinalizeRequest.evidence, certificates: [] },
  });

  assert.equal(result.input.certificatePresence, "not_provided");
  assert.equal(result.outcome, "passed");
  assert.match(result.reportText, /不进行核查/);
});
