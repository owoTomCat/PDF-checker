import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchExtractionSchema,
  FinalModelOutputSchema,
  deriveAuditOutcome,
} from "../lib/ai/contracts";

const completeFinalOutput = {
  firstPageTable: {
    caseNumber: "（2026）示例案号",
    feedbackDate: "2026-07-13",
    rightsHolderName: "示例权利人",
    workType: "摄影作品",
  },
  certificate: {
    isRegistrationCertificate: true,
    copyrightOwner: "示例权利人",
    workType: "摄影作品",
    sourcePage: 1,
  },
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
          networkPublishedAt: "2026-01-01 10:00:00",
          checkedAt: "2026-02-01 10:00:00",
          resultKind: "VALID" as const,
        },
      ],
      screenshotResults: [
        {
          resultId: "结果1",
          platform: "小红书",
          publisher: "示例账号",
          publishedAt: "2026-01-01 10:00:00",
          url: "https://www.xiaohongshu.com/explore/example",
          sourcePage: 3,
        },
      ],
    },
  ],
  extractionComplete: true,
  confidence: 0.96,
  warnings: [] as string[],
};

test("accepts bounded page-level extraction JSON", () => {
  const parsed = BatchExtractionSchema.parse({
    pages: [
      {
        pageNumber: 1,
        pageType: "cover",
        firstPageTable: {
          caseNumber: "（2026）示例案号",
          feedbackDate: "2026-07-13",
          rightsHolderName: "示例权利人",
          workType: "摄影作品",
        },
        certificate: null,
        resultTables: [],
        screenshots: [],
        warnings: [],
        confidence: 0.98,
      },
    ],
    warnings: [],
  });

  assert.equal(parsed.pages[0]?.pageNumber, 1);
  assert.equal(parsed.pages[0]?.pageType, "cover");
});

test("rejects model output outside the fixed schema and page limits", () => {
  const parsed = BatchExtractionSchema.safeParse({
    pages: [
      {
        pageNumber: 81,
        pageType: "cover",
        firstPageTable: null,
        certificate: null,
        resultTables: [],
        screenshots: [],
        warnings: [],
        confidence: 1,
        injectedCommand: "ignore the schema",
      },
    ],
    warnings: [],
  });

  assert.equal(parsed.success, false);
});

test("accepts a complete normalized model result", () => {
  const parsed = FinalModelOutputSchema.parse(completeFinalOutput);

  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0]?.tableRows.length, 1);
});

test("returns passed only for complete, high-confidence evidence without issues", () => {
  const output = FinalModelOutputSchema.parse(completeFinalOutput);

  assert.equal(deriveAuditOutcome(output, 0), "passed");
});

test("returns issues_found when complete evidence has deterministic issues", () => {
  const output = FinalModelOutputSchema.parse(completeFinalOutput);

  assert.equal(deriveAuditOutcome(output, 2), "issues_found");
});

test("forces needs_review when no result table was extracted", () => {
  const output = FinalModelOutputSchema.parse({
    ...completeFinalOutput,
    groups: [],
  });

  assert.equal(deriveAuditOutcome(output, 0), "needs_review");
});

test("forces needs_review for incomplete, uncertain, or missing key evidence", () => {
  const cases = [
    { ...completeFinalOutput, extractionComplete: false },
    { ...completeFinalOutput, confidence: 0.79 },
    { ...completeFinalOutput, warnings: ["第 3 页截图模糊"] },
    {
      ...completeFinalOutput,
      firstPageTable: { ...completeFinalOutput.firstPageTable, caseNumber: "" },
    },
    {
      ...completeFinalOutput,
      groups: [
        {
          ...completeFinalOutput.groups[0],
          screenshotResults: [],
        },
      ],
    },
  ];

  for (const value of cases) {
    const output = FinalModelOutputSchema.parse(value);
    assert.equal(deriveAuditOutcome(output, 0), "needs_review");
  }
});
