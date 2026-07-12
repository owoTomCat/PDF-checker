CREATE TABLE `audit_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`file_type` text,
	`object_key` text NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`error_message` text,
	`report_json` text,
	`report_text` text,
	`extracted_summary_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_tasks_created_at_idx` ON `audit_tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_tasks_status_idx` ON `audit_tasks` (`status`);