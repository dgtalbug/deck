ALTER TABLE `cards` ADD COLUMN `epic_id` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `history_at` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `completed_at` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `scope_revision` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cards_history` ON `cards` (`history_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cards_completion` ON `cards` (`completed_at`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cards_epic` ON `cards` (`epic_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deck_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_verbs` (
	`name` text PRIMARY KEY NOT NULL,
	`registered_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spec_types` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`icon` text NOT NULL,
	`sections` JSON NOT NULL,
	`groom_fields` JSON NOT NULL,
	`task_law` text NOT NULL,
	`git_convention` JSON NOT NULL,
	`hard_rule` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`detect` text NOT NULL,
	`skills_dir` text NOT NULL,
	`seeded_at` text NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `session_memory` USING fts5 (`line`, `cardId` UNINDEXED, `section` UNINDEXED);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner` text NOT NULL,
	`checkout` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operations_checkout_state` ON `operations` (`checkout`, `state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operations_card_state` ON `operations` (`card_id`, `state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operations_owner` ON `operations` (`owner`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `source_baselines` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`version` integer NOT NULL,
	`scope_revision` integer NOT NULL,
	`path` text NOT NULL,
	`digest` text NOT NULL,
	`snapshot_path` text,
	`graph_generation` integer,
	`graph_fingerprint` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `source_baselines_card` ON `source_baselines` (`card_id`, `version`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scope_revisions` (
	`card_id` text NOT NULL,
	`revision` integer NOT NULL,
	`digest` text NOT NULL,
	`operations` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `scope_revisions_pk` PRIMARY KEY (`card_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scope_items` (
	`card_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`first_revision` integer NOT NULL,
	`last_revision` integer NOT NULL,
	CONSTRAINT `scope_items_pk` PRIMARY KEY (`card_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `epic_intent` (
	`epic_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`intent` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `epic_criteria` (
	`epic_id` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`deferral` text,
	`first_revision` integer NOT NULL,
	CONSTRAINT `epic_criteria_pk` PRIMARY KEY (`epic_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `epic_criterion_links` (
	`epic_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`child_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `epic_criterion_links_pk` PRIMARY KEY (`epic_id`, `criterion_id`, `child_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `child_acknowledgements` (
	`card_id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`revision` integer NOT NULL,
	`acknowledged_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_deps` (
	`card_id` text NOT NULL,
	`depends_on` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `story_deps_pk` PRIMARY KEY (`card_id`, `depends_on`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `story_deps_dep` ON `story_deps` (`depends_on`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_policies` (
	`card_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`mode` text NOT NULL,
	`required_checks` text NOT NULL,
	`required_approvals` integer NOT NULL,
	`manual_criteria` text NOT NULL,
	`enrolled_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `evidence_records` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`criterion_id` text,
	`task_id` text,
	`check_id` text,
	`command` text,
	`command_digest` text,
	`exit_code` integer,
	`result` text NOT NULL,
	`producer` text NOT NULL,
	`reviewer` text,
	`rationale` text,
	`scope_revision` integer NOT NULL,
	`policy_version` integer NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`input_coverage` text NOT NULL,
	`artifact_path` text,
	`artifact_sha256` text,
	`artifact_unavailable` text,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `evidence_records_card` ON `evidence_records` (`card_id`, `criterion_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`project_id` text NOT NULL,
	`marker` text NOT NULL,
	`payload_revision` integer NOT NULL,
	`payload` text NOT NULL,
	`expected_head` text,
	`expected_base` text,
	`state` text NOT NULL,
	`remote_id` text,
	`remote_url` text,
	`owner` text,
	`error` text,
	`next_action` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `provider_operations_card` ON `provider_operations` (`card_id`, `kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `provider_operations_state` ON `provider_operations` (`state`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`mode` text NOT NULL,
	`policy_version` integer NOT NULL,
	`scope_revision` integer NOT NULL,
	`input_fingerprint` text,
	`pr_number` integer,
	`pr_url` text,
	`head_sha` text,
	`base_branch` text,
	`merge_sha` text,
	`merge_method` text,
	`delivered_sha` text,
	`provenance` text,
	`state` text NOT NULL,
	`refusal_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `deliveries_card_attempt_unique` UNIQUE (`card_id`, `attempt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cleanup_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer NOT NULL DEFAULT 0,
	`identity` text,
	`detail` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `cleanup_tasks_card_delivery_kind_unique` UNIQUE (`card_id`, `delivery_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `capability_statements` (
	`id` text PRIMARY KEY NOT NULL,
	`capability_id` text NOT NULL,
	`statement_id` text NOT NULL,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`digest` text NOT NULL,
	`source_card_id` text NOT NULL,
	`source_criterion_id` text NOT NULL,
	`source_scope_revision` integer NOT NULL,
	`evidence_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`state` text NOT NULL,
	`projection_version_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `capability_statements_current` ON `capability_statements` (`capability_id`, `statement_id`, `state`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `capability_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`base_digest` text NOT NULL,
	`source_digest` text NOT NULL,
	`content_digest` text NOT NULL,
	`preview_json` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `capability_previews_batch` ON `capability_previews` (`batch_id`, `state`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `capability_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`base_digest` text NOT NULL,
	`content_digest` text NOT NULL,
	`preview_id` text NOT NULL,
	`accepted_by` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `capability_versions_version` ON `capability_versions` (`version`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `capability_deltas` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`delta_id` text NOT NULL,
	`op` text NOT NULL,
	`capability_id` text NOT NULL,
	`statement_id` text NOT NULL,
	`statement_digest` text,
	`source_card_id` text NOT NULL,
	`source_criterion_id` text NOT NULL,
	`source_scope_revision` integer NOT NULL,
	`evidence_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`preview_id` text NOT NULL,
	`applied_version_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT `capability_deltas_delta_id_unique` UNIQUE (`delta_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `capability_deltas_preview` ON `capability_deltas` (`preview_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_state` (
	`task_id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`revision` integer NOT NULL DEFAULT 1,
	`owner` text,
	`assigned_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_state_card` ON `task_state` (`card_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_patches` (
	`command_id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`task_id` text NOT NULL,
	`owner` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`payload_digest` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`task_id` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`scope_revision` integer NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`remaining_work` text,
	`evidence_ids` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `handoffs_card_state` ON `handoffs` (`card_id`, `state`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_path` text NOT NULL,
	`path` text,
	`branch` text NOT NULL,
	`expected_head` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspaces_project_state` ON `workspaces` (`project_path`, `state`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `migration_runs` (
	`migration` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
UPDATE `cards` SET `completed_at` = `updated_at` WHERE `lane` = 'done' AND `completed_at` IS NULL;
--> statement-breakpoint
UPDATE `operations` SET `state` = 'recovery-required', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `state` IN ('reserved', 'active');
--> statement-breakpoint
UPDATE `cards` SET `blocked_reason` = NULL, `blocked_at` = NULL WHERE `lane` IN ('active', 'verify', 'done') AND `blocked_reason` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `task_state` (`task_id`, `card_id`, `revision`, `owner`, `assigned_at`, `updated_at`)
	SELECT `t`.`id`, `t`.`card_id`, 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `tasks` `t`;
--> statement-breakpoint
DELETE FROM `task_state` WHERE `task_id` NOT IN (SELECT `id` FROM `tasks`);
