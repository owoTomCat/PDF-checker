import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditTasks = sqliteTable(
  "audit_tasks",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull(),
    fileType: text("file_type"),
    objectKey: text("object_key").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    errorMessage: text("error_message"),
    reportJson: text("report_json"),
    reportText: text("report_text"),
    extractedSummaryJson: text("extracted_summary_json"),
  },
  (table) => [
    index("audit_tasks_created_at_idx").on(table.createdAt),
    index("audit_tasks_status_idx").on(table.status),
  ],
);
