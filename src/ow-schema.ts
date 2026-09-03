// ⚠️ MIRROR of the Commons `db/ow-schema.ts`. The Commons OWNS the migrations
// (it applies them to ow-player-data); this copy exists only so the poller can
// type its reads/writes. Keep the two COLUMN-COMPATIBLE — if you add/rename a
// column in the Commons schema, mirror it here (and vice versa).
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ===========================================================================
// ow-player-data — the Overwatch player-statistics store (a THIRD D1 database).
// Also home to the cross-provider player-data tables (`pd_*`, bottom of this
// file): external team memberships and match history pulled from FACEIT /
// start.gg / Challonge per linked member. Same database, same two-writer
// model, same worker (ow-data) — see the pd_* section header for the rules.
//
// Separate from website-sql (member/identity core) and cen-sql (external
// tournaments), bound to the Commons Worker as `OW`. It holds an APPEND-ONLY
// time series of a member's Overwatch career, scraped from the member's public
// Blizzard career page through the OverFast API (https://overfast-api.tekrop.fr).
//
// Two writers, deliberately:
//   1. The Commons (lib/ow-stats.ts) — takes the snapshot when a member connects
//      Battle.net and lazily refreshes it when they open the Statistics tab.
//   2. The ow-stats-poller Worker (a SEPARATE repo, like cen-scraper) — an hourly
//      cron that snapshots a chunk of due players so inactive members still
//      accrue history.
// This is safe because `ow_snapshots` is append-only (never updated/overwritten —
// the whole point is to preserve history so members can see improvement over
// time) and `ow_players` is a small mutable registry written with upserts. The
// poller repo keeps its OWN copy of this schema; keep the two COLUMN-COMPATIBLE.
//
// There are no cross-database foreign keys: `user_id` is the Commons user id, and
// the two databases are joined only in application code (D1 can't JOIN across
// bindings), exactly like the cen-sql / website-sql split.
//
// Migrations are owned by the COMMONS (drizzle.ow.config.ts → drizzle-ow/,
// applied by `npm run db:ow:migrate:*`). The poller only reads/writes rows.
// ===========================================================================

/**
 * One row per connected member: who to poll, when they were last snapshotted,
 * and the cached public/private visibility. The poller reads this to decide who
 * is due; the Commons upserts it on connect / first Statistics visit.
 */
export const owPlayers = sqliteTable(
  "ow_players",
  {
    // The Commons user id — the cross-database join key (see header). PK: one
    // registry row per member.
    userId: text("user_id").primaryKey(),
    // BattleTag as Blizzard presents it ("Name#1234"), and the OverFast id form
    // ("Name-1234", '#'→'-'). Stored resolved so neither writer re-derives it.
    battletag: text("battletag").notNull(),
    playerId: text("player_id").notNull(),
    // Which career platform we read ranks/stats from ('pc' | 'console').
    platform: text("platform").notNull().default("pc"),
    // Cached public-profile state from the last OverFast reachability check:
    // 'public' | 'private' | 'not_found' | 'unknown'. TTL-gated by
    // visibility_checked_at (see VISIBILITY_TTL_MS in lib/ow-stats-shared.ts).
    visibility: text("visibility"),
    visibilityCheckedAt: integer("visibility_checked_at", {
      mode: "timestamp_ms",
    }),
    // Hour-of-day bucket (0–23 = chunkForUser(userId)): the poller handles the
    // bucket matching the current UTC hour, spreading load across the day so a
    // large membership can't stampede OverFast in one tick.
    pollChunk: integer("poll_chunk").notNull(),
    // When the most recent snapshot landed — the interval guard + the poller's
    // "is this player due?" gate both read it.
    lastSnapshotAt: integer("last_snapshot_at", { mode: "timestamp_ms" }),
    firstConnectedAt: integer("first_connected_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // The poller selects due players by chunk; last_snapshot_at drives the
    // catch-up sweep for anyone missed.
    index("ow_players_chunk_idx").on(t.pollChunk),
    index("ow_players_last_snapshot_idx").on(t.lastSnapshotAt),
  ],
);

/**
 * APPEND-ONLY career snapshot — one row per player per capture. Never updated.
 *
 * A handful of denormalized headline scalars (games/winrate/kda/comp tiers) are
 * columns so the "how am I improving" time-series charts query without parsing a
 * blob per point; the full per-hero / per-role detail lives in the `*_json`
 * blobs, read only by the detail view (the "extend by row, not column" rule from
 * schema.ts applied within a row — a new OverFast field is never a migration).
 */
export const owSnapshots = sqliteTable(
  "ow_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
    battletag: text("battletag"),
    playerId: text("player_id"),
    platform: text("platform"),

    // --- summary (/players/{id}/summary) ---
    endorsementLevel: integer("endorsement_level"),
    title: text("title"),
    avatarUrl: text("avatar_url"),
    namecardUrl: text("namecard_url"),

    // --- competitive ranks for `platform`, per role (division text + tier int) ---
    compSeason: integer("comp_season"),
    tankDivision: text("tank_division"),
    tankTier: integer("tank_tier"),
    damageDivision: text("damage_division"),
    damageTier: integer("damage_tier"),
    supportDivision: text("support_division"),
    supportTier: integer("support_tier"),
    openDivision: text("open_division"),
    openTier: integer("open_tier"),

    // --- headline aggregates (/players/{id}/stats/summary → general) ---
    gamesPlayed: integer("games_played"),
    gamesWon: integer("games_won"),
    gamesLost: integer("games_lost"),
    timePlayed: integer("time_played"), // seconds
    winrate: real("winrate"),
    kda: real("kda"),
    totalEliminations: integer("total_eliminations"),
    totalAssists: integer("total_assists"),
    totalDeaths: integer("total_deaths"),
    totalDamage: integer("total_damage"),
    totalHealing: integer("total_healing"),
    avgEliminations: real("avg_eliminations"),
    avgAssists: real("avg_assists"),
    avgDeaths: real("avg_deaths"),
    avgDamage: real("avg_damage"),
    avgHealing: real("avg_healing"),

    // --- full payloads for the detail view (per-role + per-hero breakdown) ---
    summaryJson: text("summary_json"),
    statsJson: text("stats_json"),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // The chart read is "this member's snapshots, oldest→newest": one composite
    // index serves both the filter and the order.
    index("ow_snapshots_user_captured_idx").on(t.userId, t.capturedAt),
  ],
);

// ===========================================================================
// pd_* — cross-provider player data (external teams + match history).
//
// A member links FACEIT / start.gg / Challonge in Integrations; these tables
// hold what those platforms know about them: the persistent teams they're on
// (FACEIT premade teams, start.gg global teams — Challonge has no persistent
// team concept and contributes matches only) and their full match history.
// The Teams tab shows pd_teams inline with internal teams; the Statistics →
// Match Data tab reads pd_matches.
//
// Same two-writer model as ow_snapshots, and the same worker: the Commons
// (lib/player-data.ts) syncs lazily on page open / refresh-icon past a TTL, and
// the ow-data Worker's hourly cron syncs a chunk of due members
// (pd_sync.poll_chunk, assigned with the same chunkForUser as ow_players).
// Challonge is the exception: it reads through the MEMBER's OAuth token, which
// only exists Commons-side (Better Auth refresh), so the cron skips challonge
// rows and they stay page-open/refresh-only.
//
// Writes are safe under concurrency without coordination: pd_matches upserts on
// a (user, provider, external match id) natural key, pd_teams upserts on its
// deterministic id, rosters/links are rewritten atomically per sync inside a
// db.batch, and pd_sync rows are only advanced (lastSyncedAt/cursor) by the
// writer that actually ran. The ow-data repo keeps a COLUMN-COMPATIBLE copy of
// this file (like ow_players/ow_snapshots); migrations stay owned by the
// Commons (drizzle-ow/).
// ===========================================================================

/**
 * One row per (member, provider): the sync registry. Mirrors the provider
 * external id + handle out of website-sql's platform_identities so the poller
 * (which has no website-sql binding) can run standalone — exactly like
 * ow_players mirrors the BattleTag. The Commons refreshes the mirror on every
 * page-open sync and deletes the row (with the member's links/matches) when the
 * provider is unlinked.
 */
export const pdSync = sqliteTable(
  "pd_sync",
  {
    /** Deterministic `${userId}:${provider}` — stable across both writers. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** 'faceit' | 'startgg' | 'challonge' (lib/player-data-shared.ts). */
    provider: text("provider").notNull(),
    /** The provider's stable member id (FACEIT guid, start.gg user id, …). */
    externalId: text("external_id").notNull(),
    handle: text("handle"),
    /**
     * Provider-specific extras, parsed defensively (a bad blob reads as {}):
     * start.gg caches the member's player id (sets are keyed by player, not
     * user); FACEIT caches the member's game list. "Extend by row, not column."
     */
    meta: text("meta"),
    /** Hour-of-day bucket (chunkForUser) — the cron tick that owns this row. */
    pollChunk: integer("poll_chunk").notNull(),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    /**
     * Where the unbounded history backfill has got to, as provider-specific
     * JSON (start.gg: { page }, FACEIT: { gameIndex, offset }, Challonge:
     * { page, seen }). Null until the first sync; ignored once backfillDone.
     */
    backfillCursor: text("backfill_cursor"),
    backfillDone: integer("backfill_done", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Outcome of the last sync, surfaced to the member on the Match Data tab:
     * 'ok' | 'private' | 'not_found' | 'error'. Null = never synced. Only a
     * definitive provider answer sets private/not_found (the connectReachability
     * rule) — an outage stays 'error', which the UI words as transient.
     */
    status: text("status"),
    statusDetail: text("status_detail"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("pd_sync_user_provider_unique").on(t.userId, t.provider),
    // The poller selects due rows by chunk; last_synced_at drives its catch-up
    // sweep and the Commons' TTL gate.
    index("pd_sync_chunk_idx").on(t.pollChunk),
    index("pd_sync_last_synced_idx").on(t.lastSyncedAt),
  ],
);

/**
 * One row per external team, shared across members (two linked members on the
 * same FACEIT team share this row). The id is deterministic so both writers
 * upsert the same row without coordination.
 */
export const pdTeams = sqliteTable(
  "pd_teams",
  {
    /** Deterministic `${provider}:${externalTeamId}` — also the public id the
        Teams tab links by (/teams/<percent-encoded id>/). */
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    /** FACEIT team guid / start.gg GlobalTeam id (EventTeam duplicates are
        normalized to their global team at sync time). */
    externalTeamId: text("external_team_id").notNull(),
    name: text("name").notNull(),
    /** Display game name as the provider reports it ("Overwatch 2", "cs2"). */
    game: text("game"),
    logoUrl: text("logo_url"),
    /** The team's page on the provider (out-link on the detail view). */
    url: text("url"),
    /** When the roster below was last rewritten — roster refreshes are budgeted
        per sync tick, so this staleness stamp picks which teams get one. */
    rosterRefreshedAt: integer("roster_refreshed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("pd_teams_provider_external_unique").on(
      t.provider,
      t.externalTeamId,
    ),
  ],
);

/**
 * The roster of an external team, as the provider reports it (provider handles,
 * not Commons users). Rewritten atomically per team (delete + insert in one
 * db.batch) whenever a sync refreshes that team's roster.
 */
export const pdTeamMembers = sqliteTable(
  "pd_team_members",
  {
    id: text("id").primaryKey(),
    /** pd_teams.id (no FK — both writers rewrite children with the parent). */
    teamId: text("team_id").notNull(),
    playerExternalId: text("player_external_id"),
    handle: text("handle"),
    /** 'leader' | 'captain' | 'member' — normalized across providers. */
    role: text("role"),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("pd_team_members_team_idx").on(t.teamId)],
);

/**
 * Which external teams a MEMBER is on — the per-user membership set, rewritten
 * per (user, provider) on every teams sync. The Teams tab joins links → teams;
 * a link is also the authorization to open the team's detail page (a team
 * you're not on is indistinguishable from one that doesn't exist, matching the
 * internal-team rule in app/teams/[teamId]).
 */
export const pdTeamLinks = sqliteTable(
  "pd_team_links",
  {
    /** Deterministic `${userId}:${teamId}`. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** pd_teams.id. */
    teamId: text("team_id").notNull(),
    /** Mirrors pd_teams.provider so "rewrite this user's faceit links" needs no
        join. */
    provider: text("provider").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("pd_team_links_user_idx").on(t.userId),
    index("pd_team_links_team_idx").on(t.teamId),
  ],
);

/**
 * A member's external match history, one row per (member, provider, match) —
 * upserted, so re-pulls and the backfill/incremental overlap are idempotent.
 * Rows are parsed columns only, no raw payload blob: the backfill is unbounded,
 * and a veteran FACEIT account can run to thousands of matches.
 *
 * Two members in the same match each get their own row (rare, and it keeps
 * every read a single WHERE user_id = ?); team match lists dedupe by
 * external_match_id in app code.
 */
export const pdMatches = sqliteTable(
  "pd_matches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    externalMatchId: text("external_match_id").notNull(),
    /** Display game name/id as the provider reports it. */
    game: text("game"),
    /** Tournament / competition / league name, when known. */
    competitionName: text("competition_name"),
    /** Provider round label ("Losers Round 3"), when known. */
    roundText: text("round_text"),
    /** The provider team id of the MEMBER's side, when the provider reports one
        (FACEIT faction team_id, start.gg entrant's global team). This is what
        attributes a match to a pd_teams row for the team detail view. */
    teamExternalId: text("team_external_id"),
    teamName: text("team_name"),
    opponentTeamId: text("opponent_team_id"),
    opponentName: text("opponent_name"),
    scoreFor: integer("score_for"),
    scoreAgainst: integer("score_against"),
    /** 'win' | 'loss' | 'draw', or null when the member's side is unknown. */
    result: text("result"),
    /** Normalized lifecycle, same vocabulary as the schedule ('scheduled' |
        'live' | 'finished' | 'cancelled'). */
    status: text("status").notNull().default("finished"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    /** Deep link to the provider's own match/set page. */
    url: text("url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // The upsert key.
    uniqueIndex("pd_matches_user_provider_match_unique").on(
      t.userId,
      t.provider,
      t.externalMatchId,
    ),
    // Match Data tab: "this member's matches, newest first".
    index("pd_matches_user_started_idx").on(t.userId, t.startedAt),
    // Team detail: "this external team's matches, newest first".
    index("pd_matches_team_started_idx").on(
      t.provider,
      t.teamExternalId,
      t.startedAt,
    ),
  ],
);
