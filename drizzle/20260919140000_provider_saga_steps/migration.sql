ALTER TABLE `provider_operations` ADD COLUMN `operation_id` text;
--> statement-breakpoint
ALTER TABLE `provider_operations` ADD COLUMN `step` text;
--> statement-breakpoint
ALTER TABLE `provider_operations` ADD COLUMN `expected_ref` text;
--> statement-breakpoint
ALTER TABLE `provider_operations` ADD COLUMN `payload_digest` text;
--> statement-breakpoint
ALTER TABLE `provider_operations` ADD COLUMN `observed_at` text;
--> statement-breakpoint
ALTER TABLE `provider_operations` ADD COLUMN `tombstone` integer NOT NULL DEFAULT 0;
