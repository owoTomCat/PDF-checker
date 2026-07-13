import type { FinalModelOutput } from "./ai/contracts";
import { deriveAuditOutcome } from "./ai/contracts";
import {
  formatPdfAuditReport,
  validatePdfAudit,
} from "../pdf-audit-rules.mjs";

export function buildFinalAuditResult(
  output: FinalModelOutput,
  pageCount: number,
) {
  const input = {
    firstPageTable: output.firstPageTable,
    certificate: output.certificate,
    groups: output.groups,
  };
  const report = validatePdfAudit(input);
  const outcome = deriveAuditOutcome(output, report.issues.length);
  const needsReview = outcome === "needs_review";
  const reportText = formatPdfAuditReport(report, {
    needsReview,
    warnings: output.warnings,
  });
  const tableRowCount = output.groups.reduce(
    (total, group) => total + group.tableRows.length,
    0,
  );
  const screenshotCount = output.groups.reduce(
    (total, group) => total + group.screenshotResults.length,
    0,
  );

  return {
    model: "qwen3.7-plus" as const,
    outcome,
    input,
    report: {
      certificateIssues: report.certificateIssues,
      resultIssues: report.resultIssues,
      issues: report.issues,
    },
    reportText,
    summary: {
      parserMode: "qwen3.7-plus 视觉识别 + 跨页归并 + 规则复核",
      pageCount,
      firstPageFields: Object.values(output.firstPageTable).filter(
        (value) => value.trim().length > 0,
      ).length,
      groupCount: output.groups.length,
      tableRowCount,
      screenshotHeadingCount: screenshotCount,
      warnings: output.warnings,
      confidence: output.confidence,
      extractionComplete: output.extractionComplete,
    },
  };
}
