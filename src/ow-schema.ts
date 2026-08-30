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
} from "drizzle-orm/sqlite-core";

// ===========================================================================
// ow-player-data — the Overwatch player-statistics store (a THIRD D1 database).
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
