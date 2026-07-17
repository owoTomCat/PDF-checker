import {
  MIN_COMPLETE_CONFIDENCE,
  StrictAuditInputSchema,
  StrictFinalAuditResponseSchema,
  type CertificateObservation,
  type StrictFinalizeRequest,
} from "./ai/contracts";
import {
  formatPdfAuditReport,
  normalizeWorkType,
  validatePdfAudit,
} from "../pdf-audit-rules.mjs";

function normalizedText(value: string | null | undefined) {
  return String(value ?? "").normalize("NFKC").trim();
}

function uniqueWarnings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const warning = normalizedText(value);
    if (!warning || seen.has(warning)) continue;
    seen.add(warning);
    result.push(warning.slice(0, 500));
    if (result.length === 20) break;
  }
  return result;
}

function hasCompletePageCoverage(input: StrictFinalizeRequest) {
  const pages = new Set(input.layout.pages.map((page) => page.pageNumber));
  return (
    pages.size === input.pageCount &&
    Array.from({ length: input.pageCount }, (_, index) => index + 1).every(
      (pageNumber) => pages.has(pageNumber),
    )
  );
}

function aggregateCertificate(input: StrictFinalizeRequest) {
  const warnings: string[] = [];
  const formal = input.evidence.certificates.filter(
    (item) => item.isFormalCertificate === "yes",
  );
  if (formal.length > 0) {
    const selected = formal
      .slice()
      .sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          left.regionId.localeCompare(right.regionId),
      )[0];
    const values = new Set(
      formal.map(
        (item) =>
          `${normalizedText(item.owner.rawText)}\u0000${normalizeWorkType(
            item.workType.rawText,
          )}`,
      ),
    );
    if (values.size > 1) {
      warnings.push("多张作品登记证书的权利信息识别结果不一致。");
    }
    return {
      presence: "provided" as const,
      certificate: selected,
      warnings,
    };
  }

  const certificateRegionIds = new Set(
    input.layout.pages.flatMap((page) =>
      page.regions
        .filter((region) => region.type === "certificate")
        .map((region) => region.regionId),
    ),
  );
  const observedRegionIds = new Set(
    input.evidence.certificates.map((item) => item.regionId),
  );
  const missingCandidate = [...certificateRegionIds].some(
    (regionId) => !observedRegionIds.has(regionId),
  );
  const uncertainCandidate = input.evidence.certificates.some(
    (item) => item.isFormalCertificate === "uncertain",
  );
  const certificateStageFailed = input.stageFailures.some(
    (failure) => failure.stage === "layout" || failure.stage === "evidence",
  );
  if (
    !hasCompletePageCoverage(input) ||
    missingCandidate ||
    uncertainCandidate ||
    certificateStageFailed
  ) {
    return {
      presence: "uncertain" as const,
      certificate: null,
      warnings,
    };
  }

  return {
    presence: "not_provided" as const,
    certificate: null,
    warnings,
  };
}

function selectTableHeader(input: StrictFinalizeRequest, warnings: string[]) {
  if (input.table.headers.length === 0) return null;
  const headers = input.table.headers
    .slice()
    .sort(
      (left, right) =>
        left.pageNumber - right.pageNumber ||
        left.regionId.localeCompare(right.regionId),
    );
  const headerValues = new Set(
    headers.map(
      (header) =>
        `${normalizedText(header.rightsHolderName.rawText)}\u0000${normalizeWorkType(
          header.workType.rawText,
        )}`,
    ),
  );
  if (headerValues.size > 1) {
    warnings.push("多个汇总表表头中的权利人名称或作品类型不一致。");
  }
  return headers[0];
}

function collectConfidence(input: StrictFinalizeRequest) {
  const values: number[] = [];
  for (const page of input.layout.pages) {
    values.push(page.confidence, ...page.regions.map((region) => region.confidence));
  }
  for (const certificate of input.evidence.certificates) {
    values.push(certificate.owner.confidence, certificate.workType.confidence);
  }
  for (const screenshot of input.evidence.screenshots) {
    values.push(
      screenshot.visiblePlatform.confidence,
      screenshot.addressHost.confidence,
      screenshot.publisher.confidence,
      screenshot.publishedAt.confidence,
      screenshot.initialUrl.confidence,
    );
  }
  values.push(...input.urlReviews.reviews.map((review) => review.confidence));
  for (const header of input.table.headers) {
    values.push(header.rightsHolderName.confidence, header.workType.confidence);
  }
  for (const row of input.table.rows) {
    values.push(
      row.platform.confidence,
      row.publisher.confidence,
      row.publishedAt.confidence,
    );
  }
  values.push(
    ...input.associations.associations.map(
      (association) => association.confidence,
    ),
  );
  return values.length > 0 ? Math.min(...values) : 0;
}

function recognized(observation: { rawText: string | null; status: string }) {
  return (
    observation.status === "recognized" &&
    normalizedText(observation.rawText).length > 0
  );
}

function certificateFieldsComplete(
  presence: "provided" | "not_provided" | "uncertain",
  certificate: CertificateObservation | null,
  header: StrictFinalizeRequest["table"]["headers"][number] | null,
) {
  if (presence === "not_provided") return true;
  if (presence === "uncertain" || !certificate || !header) return false;
  return (
    recognized(certificate.owner) &&
    recognized(certificate.workType) &&
    recognized(header.rightsHolderName) &&
    recognized(header.workType)
  );
}

export function buildFinalAuditResult(rawInput: StrictFinalizeRequest) {
  const input = rawInput;
  const certificate = aggregateCertificate(input);
  const aggregationWarnings = [...certificate.warnings];
  const tableHeader = selectTableHeader(input, aggregationWarnings);
  const auditInput = StrictAuditInputSchema.parse({
    certificatePresence: certificate.presence,
    certificate: certificate.certificate,
    tableHeader,
    screenshots: input.evidence.screenshots,
    tableRows: input.table.rows,
    urlReviews: input.urlReviews.reviews,
    associations: input.associations.associations,
  });
  const report = validatePdfAudit(auditInput);

  const warnings = uniqueWarnings([
    ...input.warnings,
    ...input.layout.warnings,
    ...input.layout.pages.flatMap((page) => page.warnings),
    ...input.evidence.warnings,
    ...input.urlReviews.warnings,
    ...input.table.warnings,
    ...input.associations.warnings,
    ...aggregationWarnings,
    ...input.stageFailures.map(
      (failure) => `${failure.stage}/${failure.code}：${failure.message}`,
    ),
  ]);
  const confidence = collectConfidence(input);
  const urlReviewByScreenshot = new Map(
    input.urlReviews.reviews.map((review) => [review.screenshotId, review]),
  );
  const associationByScreenshot = new Map(
    input.associations.associations.map((association) => [
      association.screenshotId,
      association,
    ]),
  );
  const allUrlsReviewed = input.evidence.screenshots.every((screenshot) =>
    urlReviewByScreenshot.has(screenshot.screenshotId),
  );
  const allScreenshotsAssociated = input.evidence.screenshots.every(
    (screenshot) => {
      const association = associationByScreenshot.get(screenshot.screenshotId);
      return Boolean(
        association?.tableRowId &&
          association.confidence >= MIN_COMPLETE_CONFIDENCE,
      );
    },
  );
  const extractionComplete =
    hasCompletePageCoverage(input) &&
    input.stageFailures.length === 0 &&
    warnings.length === 0 &&
    confidence >= MIN_COMPLETE_CONFIDENCE &&
    input.evidence.screenshots.length > 0 &&
    input.table.rows.length > 0 &&
    allUrlsReviewed &&
    allScreenshotsAssociated &&
    certificateFieldsComplete(
      certificate.presence,
      certificate.certificate,
      tableHeader,
    );

  const outcome =
    report.issues.length > 0
      ? "issues_found"
      : !extractionComplete || report.verificationNotices.length > 0
        ? "needs_review"
        : "passed";
  const groupCount = new Set(
    input.evidence.screenshots.map((item) => item.rightsImageIndex),
  ).size;
  const rightsFieldCount =
    certificate.presence === "provided" && certificate.certificate
      ? [certificate.certificate.owner, certificate.certificate.workType].filter(
          recognized,
        ).length
      : 0;

  return StrictFinalAuditResponseSchema.parse({
    model: "qwen3.7-plus",
    outcome,
    input: auditInput,
    report: {
      certificateIssues: report.certificateIssues,
      resultIssues: report.resultIssues,
      issues: report.issues,
      verificationNotices: report.verificationNotices,
    },
    reportText: formatPdfAuditReport(report),
    summary: {
      parserMode:
        "qwen3.7-plus 区域隔离识别 + 600 DPI URL 复核 + 确定性规则",
      pageCount: input.pageCount,
      rightsFieldCount,
      groupCount,
      tableRowCount: input.table.rows.length,
      screenshotHeadingCount: input.evidence.screenshots.length,
      warnings,
      confidence,
      extractionComplete,
    },
  });
}
