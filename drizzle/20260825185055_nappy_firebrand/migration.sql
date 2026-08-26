CREATE TABLE `cards` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`verb` text,
	`lane` text NOT NULL,
	`position` real NOT NULL,
	`spec_path` text,
	`requirement` text,
	`research` text,
	`blocked_reason` text,
	`blocked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`card_id` text NOT NULL,
	`idx` integer NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`added_by_verify` integer,
	CONSTRAINT `tasks_pk` PRIMARY KEY(`card_id`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
