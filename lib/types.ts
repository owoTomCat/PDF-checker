export type TaskStatus = "queued" | "processing" | "completed" | "failed";

export type AuditIssueDto = {
  code: string;
  scope: string;
  groupLabel: string | null;
  resultId: string | null;
  message: string;
};

export type ExtractionSummary = {
  parserMode: string;
  pageCount: number | null;
  extractedTextLength: number;
  firstPageFields: number;
  groupCount: number;
  tableRowCount: number;
  screenshotHeadingCount: number;
  warnings: string[];
};

export type AuditTaskSummary = {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: string | null;
  status: TaskStatus;
  progress: number;
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
  report: {
    certificateIssues: AuditIssueDto[];
    resultIssues: AuditIssueDto[];
    issues: AuditIssueDto[];
  } | null;
};
