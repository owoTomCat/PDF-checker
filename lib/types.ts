import type {
  AuditOutcome,
  StrictAuditReport,
  StrictExtractionSummary,
} from "./ai/contracts";

export type {
  AuditTaskDetail,
  AuditTaskSummary,
  TaskStatus,
} from "./task-contracts";

export type AuditReport = StrictAuditReport;
export type ExtractionSummary = StrictExtractionSummary;
export type AuditIssueDto = AuditReport["issues"][number];
export type { AuditOutcome };
