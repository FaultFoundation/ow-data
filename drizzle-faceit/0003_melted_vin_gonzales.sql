CREATE TABLE `faceit_scout_team_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`match_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `faceit_scout_team_matches_team_idx` ON `faceit_scout_team_matches` (`team_id`);--> statement-breakpoint
CREATE TABLE `faceit_scout_teams` (
	`team_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`nickname` text NOT NULL,
	`avatar_url` text,
	`roster_json` text NOT NULL,
	`search_mode` text NOT NULL,
	`list_page` integer DEFAULT 0 NOT NULL,
	`list_done` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
