import type {
  AuditOutcome,
  StrictAuditReport,
  StrictExtractionSummary,
} from "./ai/contracts";

export type TaskStatus =
  | "queued"
  | "rendering"
  | "locating"
  | "recognizing"
  | "reviewing_urls"
  | "extracting_table"
  | "associating"
  | "finalizing"
  | "completed"
  | "failed";

export type AuditReport = StrictAuditReport;
export type ExtractionSummary = StrictExtractionSummary;
export type AuditIssueDto = AuditReport["issues"][number];
export type { AuditOutcome };

export type AuditTaskSummary = {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string | null;
  status: TaskStatus;
  outcome: AuditOutcome | null;
  model: "qwen3.7-plus" | null;
  progress: number;
  processedPages: number;
  totalPages: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  issueCount: number | null;
  summary: ExtractionSummary | null;
};

export type AuditTaskDetail = AuditTaskSummary & {
  reportText: string | null;
  report: AuditReport | null;
};
