import * as z from "zod";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
export const MAX_BATCH_PAGES = 6;
export const MAX_PAGE_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_BATCH_IMAGE_BYTES = 24 * 1024 * 1024;
export const MIN_COMPLETE_CONFIDENCE = 0.8;

const shortText = z.string().max(500);
const longText = z.string().max(2_000);
const nullableShortText = shortText.nullable();
const nullableLongText = longText.nullable();
const pageNumber = z.number().int().min(1).max(MAX_PDF_PAGES);
const confidence = z.number().min(0).max(1);
const warnings = z.array(z.string().min(1).max(500)).max(20);

export const FirstPageTableSchema = z.strictObject({
  caseNumber: shortText,
  feedbackDate: shortText,
  rightsHolderName: shortText,
  workType: shortText,
});

export const PageFirstPageTableSchema = z.strictObject({
  caseNumber: nullableShortText,
  feedbackDate: nullableShortText,
  rightsHolderName: nullableShortText,
  workType: nullableShortText,
});

export const CertificateSchema = z.strictObject({
  isRegistrationCertificate: z.boolean(),
  copyrightOwner: nullableShortText,
  workType: nullableShortText,
  sourcePage: pageNumber.nullable(),
});

export const ResultKindSchema = z.enum([
  "VALID",
  "POSSIBLY_VALID",
  "PARTIALLY_VALID",
  "INVALID",
  "OTHER_NON_INVALID",
]);

export const ResultTableRowSchema = z.strictObject({
  resultId: nullableShortText,
  networkSource: shortText,
  uploader: shortText,
  url: longText,
  imageComparisonResult: shortText,
  networkPublishedAt: shortText,
  checkedAt: shortText,
  resultKind: ResultKindSchema,
});

export const ScreenshotResultSchema = z.strictObject({
  resultId: shortText,
  platform: nullableShortText,
  publisher: nullableShortText,
  publishedAt: nullableShortText,
  url: nullableLongText,
  sourcePage: pageNumber.nullable(),
});

export const PageResultTableSchema = z.strictObject({
  groupLabel: nullableShortText,
  resultKind: ResultKindSchema,
  rows: z.array(ResultTableRowSchema).max(100),
});

export const PageScreenshotSchema = z.strictObject({
  groupLabel: nullableShortText,
  resultId: nullableShortText,
  platform: nullableShortText,
  publisher: nullableShortText,
  publishedAt: nullableShortText,
  url: nullableLongText,
});

export const PageExtractionSchema = z.strictObject({
  pageNumber,
  pageType: z.enum([
    "cover",
    "certificate",
    "result_table",
    "screenshot",
    "other",
  ]),
  firstPageTable: PageFirstPageTableSchema.nullable(),
  certificate: CertificateSchema.nullable(),
  resultTables: z.array(PageResultTableSchema).max(20),
  screenshots: z.array(PageScreenshotSchema).max(50),
  warnings,
  confidence,
});

export const BatchExtractionSchema = z.strictObject({
  pages: z.array(PageExtractionSchema).min(1).max(MAX_BATCH_PAGES),
  warnings,
});

export const RightImageGroupSchema = z.strictObject({
  label: shortText,
  tablePage: pageNumber,
  tableRows: z.array(ResultTableRowSchema).max(500),
  screenshotResults: z.array(ScreenshotResultSchema).max(500),
});

export const FinalModelOutputSchema = z.strictObject({
  firstPageTable: FirstPageTableSchema,
  certificate: CertificateSchema.nullable(),
  groups: z.array(RightImageGroupSchema).max(MAX_PDF_PAGES),
  extractionComplete: z.boolean(),
  confidence,
  warnings,
});

export const PdfAuditInputSchema = z.strictObject({
  firstPageTable: FirstPageTableSchema,
  certificate: CertificateSchema.nullable(),
  groups: z.array(RightImageGroupSchema).max(MAX_PDF_PAGES),
});

export const AuditIssueSchema = z.strictObject({
  code: z.string().min(1).max(100),
  scope: z.enum(["CERTIFICATE", "RESULT", "CHRONOLOGY", "STRUCTURE"]),
  groupLabel: nullableShortText,
  resultId: nullableShortText,
  message: z.string().min(1).max(2_000),
});

export const AuditReportSchema = z.strictObject({
  certificateIssues: z.array(AuditIssueSchema).max(1_000),
  resultIssues: z.array(AuditIssueSchema).max(5_000),
  issues: z.array(AuditIssueSchema).max(6_000),
});

export const ExtractionSummarySchema = z.strictObject({
  parserMode: z.string().min(1).max(200),
  pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  firstPageFields: z.number().int().min(0).max(4),
  groupCount: z.number().int().min(0).max(MAX_PDF_PAGES),
  tableRowCount: z.number().int().min(0).max(40_000),
  screenshotHeadingCount: z.number().int().min(0).max(40_000),
  warnings,
  confidence,
  extractionComplete: z.boolean(),
});

export const AuditOutcomeSchema = z.enum([
  "passed",
  "issues_found",
  "needs_review",
  "failed",
]);

export const ExtractApiResponseSchema = z.strictObject({
  model: z.literal("qwen3.7-plus"),
  pages: z.array(PageExtractionSchema).min(1).max(MAX_BATCH_PAGES),
  warnings,
});

export const FinalAuditResponseSchema = z.strictObject({
  model: z.literal("qwen3.7-plus"),
  outcome: AuditOutcomeSchema,
  input: PdfAuditInputSchema,
  report: AuditReportSchema,
  reportText: z.string().max(1_000_000),
  summary: ExtractionSummarySchema,
});

export const ExtractRequestMetadataSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  pageNumbers: z.array(pageNumber).min(1).max(MAX_BATCH_PAGES),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
});

export const FinalizeRequestSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  pages: z.array(PageExtractionSchema).min(1).max(MAX_PDF_PAGES),
});

export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;
export type BatchExtraction = z.infer<typeof BatchExtractionSchema>;
export type PageExtraction = z.infer<typeof PageExtractionSchema>;
export type FinalModelOutput = z.infer<typeof FinalModelOutputSchema>;
export type PdfAuditInput = z.infer<typeof PdfAuditInputSchema>;
export type AuditIssue = z.infer<typeof AuditIssueSchema>;
export type AuditReport = z.infer<typeof AuditReportSchema>;
export type ExtractionSummary = z.infer<typeof ExtractionSummarySchema>;
export type FinalAuditResponse = z.infer<typeof FinalAuditResponseSchema>;

function isBlank(value: string | null) {
  return value === null || value.trim().length === 0;
}

function hasMissingScreenshotEvidence(output: FinalModelOutput) {
  return output.groups.some((group) => {
    const screenshotByResult = new Map(
      group.screenshotResults.map((item) => [item.resultId.trim(), item]),
    );

    return group.tableRows.some((row) => {
      if (!row.resultId?.trim()) return false;
      const screenshot = screenshotByResult.get(row.resultId.trim());
      return (
        !screenshot ||
        isBlank(screenshot.platform) ||
        isBlank(screenshot.publisher) ||
        isBlank(screenshot.publishedAt) ||
        isBlank(screenshot.url)
      );
    });
  });
}

export function deriveAuditOutcome(
  output: FinalModelOutput,
  issueCount: number,
): AuditOutcome {
  const missingFirstPageField = Object.values(output.firstPageTable).some(
    (value) => value.trim().length === 0,
  );
  const tableRowCount = output.groups.reduce(
    (total, group) => total + group.tableRows.length,
    0,
  );
  const requiresReview =
    !output.extractionComplete ||
    output.confidence < MIN_COMPLETE_CONFIDENCE ||
    output.warnings.length > 0 ||
    missingFirstPageField ||
    tableRowCount === 0 ||
    hasMissingScreenshotEvidence(output);

  if (requiresReview) return "needs_review";
  return issueCount > 0 ? "issues_found" : "passed";
}

// Strict external-source audit contracts. The legacy two-stage contracts above
// remain temporarily available while the callers migrate task by task.
export const RecognitionStatusSchema = z.enum([
  "recognized",
  "partial",
  "unrecognized",
]);
export const CertificatePresenceSchema = z.enum([
  "provided",
  "not_provided",
  "uncertain",
]);
export const VerificationStateSchema = z.enum([
  "match",
  "mismatch",
  "unverifiable",
]);

export const BoundsSchema = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (bounds) =>
      bounds.x + bounds.width <= 1 && bounds.y + bounds.height <= 1,
    "区域必须位于页面内。",
  );

export const LayoutRegionTypeSchema = z.enum([
  "certificate",
  "rights_screenshot",
  "address_bar",
  "summary_table",
]);

export const LayoutRegionSchema = z.strictObject({
  regionId: z.string().min(1).max(100),
  type: LayoutRegionTypeSchema,
  pageNumber,
  bounds: BoundsSchema,
  parentRegionId: z.string().min(1).max(100).nullable(),
  rightsImageIndex: z.number().int().min(1).max(10_000).nullable(),
  resultIndex: z.number().int().min(1).max(10_000).nullable(),
  readingOrder: z.number().int().min(1).max(100_000),
  confidence,
});

export const PageLayoutSchema = z
  .strictObject({
    pageNumber,
    regions: z.array(LayoutRegionSchema).max(200),
    warnings,
    confidence,
  })
  .superRefine((page, context) => {
    const byId = new Map<string, z.infer<typeof LayoutRegionSchema>>();
    page.regions.forEach((region, index) => {
      if (region.pageNumber !== page.pageNumber) {
        context.addIssue({
          code: "custom",
          path: ["regions", index, "pageNumber"],
          message: "区域页码必须与页面页码一致。",
        });
      }
      if (byId.has(region.regionId)) {
        context.addIssue({
          code: "custom",
          path: ["regions", index, "regionId"],
          message: "区域 ID 不能重复。",
        });
      }
      byId.set(region.regionId, region);
    });

    page.regions.forEach((region, index) => {
      if (region.type !== "address_bar") {
        if (region.parentRegionId !== null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "parentRegionId"],
            message: "仅地址栏区域允许设置父区域。",
          });
        }
        return;
      }

      const parent = region.parentRegionId
        ? byId.get(region.parentRegionId)
        : undefined;
      if (!parent || parent.type !== "rights_screenshot") {
        context.addIssue({
          code: "custom",
          path: ["regions", index, "parentRegionId"],
          message: "地址栏必须从属于同页网页截图。",
        });
      }
    });
  });

export const LayoutBatchSchema = z
  .strictObject({
    pages: z.array(PageLayoutSchema).min(1).max(MAX_BATCH_PAGES),
    warnings,
  })
  .superRefine((batch, context) => {
    const pageNumbers = new Set<number>();
    const regionIds = new Set<string>();
    batch.pages.forEach((page, pageIndex) => {
      if (pageNumbers.has(page.pageNumber)) {
        context.addIssue({
          code: "custom",
          path: ["pages", pageIndex, "pageNumber"],
          message: "批次页码不能重复。",
        });
      }
      pageNumbers.add(page.pageNumber);
      page.regions.forEach((region, regionIndex) => {
        if (regionIds.has(region.regionId)) {
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "regions", regionIndex, "regionId"],
            message: "批次区域 ID 不能重复。",
          });
        }
        regionIds.add(region.regionId);
      });
    });
  });

export const ObservationSchema = z.strictObject({
  rawText: nullableLongText,
  status: RecognitionStatusSchema,
  confidence,
  pageNumber,
  regionId: z.string().min(1).max(100),
});

export const PublishedAtObservationSchema = z.strictObject({
  rawText: nullableLongText,
  status: RecognitionStatusSchema,
  confidence,
  pageNumber,
  regionId: z.string().min(1).max(100),
  kind: z.enum(["published", "edited", "unknown"]),
  yearContextClear: z.boolean(),
});

export const CertificateObservationSchema = z.strictObject({
  regionId: z.string().min(1).max(100),
  pageNumber,
  isFormalCertificate: z.enum(["yes", "no", "uncertain"]),
  owner: ObservationSchema,
  workType: ObservationSchema,
});

export const ScreenshotObservationSchema = z.strictObject({
  screenshotId: z.string().min(1).max(100),
  regionId: z.string().min(1).max(100),
  pageNumber,
  rightsImageIndex: z.number().int().min(1).max(10_000),
  resultIndex: z.number().int().min(1).max(10_000),
  visiblePlatform: ObservationSchema,
  addressHost: ObservationSchema,
  publisher: ObservationSchema,
  publishedAt: PublishedAtObservationSchema,
  initialUrl: ObservationSchema,
  addressBarRegionId: z.string().min(1).max(100).nullable(),
});

export const EvidenceBatchSchema = z.strictObject({
  certificates: z.array(CertificateObservationSchema).max(200),
  screenshots: z.array(ScreenshotObservationSchema).max(500),
  warnings,
});

export const UrlDifferenceSchema = z.strictObject({
  index: z.number().int().min(0).max(20_000),
  colorCharacter: z.string().max(8).nullable(),
  grayscaleCharacter: z.string().max(8).nullable(),
});

export const UnresolvedUrlCharacterSchema = z.strictObject({
  index: z.number().int().min(0).max(20_000),
  candidates: z.array(z.string().min(1).max(8)).min(1).max(10),
});

export const UrlReviewSchema = z.strictObject({
  screenshotId: z.string().min(1).max(100),
  colorRead: nullableLongText,
  grayscaleRead: nullableLongText,
  differingPositions: z.array(UrlDifferenceSchema).max(500),
  unresolvedCharacters: z.array(UnresolvedUrlCharacterSchema).max(500),
  finalRead: nullableLongText,
  status: RecognitionStatusSchema,
  confidence,
});

export const UrlReviewBatchSchema = z.strictObject({
  reviews: z.array(UrlReviewSchema).max(200),
  warnings,
});

export const TableHeaderSchema = z.strictObject({
  regionId: z.string().min(1).max(100),
  pageNumber,
  rightsHolderName: ObservationSchema,
  workType: ObservationSchema,
});

export const StrictTableRowSchema = z.strictObject({
  tableRowId: z.string().min(1).max(100),
  pageNumber,
  regionId: z.string().min(1).max(100),
  rightsImageIndex: z.number().int().min(1).max(10_000),
  resultIndex: z.number().int().min(1).max(10_000),
  platform: ObservationSchema,
  publisher: ObservationSchema,
  publishedAt: ObservationSchema,
  urlCellSegments: z.array(shortText).min(1).max(50),
});

export const TableBatchSchema = z.strictObject({
  headers: z.array(TableHeaderSchema).max(20),
  rows: z.array(StrictTableRowSchema).max(1_000),
  warnings,
});

export const AssociationSchema = z.strictObject({
  screenshotId: z.string().min(1).max(100),
  tableRowId: z.string().min(1).max(100).nullable(),
  confidence,
  reason: shortText,
});

export const AssociationBatchSchema = z.strictObject({
  associations: z.array(AssociationSchema).max(1_000),
  warnings,
});

export const StageFailureSchema = z.strictObject({
  stage: z.enum([
    "layout",
    "evidence",
    "url_review",
    "table",
    "association",
  ]),
  code: z.string().min(1).max(100),
  pageNumber: pageNumber.nullable(),
  regionId: z.string().min(1).max(100).nullable(),
  message: shortText,
});

export const DocumentLayoutSchema = z.strictObject({
  pages: z.array(PageLayoutSchema).min(1).max(MAX_PDF_PAGES),
  warnings,
});

export const DocumentEvidenceSchema = z.strictObject({
  certificates: z.array(CertificateObservationSchema).max(MAX_PDF_PAGES * 2),
  screenshots: z.array(ScreenshotObservationSchema).max(40_000),
  warnings,
});

export const DocumentUrlReviewsSchema = z.strictObject({
  reviews: z.array(UrlReviewSchema).max(40_000),
  warnings,
});

export const DocumentTableSchema = z.strictObject({
  headers: z.array(TableHeaderSchema).max(MAX_PDF_PAGES),
  rows: z.array(StrictTableRowSchema).max(40_000),
  warnings,
});

export const DocumentAssociationsSchema = z.strictObject({
  associations: z.array(AssociationSchema).max(40_000),
  warnings,
});

export const StrictFinalizeRequestSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  layout: DocumentLayoutSchema,
  evidence: DocumentEvidenceSchema,
  urlReviews: DocumentUrlReviewsSchema,
  table: DocumentTableSchema,
  associations: DocumentAssociationsSchema,
  warnings,
  stageFailures: z.array(StageFailureSchema).max(1_000),
});

export const LayoutRequestMetadataSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  pageNumbers: z.array(pageNumber).min(1).max(MAX_BATCH_PAGES),
});

export const EvidenceRegionMetadataSchema = z.strictObject({
  regionId: z.string().min(1).max(100),
  type: z.enum(["certificate", "rights_screenshot"]),
  pageNumber,
  rightsImageIndex: z.number().int().min(1).max(10_000).nullable(),
  resultIndex: z.number().int().min(1).max(10_000).nullable(),
  addressBarRegionId: z.string().min(1).max(100).nullable(),
  readingOrder: z.number().int().min(1).max(100_000),
});

export const EvidenceRequestMetadataSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  regions: z.array(EvidenceRegionMetadataSchema).min(1).max(MAX_BATCH_PAGES),
});

export const UrlReviewPairMetadataSchema = z.strictObject({
  screenshotId: z.string().min(1).max(100),
  pageNumber,
  addressBarRegionId: z.string().min(1).max(100),
});

export const UrlReviewRequestMetadataSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  pairs: z.array(UrlReviewPairMetadataSchema).min(1).max(4),
});

export const TableRegionMetadataSchema = z.strictObject({
  regionId: z.string().min(1).max(100),
  pageNumber,
  readingOrder: z.number().int().min(1).max(100_000),
});

export const TableRequestMetadataSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  totalPages: z.number().int().min(1).max(MAX_PDF_PAGES),
  regions: z.array(TableRegionMetadataSchema).min(1).max(MAX_BATCH_PAGES),
});

export const AssociationLocatorSchema = z.strictObject({
  id: z.string().min(1).max(100),
  pageNumber,
  rightsImageIndex: z.number().int().min(1).max(10_000),
  resultIndex: z.number().int().min(1).max(10_000),
  readingOrder: z.number().int().min(1).max(100_000),
});

export const AssociationRequestSchema = z.strictObject({
  screenshots: z.array(AssociationLocatorSchema).max(40_000),
  tableRows: z.array(AssociationLocatorSchema).max(40_000),
});

export const LayoutApiResponseSchema = LayoutBatchSchema.extend({
  model: z.literal("qwen3.7-plus"),
});
export const EvidenceApiResponseSchema = EvidenceBatchSchema.extend({
  model: z.literal("qwen3.7-plus"),
});
export const UrlReviewApiResponseSchema = UrlReviewBatchSchema.extend({
  model: z.literal("qwen3.7-plus"),
});
export const TableApiResponseSchema = TableBatchSchema.extend({
  model: z.literal("qwen3.7-plus"),
});
export const AssociationApiResponseSchema = AssociationBatchSchema.extend({
  model: z.literal("qwen3.7-plus"),
});

export const StrictAuditInputSchema = z.strictObject({
  certificatePresence: CertificatePresenceSchema,
  certificate: CertificateObservationSchema.nullable(),
  tableHeader: TableHeaderSchema.nullable(),
  screenshots: z.array(ScreenshotObservationSchema).max(40_000),
  tableRows: z.array(StrictTableRowSchema).max(40_000),
  urlReviews: z.array(UrlReviewSchema).max(40_000),
  associations: z.array(AssociationSchema).max(40_000),
});

export const StrictAuditFindingSchema = z.strictObject({
  code: z.string().min(1).max(100),
  scope: z.enum(["RIGHTS", "RESULT", "STRUCTURE"]),
  rightsImageIndex: z.number().int().min(1).max(10_000).nullable(),
  resultIndex: z.number().int().min(1).max(10_000).nullable(),
  field: z
    .enum([
      "rightsHolderName",
      "workType",
      "platform",
      "publisher",
      "publishedAt",
      "url",
      "association",
      "structure",
    ])
    .nullable(),
  message: longText,
});

export const StrictAuditReportSchema = z.strictObject({
  certificateIssues: z.array(StrictAuditFindingSchema).max(1_000),
  resultIssues: z.array(StrictAuditFindingSchema).max(10_000),
  issues: z.array(StrictAuditFindingSchema).max(11_000),
  verificationNotices: z.array(StrictAuditFindingSchema).max(10_000),
});

export const StrictExtractionSummarySchema = z.strictObject({
  parserMode: z.string().min(1).max(200),
  pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  rightsFieldCount: z.number().int().min(0).max(2),
  groupCount: z.number().int().min(0).max(10_000),
  tableRowCount: z.number().int().min(0).max(40_000),
  screenshotHeadingCount: z.number().int().min(0).max(40_000),
  warnings,
  confidence,
  extractionComplete: z.boolean(),
});

export const StrictFinalAuditResponseSchema = z.strictObject({
  model: z.literal("qwen3.7-plus"),
  outcome: AuditOutcomeSchema,
  input: StrictAuditInputSchema,
  report: StrictAuditReportSchema,
  reportText: z.string().max(1_000_000),
  summary: StrictExtractionSummarySchema,
});

export type BoundingBox = z.infer<typeof BoundsSchema>;
export type LayoutRegion = z.infer<typeof LayoutRegionSchema>;
export type PageLayout = z.infer<typeof PageLayoutSchema>;
export type LayoutBatch = z.infer<typeof LayoutBatchSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type CertificateObservation = z.infer<
  typeof CertificateObservationSchema
>;
export type ScreenshotObservation = z.infer<
  typeof ScreenshotObservationSchema
>;
export type EvidenceBatch = z.infer<typeof EvidenceBatchSchema>;
export type UrlReview = z.infer<typeof UrlReviewSchema>;
export type UrlReviewBatch = z.infer<typeof UrlReviewBatchSchema>;
export type StrictTableRow = z.infer<typeof StrictTableRowSchema>;
export type TableBatch = z.infer<typeof TableBatchSchema>;
export type AssociationBatch = z.infer<typeof AssociationBatchSchema>;
export type StrictFinalizeRequest = z.infer<typeof StrictFinalizeRequestSchema>;
export type StrictFinalAuditResponse = z.infer<
  typeof StrictFinalAuditResponseSchema
>;
