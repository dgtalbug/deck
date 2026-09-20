CREATE TABLE IF NOT EXISTS `impact_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`basis_revision` integer NOT NULL,
	`basis_revision_id` text NOT NULL,
	`mode` text NOT NULL,
	`actor` text NOT NULL,
	`rationale` text NOT NULL,
	`evidence` text NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `impact_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`revision` integer NOT NULL,
	`revision_id` text NOT NULL,
	`actor` text NOT NULL,
	`rationale` text NOT NULL,
	`acknowledged_uncertainty` text NOT NULL,
	`fallback_acknowledged` integer NOT NULL,
	`approved_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `impact_approvals_basis_unique` ON `impact_approvals` (`card_id`,`snapshot_id`,`revision`);
