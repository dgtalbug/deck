CREATE TABLE IF NOT EXISTS `apply_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`accepted_revision` integer NOT NULL,
	`revision_id` text NOT NULL,
	`plan_digest` text NOT NULL,
	`impact_basis` text NOT NULL,
	`impact_snapshot_id` text,
	`owner` text NOT NULL,
	`checkout` text NOT NULL,
	`branch` text,
	`head_sha` text,
	`dirty_policy` text NOT NULL,
	`dependencies_ready` integer NOT NULL,
	`dependency_report` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `checkpoint_records` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`apply_operation` text,
	`scope_revision` integer NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`digest` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`projection` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `evidence_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`scope_revision` integer NOT NULL,
	`policy_version` integer NOT NULL,
	`apply_operation` text,
	`input_fingerprint` text NOT NULL,
	`producer` text NOT NULL,
	`check_type` text NOT NULL,
	`check_id` text,
	`result` text NOT NULL,
	`payload_digest` text NOT NULL,
	`artifacts` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `evidence_runs_card_payload_unique` ON `evidence_runs` (`card_id`,`payload_digest`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `evidence_run_links` (
	`run_id` text NOT NULL,
	`criterion_id` text,
	`task_id` text,
	CONSTRAINT `evidence_run_links_pk` PRIMARY KEY (`run_id`,`criterion_id`,`task_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `completion_records` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`apply_operation` text,
	`accepted_revision` integer NOT NULL,
	`revision_id` text NOT NULL,
	`plan_digest` text NOT NULL,
	`evidence_summary` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`delivery_id` text,
	`delivery_provenance` text,
	`review_state` text NOT NULL,
	`uncertainty` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `completion_card_revision_unique` ON `completion_records` (`card_id`,`accepted_revision`);
--> statement-breakpoint
ALTER TABLE `handoffs` ADD `evidence_basis` text;
