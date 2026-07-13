import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalAuditResult } from "../lib/audit-result";
import { FinalModelOutputSchema } from "../lib/ai/contracts";

const completeOutput = FinalModelOutputSchema.parse({
  firstPageTable: {
    caseNumber: "示例案号",
    feedbackDate: "2026-07-13",
    rightsHolderName: "示例权利人",
    workType: "摄影作品",
  },
  certificate: null,
  groups: [
    {
      label: "权利图-1",
      tablePage: 2,
      tableRows: [
        {
          resultId: "结果1",
          networkSource: "小红书",
          uploader: "示例账号",
          url: "https://www.xiaohongshu.com/explore/example",
          imageComparisonResult: "疑似重复",
          networkPublishedAt: "2026-01-01",
          checkedAt: "2026-02-01",
          resultKind: "VALID",
        },
      ],
      screenshotResults: [
        {
          resultId: "结果1",
          platform: "小红书",
          publisher: "示例账号",
          publishedAt: "2026-01-01 10:00:00",
          url: "https://xiaohongshu.com/explore/example",
          sourcePage: 3,
        },
      ],
    },
  ],
  extractionComplete: true,
  confidence: 0.96,
  warnings: [],
});

test("returns passed only after deterministic rules find no issues", () => {
  const result = buildFinalAuditResult(completeOutput, 3);

  assert.equal(result.outcome, "passed");
  assert.equal(result.report.issues.length, 0);
  assert.match(result.reportText, /pdf中无错误/);
});

test("returns issues_found for complete evidence with a rule mismatch", () => {
  const output = FinalModelOutputSchema.parse({
    ...completeOutput,
    groups: [
      {
        ...completeOutput.groups[0],
        tableRows: [
          {
            ...completeOutput.groups[0].tableRows[0],
            uploader: "错误账号",
          },
        ],
      },
    ],
  });
  const result = buildFinalAuditResult(output, 3);

  assert.equal(result.outcome, "issues_found");
  assert.equal(result.report.issues.length > 0, true);
});

test("never prints a clean pass when extraction needs review", () => {
  const output = FinalModelOutputSchema.parse({
    ...completeOutput,
    groups: [],
    extractionComplete: false,
    confidence: 0.6,
    warnings: ["未识别到结果表格"],
  });
  const result = buildFinalAuditResult(output, 3);

  assert.equal(result.outcome, "needs_review");
  assert.match(result.reportText, /需人工复核/);
  assert.doesNotMatch(result.reportText, /pdf中无错误/);
  assert.deepEqual(result.summary.warnings, ["未识别到结果表格"]);
});
