import * as z from "zod";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
export const MAX_BATCH_PAGES = 6;
export const MAX_PAGE_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_BATCH_IMAGE_BYTES = 24 * 1024 * 1024;
export const MIN_COMPLETE_CONFIDENCE = 0.8;

const shortText = z.string().max(500);
const longText = z.string().max(2_000);
const nullableLongText = longText.nullable();
const pageNumber = z.number().int().min(1).max(MAX_PDF_PAGES);
const confidence = z.number().min(0).max(1);
const warnings = z.array(z.string().min(1).max(500)).max(20);
const documentWarnings = z
  .array(z.string().min(1).max(500))
  .max(MAX_PDF_PAGES * 20);

export const AuditOutcomeSchema = z.enum([
  "passed",
  "issues_found",
  "needs_review",
  "failed",
]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

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
      if (region.type === "certificate" || region.type === "summary_table") {
        if (region.parentRegionId !== null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "parentRegionId"],
            message: "证书和汇总表不能设置父区域。",
          });
        }
        if (region.rightsImageIndex !== null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "rightsImageIndex"],
            message: "证书和汇总表不能设置权利图序号。",
          });
        }
        if (region.resultIndex !== null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "resultIndex"],
            message: "证书和汇总表不能设置结果序号。",
          });
        }
        return;
      }

      if (region.type === "rights_screenshot") {
        if (region.parentRegionId !== null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "parentRegionId"],
            message: "网页截图不能设置父区域。",
          });
        }
        if (region.rightsImageIndex === null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "rightsImageIndex"],
            message: "网页截图必须设置权利图序号。",
          });
        }
        if (region.resultIndex === null) {
          context.addIssue({
            code: "custom",
            path: ["regions", index, "resultIndex"],
            message: "网页截图必须设置结果序号。",
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
        return;
      }
      if (region.rightsImageIndex !== parent.rightsImageIndex) {
        context.addIssue({
          code: "custom",
          path: ["regions", index, "rightsImageIndex"],
          message: "地址栏的权利图序号必须与父截图一致。",
        });
      }
      if (region.resultIndex !== parent.resultIndex) {
        context.addIssue({
          code: "custom",
          path: ["regions", index, "resultIndex"],
          message: "地址栏的结果序号必须与父截图一致。",
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
  warnings: documentWarnings,
});

export const DocumentEvidenceSchema = z.strictObject({
  certificates: z.array(CertificateObservationSchema).max(MAX_PDF_PAGES * 2),
  screenshots: z.array(ScreenshotObservationSchema).max(40_000),
  warnings: documentWarnings,
});

export const DocumentUrlReviewsSchema = z.strictObject({
  reviews: z.array(UrlReviewSchema).max(40_000),
  warnings: documentWarnings,
});

export const DocumentTableSchema = z.strictObject({
  headers: z.array(TableHeaderSchema).max(MAX_PDF_PAGES),
  rows: z.array(StrictTableRowSchema).max(40_000),
  warnings: documentWarnings,
});

export const DocumentAssociationsSchema = z.strictObject({
  associations: z.array(AssociationSchema).max(40_000),
  warnings: documentWarnings,
});

export const StrictFinalizeRequestSchema = z.strictObject({
  fileName: z.string().min(1).max(255),
  pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  layout: DocumentLayoutSchema,
  evidence: DocumentEvidenceSchema,
  urlReviews: DocumentUrlReviewsSchema,
  table: DocumentTableSchema,
  associations: DocumentAssociationsSchema,
  warnings: documentWarnings,
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
  warnings: documentWarnings,
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
export type StrictAuditReport = z.infer<typeof StrictAuditReportSchema>;
export type StrictExtractionSummary = z.infer<
  typeof StrictExtractionSummarySchema
>;
export type StrictFinalAuditResponse = z.infer<
  typeof StrictFinalAuditResponseSchema
>;
