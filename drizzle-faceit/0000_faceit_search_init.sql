CREATE TABLE `faceit_match_players` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`player_id` text NOT NULL,
	`nickname` text,
	`avatar_url` text,
	`faction` text,
	`team_id` text,
	`game_player_id` text,
	`game_player_name` text,
	`game_skill_level` integer,
	`membership` text,
	`result` text,
	`role` text,
	`eliminations` integer,
	`deaths` integer,
	`assists` integer,
	`kd_ratio` real,
	`damage_dealt` integer,
	`healing_done` integer,
	`damage_mitigated` integer,
	`final_blows` integer,
	`solo_kills` integer,
	`objective_time` integer,
	`time_played` integer,
	`stats_json` text,
	`stats_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `faceit_match_players_match_idx` ON `faceit_match_players` (`match_id`);--> statement-breakpoint
CREATE INDEX `faceit_match_players_player_idx` ON `faceit_match_players` (`player_id`);--> statement-breakpoint
CREATE TABLE `faceit_matches` (
	`match_id` text PRIMARY KEY NOT NULL,
	`game` text,
	`region` text,
	`competition_id` text,
	`competition_name` text,
	`competition_type` text,
	`organizer_id` text,
	`game_mode` text,
	`match_type` text,
	`best_of` integer,
	`round` integer,
	`group_num` integer,
	`status` text DEFAULT 'finished' NOT NULL,
	`winner_faction` text,
	`factions_json` text,
	`location_id` text,
	`server_name` text,
	`map_id` text,
	`map_name` text,
	`map_mode` text,
	`hero_bans_json` text,
	`replay_codes_json` text,
	`attacking_first` text,
	`configured_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`faceit_url` text,
	`detail_synced_at` integer,
	`stats_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `faceit_matches_started_idx` ON `faceit_matches` (`started_at`);--> statement-breakpoint
CREATE INDEX `faceit_matches_detail_synced_idx` ON `faceit_matches` (`detail_synced_at`);--> statement-breakpoint
CREATE INDEX `faceit_matches_stats_synced_idx` ON `faceit_matches` (`stats_synced_at`);--> statement-breakpoint
CREATE INDEX `faceit_matches_competition_idx` ON `faceit_matches` (`competition_id`);--> statement-breakpoint
CREATE TABLE `faceit_players` (
	`player_id` text PRIMARY KEY NOT NULL,
	`nickname` text NOT NULL,
	`avatar_url` text,
	`country` text,
	`game` text DEFAULT 'ow2' NOT NULL,
	`game_player_id` text,
	`game_player_name` text,
	`skill_level` integer,
	`faceit_elo` integer,
	`region` text,
	`faceit_url` text,
	`verified` integer,
	`activated_at` integer,
	`search_mode` text,
	`poll_chunk` integer,
	`list_offset` integer DEFAULT 0 NOT NULL,
	`list_done` integer DEFAULT false NOT NULL,
	`detail_done` integer DEFAULT false NOT NULL,
	`status` text,
	`status_detail` text,
	`match_count` integer DEFAULT 0 NOT NULL,
	`first_searched_at` integer,
	`last_searched_at` integer,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `faceit_players_nickname_idx` ON `faceit_players` (`nickname`);--> statement-breakpoint
CREATE INDEX `faceit_players_chunk_idx` ON `faceit_players` (`poll_chunk`);--> statement-breakpoint
CREATE INDEX `faceit_players_last_synced_idx` ON `faceit_players` (`last_synced_at`);