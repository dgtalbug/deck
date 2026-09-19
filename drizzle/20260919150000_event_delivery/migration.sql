CREATE TABLE `event_consumers` (
	`name` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`registered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`retired_at` text
);
--> statement-breakpoint
CREATE TABLE `event_acks` (
	`consumer` text NOT NULL,
	`rowid` integer NOT NULL,
	`acked_at` text NOT NULL,
	CONSTRAINT `event_acks_pk` PRIMARY KEY (`consumer`, `rowid`)
);
