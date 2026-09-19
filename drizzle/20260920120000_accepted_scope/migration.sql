CREATE TABLE IF NOT EXISTS `spec_revisions` (
	`card_id` text NOT NULL,
	`revision` integer NOT NULL,
	`revision_id` text NOT NULL,
	`content_digest` text NOT NULL,
	`operations` text NOT NULL,
	`actor` text NOT NULL,
	`basis_revision` integer,
	`created_at` text NOT NULL,
	CONSTRAINT `spec_revisions_pk` PRIMARY KEY (`card_id`, `revision`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `spec_revisions_revision_id_unique` ON `spec_revisions` (`revision_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spec_requirements` (
	`card_id` text NOT NULL,
	`revision` integer NOT NULL,
	`req_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT `spec_requirements_pk` PRIMARY KEY (`card_id`, `revision`, `req_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spec_criteria` (
	`card_id` text NOT NULL,
	`revision` integer NOT NULL,
	`criterion_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `spec_criteria_pk` PRIMARY KEY (`card_id`, `revision`, `criterion_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spec_plan_items` (
	`card_id` text NOT NULL,
	`revision` integer NOT NULL,
	`task_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `spec_plan_items_pk` PRIMARY KEY (`card_id`, `revision`, `task_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scope_quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text
);
--> statement-breakpoint
ALTER TABLE `specs` ADD `scope_revision` integer;
--> statement-breakpoint
ALTER TABLE `issue_map` ADD `scope_revision` integer;
--> statement-breakpoint
CREATE TABLE `task_state_rebuilt` (
	`task_id` text NOT NULL,
	`card_id` text NOT NULL,
	`revision` integer NOT NULL DEFAULT 1,
	`owner` text,
	`assigned_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `task_state_rebuilt_pk` PRIMARY KEY (`card_id`, `task_id`)
);
--> statement-breakpoint
INSERT INTO `task_state_rebuilt` (`task_id`, `card_id`, `revision`, `owner`, `assigned_at`, `updated_at`)
	SELECT `task_id`, `card_id`, `revision`, `owner`, `assigned_at`, `updated_at` FROM `task_state`;
--> statement-breakpoint
DROP TABLE `task_state`;
--> statement-breakpoint
ALTER TABLE `task_state_rebuilt` RENAME TO `task_state`;
