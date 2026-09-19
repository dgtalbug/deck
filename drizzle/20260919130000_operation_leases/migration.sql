ALTER TABLE `operations` ADD COLUMN `lease_expires_at` text;
--> statement-breakpoint
ALTER TABLE `operations` ADD COLUMN `fence_token` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `operations` SET `state` = 'recovery-required', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `state` IN ('reserved', 'active');
