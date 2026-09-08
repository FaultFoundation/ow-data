// ⚠️ SOURCE OF TRUTH for the `faceit_*` tables. Unlike ow_*/pd_* (owned by the
// Commons), THIS repo owns these tables and their migrations: edit this file,
// then `npm run db:faceit:generate` + `db:faceit:migrate:*` (tracked in the
// separate `d1_migrations_faceit` table — see wrangler.jsonc). The Commons keeps
// a COLUMN-COMPATIBLE copy of these defs only to TYPE its reads, and must keep
// that copy OUT of its own drizzle config so it never migrates them. If you
// add/rename a column here, mirror it in the Commons' typing copy. See README.
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
} from "drizzle-orm/sqlite-core";

// ===========================================================================
// faceit_* — the FACEIT match-search cache (Overwatch).
//
// A SEPARATE subsystem from pd_* (which mirrors a LINKED MEMBER's own history).
// These tables are keyed by FACEIT identity, not by a Commons user: anyone can
// search ANY FACEIT player, and their full match history + per-match scoreboard
// + overview (server / map / hero bans / replay codes) is collected here once
// and then served from cache. The Commons search box triggers a collection on
// this Worker (POST /faceit/search) and reads these tables directly for display
// (same two-writer, read-the-rows relationship the Teams/Match-Data tabs have
// to pd_*).
//
// Everything the Data API gives is captured through THREE calls per match:
//   GET /players/{id}/history   — the match LIST (cheap, paged) → faceit_matches
//                                  summary cols + faceit_match_players list rows
//   GET /matches/{id}           — OVERVIEW: server, map, hero bans, replay codes
//   GET /matches/{id}/stats     — SCOREBOARD: per-player elims/deaths/assists/
//                                  K-D/damage/healing/mitigation/role/result
//
// "Quick" search stores the list immediately and fills detail in the background
// (cron + waitUntil); "deep" front-loads the detail. Both drive the SAME engine
// in faceit-collect.ts; the mode only changes how eagerly the detail phase runs.
//
// Icons (hero / map / server) are deliberately NOT stored — the Commons
// supplements those internally; only PLAYER avatars are kept (per the ask).
//
// Denormalization follows ow_snapshots' "extend by row, not column" rule: the
// headline scalars the UI sorts/filters on are columns; the long tail of derived
// per-player stats lives in a `stats_json` blob so a new FACEIT field is never a
// migration. The giant `/matches/{id}` votable-entity payload (mostly icon URLs)
// is parsed down to the few fields we want and NOT stored raw.
// ===========================================================================

/**
 * One row per FACEIT player we've encountered. A SEARCHED player carries a
 * `search_mode` + `poll_chunk` + collection state (the cron advances them); an
 * opponent merely SEEN while collecting someone else is seeded here too (id,
 * nickname, avatar, in-game handle) with a null `search_mode`, so a later search
 * for them is instant — but the cron ignores seen-only rows.
 */
export const faceitPlayers = sqliteTable(
  "faceit_players",
  {
    /** FACEIT player guid. */
    playerId: text("player_id").primaryKey(),
    nickname: text("nickname").notNull(),
    avatarUrl: text("avatar_url"),
    country: text("country"),
    /** FACEIT game id the search covers ('ow2'). */
    game: text("game").notNull().default("ow2"),
    /** In-game (Blizzard) id + name for the game above. */
    gamePlayerId: text("game_player_id"),
    gamePlayerName: text("game_player_name"),
    /** Current skill level + elo (from the player endpoint, refreshed on search). */
    skillLevel: integer("skill_level"),
    faceitElo: integer("faceit_elo"),
    region: text("region"),
    faceitUrl: text("faceit_url"),
    verified: integer("verified", { mode: "boolean" }),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),

    // --- collection state (searched players only) --------------------------
    /** 'quick' | 'deep' — the last mode requested; null = seen-only (not searched). */
    searchMode: text("search_mode"),
    /** Hour-of-day bucket for the cron sweep; null = seen-only (cron skips it). */
    pollChunk: integer("poll_chunk"),
    /** How far the history LIST backfill has paged (offset reached). */
    listOffset: integer("list_offset").notNull().default(0),
    /** True once history paging returned a short page (list fully collected). */
    listDone: integer("list_done", { mode: "boolean" }).notNull().default(false),
    /** True once no match of this player is missing overview/scoreboard detail. */
    detailDone: integer("detail_done", { mode: "boolean" }).notNull().default(false),
    /** 'collecting' | 'ready' | 'not_found' | 'error' | null (never searched). */
    status: text("status"),
    statusDetail: text("status_detail"),
    /** Matches known for this player (updated as the list backfill advances). */
    matchCount: integer("match_count").notNull().default(0),
    firstSearchedAt: integer("first_searched_at", { mode: "timestamp_ms" }),
    lastSearchedAt: integer("last_searched_at", { mode: "timestamp_ms" }),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("faceit_players_nickname_idx").on(t.nickname),
    // The cron selects due searched players by chunk; last_synced_at drives the
    // catch-up sweep and the search-trigger's freshness gate.
    index("faceit_players_chunk_idx").on(t.pollChunk),
    index("faceit_players_last_synced_idx").on(t.lastSyncedAt),
  ],
);

/**
 * One row per match, shared across every player in it (deduped by match id). The
 * summary columns land during the LIST phase; the overview columns (server, map,
 * hero bans, replay codes) land when the DETAIL phase parses `/matches/{id}`.
 */
export const faceitMatches = sqliteTable(
  "faceit_matches",
  {
    /** FACEIT match id ("1-<uuid>"). */
    matchId: text("match_id").primaryKey(),
    game: text("game"),
    region: text("region"),
    competitionId: text("competition_id"),
    competitionName: text("competition_name"),
    competitionType: text("competition_type"),
    organizerId: text("organizer_id"),
    gameMode: text("game_mode"),
    matchType: text("match_type"),
    bestOf: integer("best_of"),
    round: integer("round"),
    groupNum: integer("group_num"),
    /** Normalized lifecycle ('scheduled' | 'live' | 'finished' | 'cancelled'). */
    status: text("status").notNull().default("finished"),
    /** Winning faction key ('faction1' | 'faction2'), when known. */
    winnerFaction: text("winner_faction"),
    /** Per-faction summary: { faction1: { teamId, nickname, avatar, score }, … }. */
    factionsJson: text("factions_json"),

    // --- overview (`/matches/{id}`) — server / map / bans / replay ----------
    /** Datacenter id ('ord1') + resolved server name ('USA - Central'). */
    locationId: text("location_id"),
    serverName: text("server_name"),
    /** Map guid + resolved name + OW2 mode ('Push' | 'Control' | …). */
    mapId: text("map_id"),
    mapName: text("map_name"),
    mapMode: text("map_mode"),
    /** Banned heroes as [{ guid, name }] (entities − pick from the veto). */
    heroBansJson: text("hero_bans_json"),
    /** Replay/demo codes as ["8C5DGE"] (from demo_url). */
    replayCodesJson: text("replay_codes_json"),
    /** Faction that attacked first, when the mode has one. */
    attackingFirst: text("attacking_first"),

    configuredAt: integer("configured_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    faceitUrl: text("faceit_url"),

    /** When `/matches/{id}` overview was parsed (null = not yet). */
    detailSyncedAt: integer("detail_synced_at", { mode: "timestamp_ms" }),
    /** When `/matches/{id}/stats` scoreboard was parsed (null = not yet). */
    statsSyncedAt: integer("stats_synced_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // "matches, newest first" and the detail sweep's "which still need detail".
    index("faceit_matches_started_idx").on(t.startedAt),
    index("faceit_matches_detail_synced_idx").on(t.detailSyncedAt),
    index("faceit_matches_stats_synced_idx").on(t.statsSyncedAt),
    index("faceit_matches_competition_idx").on(t.competitionId),
  ],
);

/**
 * One row per (match, player) — the scoreboard. Every player in a match gets a
 * row, so OPPONENTS (their nickname, id, profile link, avatar and stats) are
 * captured here with no separate opponent handling. The list phase fills the
 * identity + faction + result; the stats phase fills the scoreboard scalars and
 * the full `stats_json` blob.
 */
export const faceitMatchPlayers = sqliteTable(
  "faceit_match_players",
  {
    /** Deterministic `${matchId}:${playerId}`. */
    id: text("id").primaryKey(),
    matchId: text("match_id").notNull(),
    playerId: text("player_id").notNull(),
    nickname: text("nickname"),
    avatarUrl: text("avatar_url"),
    /** The faction key this player was on ('faction1' | 'faction2'). */
    faction: text("faction"),
    /** The faction's team/faction id. */
    teamId: text("team_id"),
    gamePlayerId: text("game_player_id"),
    gamePlayerName: text("game_player_name"),
    gameSkillLevel: integer("game_skill_level"),
    membership: text("membership"),
    /** 'win' | 'loss' | 'draw' — from the winning faction (known at list time). */
    result: text("result"),

    // --- scoreboard (`/matches/{id}/stats`) — headline scalars -------------
    role: text("role"),
    eliminations: integer("eliminations"),
    deaths: integer("deaths"),
    assists: integer("assists"),
    kdRatio: real("kd_ratio"),
    damageDealt: integer("damage_dealt"),
    healingDone: integer("healing_done"),
    damageMitigated: integer("damage_mitigated"),
    finalBlows: integer("final_blows"),
    soloKills: integer("solo_kills"),
    objectiveTime: integer("objective_time"),
    timePlayed: integer("time_played"),
    /** The complete per-player stats map from the API (the long-tail "& more"). */
    statsJson: text("stats_json"),
    statsSyncedAt: integer("stats_synced_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("faceit_match_players_match_idx").on(t.matchId),
    // "this player's scoreboard rows, newest first" joins back to matches.
    index("faceit_match_players_player_idx").on(t.playerId),
  ],
);
