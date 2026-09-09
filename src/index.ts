import { drizzle } from "drizzle-orm/d1";
import { and, desc, isNotNull, isNull, lt, or } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { owPlayers, owSnapshots, pdSync } from "./ow-schema";
import {
  faceitMatchPlayers,
  faceitMatchRounds,
  faceitMatches,
  faceitPlayers,
} from "./faceit-schema";
import {
  DEFAULT_OVERFAST_BASE,
  fetchOwStatsSummary,
  fetchOwSummary,
} from "./overfast";
import { MIN_SNAPSHOT_INTERVAL_MS, extractSnapshotColumns } from "./snapshot";
import { PD_SYNC_TTL_MS } from "./player-data-shared";
import {
  applySyncOutcome,
  runProviderSync,
  staleRosterTeamIds,
} from "./player-data-sync";
import {
  collectDetailChunk,
  collectListChunk,
  countUndetailed,
  finalizePlayerState,
  resolveFaceitPlayer,
  upsertProfileStmt,
} from "./faceit-collect";

// ---------------------------------------------------------------------------
// ow-data — a standalone Cloudflare Worker (its own repo) that keeps the
// player-data store (the `ow-player-data` D1, shared with the Commons via the
// OW binding) filled:
//   1. Overwatch career snapshots (ow_snapshots) — one per player per day, so
//      members accrue history even when they don't open the Statistics tab.
//   2. Cross-provider player data (pd_* tables) — external FACEIT / start.gg
//      teams + full match history per linked member. Challonge rows are
//      SKIPPED here: they read through the member's OAuth token, which only the
//      Commons (Better Auth) can mint, so those sync on page open alone.
//
// Players are spread across 24 hourly buckets (`poll_chunk`, assigned by the
// Commons). Each hourly cron tick handles the bucket matching the current UTC
// hour, plus a catch-up sweep for anyone missed. OW snapshots are APPEND-ONLY
// behind MIN_SNAPSHOT_INTERVAL_MS; pd writes are idempotent upserts behind
// PD_SYNC_TTL_MS — so this worker and the Commons (which also syncs on connect
// / page open) never duplicate work. Best-effort throughout — a provider miss
// writes nothing (OW) or lands as a visible pd_sync status.
//
// The Commons OWNS the schema + migrations; this Worker only reads/writes rows.
// ---------------------------------------------------------------------------

export interface Env {
  OW: D1Database;
  /** OverFast base URL; defaults to the public instance when unset. */
  OVERFAST_API_URL?: string;
  /** Bearer secret for the manual POST /run trigger (cron needs no secret). */
  OW_POLLER_SECRET?: string;
  /** FACEIT Data API key (secret) — unset leaves FACEIT pd rows to the Commons. */
  FACEIT_API_KEY?: string;
  /** start.gg personal API token (secret) — unset likewise. */
  STARTGG_API_KEY?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_CHUNKS = 24;
/** Safety cap on players polled per run, so one tick can't fan out unbounded. */
const MAX_PER_RUN = 150;
/** Pace between players (each = 2 OverFast calls) to respect its shared
    per-second rate limit. */
const DELAY_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PollResult = { processed: number; snapshotted: number; errors: number };

/**
 * Snapshot every player due in `hour`'s bucket (plus stale catch-ups). A player
 * is "due" only if their last snapshot is older than the interval guard, so a
 * fresh Commons snapshot is never duplicated.
 */
async function pollHour(env: Env, hour: number): Promise<PollResult> {
  const db = drizzle(env.OW, { schema: { owPlayers, owSnapshots } });
  const now = Date.now();
  const guardCutoff = new Date(now - MIN_SNAPSHOT_INTERVAL_MS);
  const staleCutoff = now - DAY_MS;

  // Candidates: anyone not snapshotted within the guard window.
  const candidates = await db
    .select()
    .from(owPlayers)
    .where(
      or(isNull(owPlayers.lastSnapshotAt), lt(owPlayers.lastSnapshotAt, guardCutoff)),
    );

  // This tick: players in the current bucket, plus any who slipped past a full
  // day (a missed tick / a new registration in another bucket).
  const due = candidates
    .filter(
      (p) =>
        p.pollChunk === hour ||
        p.lastSnapshotAt == null ||
        p.lastSnapshotAt.getTime() < staleCutoff,
    )
    .slice(0, MAX_PER_RUN);

  const base = env.OVERFAST_API_URL || DEFAULT_OVERFAST_BASE;
  let snapshotted = 0;
  let errors = 0;

  for (const player of due) {
    try {
      const [summary, stats] = await Promise.all([
        fetchOwSummary(base, player.playerId),
        fetchOwStatsSummary(base, player.playerId),
      ]);
      if (!summary && !stats) continue; // provider miss — don't write/bump

      const captured = new Date();
      const cols = extractSnapshotColumns(summary, stats);
      const insert = db.insert(owSnapshots).values({
        id: crypto.randomUUID(),
        userId: player.userId,
        capturedAt: captured,
        battletag: player.battletag,
        playerId: player.playerId,
        ...cols,
        summaryJson: summary ? JSON.stringify(summary) : null,
        statsJson: stats ? JSON.stringify(stats) : null,
      });
      const update = db
        .update(owPlayers)
        .set({
          platform: cols.platform,
          lastSnapshotAt: captured,
          visibility: "public",
          visibilityCheckedAt: captured,
          updatedAt: captured,
        })
        .where(eq(owPlayers.userId, player.userId));
      await db.batch([insert, update]);
      snapshotted++;
    } catch (error) {
      errors++;
      console.error("ow-data: snapshot failed for", player.userId, error);
    }
    await sleep(DELAY_MS);
  }

  return { processed: due.length, snapshotted, errors };
}

/** Safety cap on pd rows synced per run (each row is up to ~15 provider calls
    during a backfill, so this is deliberately tighter than MAX_PER_RUN). */
const MAX_PD_PER_RUN = 40;

type PdPollResult = { processed: number; synced: number; errors: number };

/**
 * Sync every due pd_sync row in `hour`'s bucket (plus stale catch-ups). A row
 * is due only when its last sync is older than the shared TTL, so a page-open
 * sync the member just triggered is never duplicated. Challonge rows are
 * excluded — no member token here (see the header).
 */
async function pollPlayerDataHour(env: Env, hour: number): Promise<PdPollResult> {
  if (!env.FACEIT_API_KEY && !env.STARTGG_API_KEY) {
    return { processed: 0, synced: 0, errors: 0 };
  }
  const db = drizzle(env.OW);
  const now = Date.now();
  const ttlCutoff = new Date(now - PD_SYNC_TTL_MS);
  const staleCutoff = now - DAY_MS;

  const candidates = await db
    .select()
    .from(pdSync)
    .where(or(isNull(pdSync.lastSyncedAt), lt(pdSync.lastSyncedAt, ttlCutoff)));

  const due = candidates
    .filter(
      (r) =>
        r.provider !== "challonge" &&
        (r.pollChunk === hour ||
          r.lastSyncedAt == null ||
          r.lastSyncedAt.getTime() < staleCutoff),
    )
    .slice(0, MAX_PD_PER_RUN);

  let synced = 0;
  let errors = 0;
  for (const row of due) {
    try {
      const outcome = await runProviderSync({
        row,
        faceitApiKey: env.FACEIT_API_KEY ?? null,
        startggApiKey: env.STARTGG_API_KEY ?? null,
        challongeToken: null,
        rosterDue: (ids) => staleRosterTeamIds(db, row.provider, ids),
      });
      if (outcome) {
        await applySyncOutcome(db, row, outcome);
        synced++;
      }
    } catch (error) {
      errors++;
      console.error(
        "ow-data: player-data sync failed for",
        row.userId,
        row.provider,
        error,
      );
    }
    await sleep(DELAY_MS);
  }

  return { processed: due.length, synced, errors };
}

// ---------------------------------------------------------------------------
// FACEIT match-search collection (faceit_* tables). A SEARCH-driven cache: the
// Commons search box triggers POST /faceit/search on this Worker, which resolves
// the player and advances a bounded, resumable two-phase collection (match LIST,
// then per-match overview + scoreboard DETAIL). The hourly cron finishes any
// backfill still in flight; the Commons reads the faceit_* rows directly.
//
// "quick" surfaces the recent ~50 games' detail fast (one list page + a detail
// burst) and leaves the long tail to cron. "deep" is driven to completion by the
// Commons: after the trigger it loops POST /faceit/advance (a bounded SYNCHRONOUS
// chunk each call, returning progress counts) until list + detail are done or a
// safety cap is hit. Same engine (faceit-collect.ts), different budgets.
// ---------------------------------------------------------------------------

type FaceitBudget = { listPages: number; detailMatches: number };

// The trigger returns fast: one list page synchronously, the rest in waitUntil.
const FACEIT_TRIGGER_SYNC: FaceitBudget = { listPages: 1, detailMatches: 0 };
const FACEIT_WAITUNTIL: Record<"quick" | "deep", FaceitBudget> = {
  // Quick aims at the recent ~50 games detailed fast: one list page (newest 100)
  // and detail the newest ~48, so maps + scoreboards surface without paging all
  // history. Deep front-loads a first burst; the /faceit/advance loop (driven by
  // the Commons deep search) finishes the rest.
  quick: { listPages: 1, detailMatches: 48 },
  deep: { listPages: 8, detailMatches: 30 },
};
// Per-call budget for POST /faceit/advance — the synchronous "drive to
// completion" the Commons deep search polls. Bigger than a cron chunk (the
// caller is waiting), still well under the 1000-subrequest cap (detail = 2
// calls each, so deep = ~96 subrequests/call).
const FACEIT_ADVANCE: Record<"quick" | "deep", FaceitBudget> = {
  quick: { listPages: 2, detailMatches: 16 },
  // Kept intentionally modest so each call returns in a handful of seconds and
  // the deep loading bar advances smoothly across many calls, rather than one
  // long-running request that risks the caller's timeout.
  deep: { listPages: 6, detailMatches: 24 },
};
// Cron chips away at anything still unfinished, bounded so one tick stays under
// the subrequest cap even across several due players.
const FACEIT_CRON: Record<"quick" | "deep", FaceitBudget> = {
  quick: { listPages: 3, detailMatches: 12 },
  deep: { listPages: 4, detailMatches: 20 },
};
const FACEIT_CRON_MAX_PLAYERS = 8;

type FaceitDbHandle = ReturnType<typeof faceitDb>;
function faceitDb(env: Env) {
  return drizzle(env.OW, {
    schema: { faceitPlayers, faceitMatches, faceitMatchPlayers, faceitMatchRounds },
  });
}

type FaceitPlayerRow = {
  playerId: string;
  game: string;
  listOffset: number;
  listDone: boolean;
  detailDone: boolean;
  searchMode: string | null;
};

/**
 * Advance one searched player by a bounded amount: page the match LIST (until
 * done), then fill per-match DETAIL, then persist the recomputed state. Never
 * throws — a provider miss lands as status 'error' with the cursor intact.
 */
async function advanceFaceitPlayer(
  db: FaceitDbHandle,
  apiKey: string,
  row: FaceitPlayerRow,
  budget: FaceitBudget,
): Promise<{ matchCount: number; listDone: boolean; detailDone: boolean }> {
  let listOffset = row.listOffset;
  let listDone = row.listDone;
  let failed = false;

  if (!listDone && budget.listPages > 0) {
    const r = await collectListChunk(
      db,
      apiKey,
      { playerId: row.playerId, game: row.game, listOffset },
      budget.listPages,
    );
    listOffset = r.newOffset;
    listDone = r.listDone;
    if (r.failed) failed = true;
  }

  if (budget.detailMatches > 0) {
    const d = await collectDetailChunk(db, apiKey, row.playerId, budget.detailMatches);
    if (d.failed > 0) failed = true;
  }

  const state = await finalizePlayerState(db, row.playerId, {
    listOffset,
    listDone,
    failed,
  });
  return state;
}

/** Sweep due searched players (this hour's bucket + stale catch-ups) that still
    have backfill left, advancing each by a bounded cron budget. */
async function faceitSweep(
  env: Env,
  hour: number,
): Promise<{ processed: number; errors: number }> {
  if (!env.FACEIT_API_KEY) return { processed: 0, errors: 0 };
  const db = faceitDb(env);
  const staleCutoff = new Date(Date.now() - DAY_MS);

  // SQL-filter to SEARCHED, UNFINISHED players only — the table also holds every
  // opponent seeded during collection, so a full scan would grow without bound.
  const candidates = await db
    .select()
    .from(faceitPlayers)
    .where(
      and(
        isNotNull(faceitPlayers.searchMode),
        isNotNull(faceitPlayers.pollChunk),
        or(eq(faceitPlayers.listDone, false), eq(faceitPlayers.detailDone, false)),
      ),
    );
  const due = candidates
    .filter(
      (p) =>
        p.pollChunk === hour ||
        p.lastSyncedAt == null ||
        p.lastSyncedAt < staleCutoff,
    )
    // Deep collections first — they asked for the whole history up front.
    .sort((a, b) => (a.searchMode === "deep" ? -1 : 1) - (b.searchMode === "deep" ? -1 : 1))
    .slice(0, FACEIT_CRON_MAX_PLAYERS);

  let errors = 0;
  for (const p of due) {
    const mode = p.searchMode === "deep" ? "deep" : "quick";
    try {
      await advanceFaceitPlayer(
        db,
        env.FACEIT_API_KEY,
        {
          playerId: p.playerId,
          game: p.game,
          listOffset: p.listOffset,
          listDone: p.listDone,
          detailDone: p.detailDone,
          searchMode: p.searchMode,
        },
        FACEIT_CRON[mode],
      );
    } catch (error) {
      errors++;
      console.error("ow-data: faceit sweep failed for", p.playerId, error);
    }
    await sleep(DELAY_MS);
  }
  return { processed: due.length, errors };
}

/**
 * Handle POST /faceit/search — resolve a nickname/guid, register it for the
 * requested mode, do one list page synchronously so the cache has immediate
 * data, and continue the rest in waitUntil. The Commons reads faceit_* directly.
 */
async function handleFaceitSearch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (!env.FACEIT_API_KEY) return json({ error: "FACEIT not configured" }, 503);
  const nickname = url.searchParams.get("nickname") ?? undefined;
  const playerId = url.searchParams.get("player_id") ?? undefined;
  const mode = url.searchParams.get("mode") === "deep" ? "deep" : "quick";
  if (!nickname && !playerId) {
    return json({ error: "nickname or player_id required" }, 400);
  }

  const db = faceitDb(env);
  const resolved = await resolveFaceitPlayer(env.FACEIT_API_KEY, { nickname, playerId });
  if (resolved === "not_found") {
    if (playerId) {
      await db
        .update(faceitPlayers)
        .set({ status: "not_found", updatedAt: new Date() })
        .where(eq(faceitPlayers.playerId, playerId));
    }
    return json({ error: "player not found" }, 404);
  }
  if (!resolved) return json({ error: "FACEIT unreachable" }, 502);

  // Register the search (sets mode + poll bucket + status 'collecting').
  const now = new Date();
  const [existing] = await db
    .select({ listOffset: faceitPlayers.listOffset, listDone: faceitPlayers.listDone })
    .from(faceitPlayers)
    .where(eq(faceitPlayers.playerId, resolved.playerId));
  await db.batch([upsertProfileStmt(db, resolved, { mode, now })]);

  // Immediate: one list page so the first screen has matches right away.
  const state = await advanceFaceitPlayer(
    db,
    env.FACEIT_API_KEY,
    {
      playerId: resolved.playerId,
      game: resolved.game,
      listOffset: existing?.listOffset ?? 0,
      listDone: existing?.listDone ?? false,
      detailDone: false,
      searchMode: mode,
    },
    FACEIT_TRIGGER_SYNC,
  );

  // Background: continue list + fill detail without holding the response.
  ctx.waitUntil(
    (async () => {
      try {
        const [fresh] = await db
          .select({
            listOffset: faceitPlayers.listOffset,
            listDone: faceitPlayers.listDone,
            detailDone: faceitPlayers.detailDone,
          })
          .from(faceitPlayers)
          .where(eq(faceitPlayers.playerId, resolved.playerId));
        await advanceFaceitPlayer(
          db,
          env.FACEIT_API_KEY as string,
          {
            playerId: resolved.playerId,
            game: resolved.game,
            listOffset: fresh?.listOffset ?? state.matchCount,
            listDone: fresh?.listDone ?? state.listDone,
            detailDone: fresh?.detailDone ?? state.detailDone,
            searchMode: mode,
          },
          FACEIT_WAITUNTIL[mode],
        );
      } catch (error) {
        console.error("ow-data: faceit waitUntil failed for", resolved.playerId, error);
      }
    })(),
  );

  return json({
    player: {
      playerId: resolved.playerId,
      nickname: resolved.nickname,
      avatarUrl: resolved.avatarUrl,
      skillLevel: resolved.skillLevel,
      faceitElo: resolved.faceitElo,
      region: resolved.region,
      faceitUrl: resolved.faceitUrl,
    },
    mode,
    status: state.listDone && state.detailDone ? "ready" : "collecting",
    matchCount: state.matchCount,
    listDone: state.listDone,
    detailDone: state.detailDone,
  });
}

/**
 * Handle POST /faceit/advance — drive an already-registered player's collection
 * forward by one bounded, SYNCHRONOUS chunk (no waitUntil: the Commons deep
 * search is waiting on the response and loops this until done). Returns the
 * progress counts the deep loading bar reads. Never resolves the profile again,
 * so a deep loop costs no extra FACEIT search calls.
 */
async function handleFaceitAdvance(env: Env, url: URL): Promise<Response> {
  if (!env.FACEIT_API_KEY) return json({ error: "FACEIT not configured" }, 503);
  const playerId = url.searchParams.get("player_id") ?? undefined;
  const mode = url.searchParams.get("mode") === "deep" ? "deep" : "quick";
  if (!playerId) return json({ error: "player_id required" }, 400);

  const db = faceitDb(env);
  const [row] = await db
    .select({
      playerId: faceitPlayers.playerId,
      game: faceitPlayers.game,
      listOffset: faceitPlayers.listOffset,
      listDone: faceitPlayers.listDone,
      detailDone: faceitPlayers.detailDone,
      searchMode: faceitPlayers.searchMode,
    })
    .from(faceitPlayers)
    .where(eq(faceitPlayers.playerId, playerId));
  if (!row) return json({ error: "not collected yet" }, 404);

  const state = await advanceFaceitPlayer(
    db,
    env.FACEIT_API_KEY,
    {
      playerId: row.playerId,
      game: row.game,
      listOffset: row.listOffset,
      listDone: row.listDone,
      detailDone: row.detailDone,
      searchMode: row.searchMode,
    },
    FACEIT_ADVANCE[mode],
  );
  const undetailed = await countUndetailed(db, row.playerId);
  return json({
    status: state.listDone && state.detailDone ? "ready" : "collecting",
    matchCount: state.matchCount,
    undetailed,
    listDone: state.listDone,
    detailDone: state.detailDone,
  });
}

/** Read the cached collection for a player (identity + matches + scoreboard). */
async function handleFaceitRead(env: Env, url: URL): Promise<Response> {
  const playerId = url.searchParams.get("player_id") ?? undefined;
  const nickname = url.searchParams.get("nickname") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  if (!playerId && !nickname) return json({ error: "nickname or player_id required" }, 400);

  const db = faceitDb(env);
  const [player] = await db
    .select()
    .from(faceitPlayers)
    .where(
      playerId
        ? eq(faceitPlayers.playerId, playerId)
        : eq(faceitPlayers.nickname, nickname as string),
    );
  if (!player) return json({ error: "not collected yet" }, 404);

  const rows = await db
    .select()
    .from(faceitMatchPlayers)
    .innerJoin(faceitMatches, eq(faceitMatchPlayers.matchId, faceitMatches.matchId))
    .where(eq(faceitMatchPlayers.playerId, player.playerId))
    .orderBy(desc(faceitMatches.startedAt))
    .limit(limit);

  return json({
    player,
    matchCount: player.matchCount,
    status: player.status,
    matches: rows.map((r) => ({ ...r.faceit_matches, me: r.faceit_match_players })),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Constant-time-ish bearer compare for the manual-run gate. */
function bearerOk(header: string | null, secret: string): boolean {
  const expected = `Bearer ${secret}`;
  const got = header ?? "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  // Hourly cron: process the bucket for the current UTC hour — OW snapshots
  // first, then the cross-provider player-data sync.
  async scheduled(_event, env: Env): Promise<void> {
    const hour = new Date().getUTCHours();
    const result = await pollHour(env, hour);
    console.log("ow-data cron", { hour, ...result });
    const pd = await pollPlayerDataHour(env, hour);
    console.log("ow-data pd cron", { hour, ...pd });
    const faceit = await faceitSweep(env, hour);
    console.log("ow-data faceit cron", { hour, ...faceit });
  },

  // Health check + a secret-gated manual trigger (cron can't be fired on
  // demand, so this is how the run logic is exercised in dev / on rollout).
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ow-data ok");
    }

    // FACEIT match search — gated by the same bearer as /run (the Commons calls
    // it server-to-server). POST triggers a collection; GET reads the cache.
    if (url.pathname === "/faceit/search" && request.method === "POST") {
      if (!env.OW_POLLER_SECRET) return json({ error: "not configured" }, 503);
      if (!bearerOk(request.headers.get("authorization"), env.OW_POLLER_SECRET)) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleFaceitSearch(request, env, ctx, url);
    }
    if (url.pathname === "/faceit/advance" && request.method === "POST") {
      if (!env.OW_POLLER_SECRET) return json({ error: "not configured" }, 503);
      if (!bearerOk(request.headers.get("authorization"), env.OW_POLLER_SECRET)) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleFaceitAdvance(env, url);
    }
    if (url.pathname === "/faceit/player" && request.method === "GET") {
      if (!env.OW_POLLER_SECRET) return json({ error: "not configured" }, 503);
      if (!bearerOk(request.headers.get("authorization"), env.OW_POLLER_SECRET)) {
        return json({ error: "unauthorized" }, 401);
      }
      return handleFaceitRead(env, url);
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!env.OW_POLLER_SECRET) return json({ error: "not configured" }, 503);
      if (!bearerOk(request.headers.get("authorization"), env.OW_POLLER_SECRET)) {
        return json({ error: "unauthorized" }, 401);
      }
      const chunkParam = url.searchParams.get("chunk");
      const hour =
        chunkParam != null ? Number(chunkParam) : new Date().getUTCHours();
      if (!Number.isInteger(hour) || hour < 0 || hour >= POLL_CHUNKS) {
        return json({ error: "chunk must be an integer 0–23" }, 400);
      }
      const result = await pollHour(env, hour);
      const pd = await pollPlayerDataHour(env, hour);
      return json({ chunk: hour, ...result, playerData: pd });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
