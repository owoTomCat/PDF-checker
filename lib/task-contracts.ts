import * as z from "zod";
import {
  AuditOutcomeSchema,
  StrictAuditReportSchema,
  StrictExtractionSummarySchema,
} from "./ai/contracts";

export const LEGACY_MIGRATION_REPORT_NOTICE =
  "历史迁移记录，未由当前服务器重新核验。";
const MAX_LEGACY_REPORT_TEXT_LENGTH = 1_000_000;

export function deriveLegacyCompletedOutcome(report: { issues: readonly unknown[] }) {
  return report.issues.length > 0 ? "issues_found" as const : "needs_review" as const;
}

export function markLegacyMigrationReportText(reportText: string) {
  if (reportText.startsWith(LEGACY_MIGRATION_REPORT_NOTICE)) {
    return reportText.slice(0, MAX_LEGACY_REPORT_TEXT_LENGTH);
  }
  const marked = reportText.length > 0
    ? `${LEGACY_MIGRATION_REPORT_NOTICE}\n\n${reportText}`
    : LEGACY_MIGRATION_REPORT_NOTICE;
  return marked.slice(0, MAX_LEGACY_REPORT_TEXT_LENGTH);
}

function findingKey(finding: z.infer<typeof StrictAuditReportSchema>["issues"][number]) {
  return JSON.stringify([
    finding.code,
    finding.scope,
    finding.rightsImageIndex,
    finding.resultIndex,
    finding.field,
    finding.message,
  ]);
}

export const TaskStatusSchema = z.enum([
  "queued",
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
  "completed",
  "failed",
]);

export const ActiveTaskStatusSchema = z.enum([
  "queued",
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
]);

export const AuditTaskSummarySchema = z.object({
  id: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().nonnegative(),
  fileType: z.string().nullable(),
  status: TaskStatusSchema,
  outcome: AuditOutcomeSchema.nullable(),
  model: z.literal("qwen3.7-plus").nullable(),
  progress: z.number().int().min(0).max(100),
  processedPages: z.number().int().nonnegative(),
  totalPages: z.number().int().min(1).max(80).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  issueCount: z.number().int().nonnegative().nullable(),
  summary: StrictExtractionSummarySchema.nullable(),
  pdfExpiresAt: z.iso.datetime().nullable(),
  pdfAvailable: z.boolean(),
});

export const AuditTaskDetailSchema = AuditTaskSummarySchema.extend({
  reportText: z.string().nullable(),
  report: StrictAuditReportSchema.nullable(),
});

const LegacyCompletedTaskSchema = AuditTaskDetailSchema.extend({
  status: z.literal("completed"),
  outcome: z.enum(["issues_found", "needs_review"]),
  model: z.literal("qwen3.7-plus"),
  progress: z.literal(100),
  completedAt: z.iso.datetime(),
  errorCode: z.null(),
  errorMessage: z.null(),
  issueCount: z.number().int().nonnegative(),
  summary: StrictExtractionSummarySchema,
  reportText: z.string().max(1_000_000),
  report: StrictAuditReportSchema,
}).superRefine((task, context) => {
  if (task.issueCount !== task.report.issues.length) {
    context.addIssue({
      code: "custom",
      path: ["issueCount"],
      message: "Completed legacy tasks must retain the final issue count.",
    });
  }
  if (
    task.processedPages !== task.summary.pageCount ||
    task.totalPages !== task.summary.pageCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["processedPages"],
      message: "Completed legacy tasks must retain the final page count.",
    });
  }
  const categorizedIssues = [
    ...task.report.certificateIssues,
    ...task.report.resultIssues,
  ];
  const categorizedKeys = categorizedIssues.map(findingKey);
  const issueKeys = task.report.issues.map(findingKey);
  if (new Set(categorizedKeys).size !== categorizedKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["report", "certificateIssues"],
      message: "Completed legacy task issue categories must not contain duplicates.",
    });
  }
  if (new Set(issueKeys).size !== issueKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["report", "issues"],
      message: "Completed legacy task issues must not contain duplicates.",
    });
  }
  const categorizedSet = new Set(categorizedKeys);
  const issueSet = new Set(issueKeys);
  if (
    categorizedSet.size !== issueSet.size ||
    [...categorizedSet].some((key) => !issueSet.has(key))
  ) {
    context.addIssue({
      code: "custom",
      path: ["report", "issues"],
      message: "Completed legacy task issues must equal its categorized issues.",
    });
  }
  if (task.outcome !== deriveLegacyCompletedOutcome(task.report)) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "Completed legacy task outcome must be derived from its issues.",
    });
  }
  if (
    task.summary.extractionComplete &&
    (task.summary.warnings.length > 0 || task.report.verificationNotices.length > 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["summary", "extractionComplete"],
      message: "A complete legacy extraction cannot retain warnings or verification notices.",
    });
  }
});

const LegacyFailedTaskSchema = AuditTaskDetailSchema.extend({
  status: z.literal("failed"),
  outcome: z.literal("failed"),
  model: z.null(),
  progress: z.literal(100),
  completedAt: z.iso.datetime(),
  errorCode: z.string().min(1).max(100),
  errorMessage: z.string().min(1).max(2_000),
  issueCount: z.null(),
  summary: z.null(),
  reportText: z.null(),
  report: z.null(),
});

export const LegacyTaskImportItemSchema = z.discriminatedUnion("status", [
  LegacyCompletedTaskSchema,
  LegacyFailedTaskSchema,
]);

export const TaskListQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(80),
}).transform((value) => ({
  ...value,
  query: value.query || undefined,
  ...(value.createdFrom ? { createdFrom: new Date(value.createdFrom).toISOString() } : {}),
  ...(value.createdTo ? { createdTo: new Date(value.createdTo).toISOString() } : {}),
}));

export const TaskImportRequestSchema = z.object({
  tasks: z.array(LegacyTaskImportItemSchema).max(80),
});

export const BatchDeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(101),
}).transform(({ ids }) => ({ ids: [...new Set(ids)] })).pipe(
  z.object({ ids: z.array(z.string()).min(1).max(100) }),
);

export const TaskApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
  }),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type AuditTaskSummary = z.infer<typeof AuditTaskSummarySchema>;
export type AuditTaskDetail = z.infer<typeof AuditTaskDetailSchema>;
