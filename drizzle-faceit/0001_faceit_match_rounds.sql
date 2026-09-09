CREATE TABLE `faceit_match_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`round_index` integer NOT NULL,
	`map_id` text,
	`map_name` text,
	`map_mode` text,
	`winner_team_id` text,
	`score_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `faceit_match_rounds_match_idx` ON `faceit_match_rounds` (`match_id`);--> statement-breakpoint
CREATE INDEX `faceit_match_rounds_map_idx` ON `faceit_match_rounds` (`map_name`);--> statement-breakpoint
ALTER TABLE `faceit_matches` ADD `rounds_synced_at` integer;--> statement-breakpoint
CREATE INDEX `faceit_matches_rounds_synced_idx` ON `faceit_matches` (`rounds_synced_at`);--> statement-breakpoint
-- Every already-collected match has a null `rounds_synced_at`, so no searched
-- player is genuinely detail-complete any more. The hourly sweep selects on the
-- STORED `detail_done` flag, so clearing it here is what lets the backfill reach
-- players nobody happens to search again; `finalizePlayerState` sets it back to
-- true once their rounds are in.
UPDATE `faceit_players` SET `detail_done` = 0 WHERE `search_mode` IS NOT NULL;
