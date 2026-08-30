import { drizzle } from "drizzle-orm/d1";
import { isNull, lt, or } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { owPlayers, owSnapshots } from "./ow-schema";
import {
  DEFAULT_OVERFAST_BASE,
  fetchOwStatsSummary,
  fetchOwSummary,
} from "./overfast";
import { MIN_SNAPSHOT_INTERVAL_MS, extractSnapshotColumns } from "./snapshot";

// ---------------------------------------------------------------------------
// ow-data — a standalone Cloudflare Worker (its own repo) that keeps the
// Overwatch player-statistics store (the `ow-player-data` D1, shared with the
// Commons via the OW binding) filling with a daily career snapshot per player,
// so members accrue history even when they don't open the Statistics tab.
//
// Players are spread across 24 hourly buckets (`ow_players.poll_chunk`, assigned
// by the Commons). Each hourly cron tick handles the bucket matching the current
// UTC hour, plus a catch-up sweep for anyone missed. Snapshots are APPEND-ONLY
// and guarded by MIN_SNAPSHOT_INTERVAL_MS, so this and the Commons (which also
// snapshots on connect / on read) never write two rows for the same player in a
// day. Best-effort throughout — a provider miss just writes nothing.
//
// The Commons OWNS the schema + migrations; this Worker only reads/writes rows.
// ---------------------------------------------------------------------------

export interface Env {
  OW: D1Database;
  /** OverFast base URL; defaults to the public instance when unset. */
  OVERFAST_API_URL?: string;
  /** Bearer secret for the manual POST /run trigger (cron needs no secret). */
  OW_POLLER_SECRET?: string;
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
  // Hourly cron: process the bucket for the current UTC hour.
  async scheduled(_event, env: Env): Promise<void> {
    const hour = new Date().getUTCHours();
    const result = await pollHour(env, hour);
    console.log("ow-data cron", { hour, ...result });
  },

  // Health check + a secret-gated manual trigger (cron can't be fired on
  // demand, so this is how the run logic is exercised in dev / on rollout).
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ow-data ok");
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
      return json({ chunk: hour, ...result });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
