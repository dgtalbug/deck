CREATE TABLE `issue_map` (
	`card_id` text PRIMARY KEY,
	`issue_number` integer NOT NULL,
	`state` text NOT NULL,
	`checksum` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publish_queue` (
	`card_id` text PRIMARY KEY,
	`checksum` text NOT NULL,
	`enqueued_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `specs` (
	`card_id` text NOT NULL,
	`version` integer NOT NULL,
	`markdown` text NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `specs_pk` PRIMARY KEY(`card_id`, `version`)
);
