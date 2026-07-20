import * as z from "zod";
import {
  AuditOutcomeSchema,
  StrictAuditReportSchema,
  StrictExtractionSummarySchema,
} from "./ai/contracts";

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
  tasks: z.array(AuditTaskDetailSchema).max(80),
}).refine(
  ({ tasks }) =>
    tasks.every(
      (task) => task.status === "completed" || task.status === "failed",
    ),
  "Only completed or failed tasks can be imported.",
);

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
