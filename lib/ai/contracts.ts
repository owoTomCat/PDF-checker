import * as z from "zod";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
export const MAX_BATCH_PAGES = 6;
export const MAX_PAGE_IMAGE_BYTES = 8 * 1024 * 1024;
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

export type AuditOutcome =
  | "passed"
  | "issues_found"
  | "needs_review"
  | "failed";
export type BatchExtraction = z.infer<typeof BatchExtractionSchema>;
export type PageExtraction = z.infer<typeof PageExtractionSchema>;
export type FinalModelOutput = z.infer<typeof FinalModelOutputSchema>;
export type PdfAuditInput = Pick<
  FinalModelOutput,
  "firstPageTable" | "certificate" | "groups"
>;

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
