import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  faceitMatchPlayers,
  faceitMatches,
  faceitPlayers,
} from "./faceit-schema";

// ---------------------------------------------------------------------------
// FACEIT match-search collection engine (Overwatch).
//
// Given a FACEIT nickname/guid, this fills the faceit_* cache from the Data API
// in two phases, both bounded-per-invocation and resumable so the paid Worker's
// 1000-subrequest cap is never a hard wall on a deep history:
//
//   LIST   — page GET /players/{id}/history?game=ow2 (100/page). Each match
//            upserts a faceit_matches summary row + a faceit_match_players row
//            per participant (identity, faction, result), and seeds every seen
//            player into faceit_players so a later search for an opponent is
//            instant. Advances faceit_players.list_offset; sets list_done on a
//            short page.
//   DETAIL — for this player's matches still missing overview/scoreboard, fetch
//            GET /matches/{id} (server / map / hero bans / replay codes) and
//            GET /matches/{id}/stats (per-player elims/deaths/assists/K-D/
//            damage/healing/mitigation/role). Newest-first, so "quick" surfaces
//            recent detail fast and "deep" simply runs more chunks per tick.
//
// Pure parsers (parse*) are separated from the D1 writers (collect*/upsert*) so
// the shapes stay testable. Never throws out of a collect* call — a transient
// provider miss leaves the cursor unadvanced and the next tick retries, exactly
// like the pd_* sync's best-effort contract.
// ---------------------------------------------------------------------------

const FACEIT_DATA = "https://open.faceit.com/data/v4";
const FACEIT_TIMEOUT_MS = 8000;

/** History page size (the Data API caps this at 100). */
export const FACEIT_HISTORY_PAGE_SIZE = 100;
/** D1 bound-statement chunk (kept well under the batch ceiling). */
const STMT_BATCH = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FaceitDb = DrizzleD1Database<any>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asString(x: unknown): string | null {
  return typeof x === "string" && x.length ? x : null;
}
function asNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
/** Parse a Data-API stat value (always a string) to an int, else null. */
function statInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
function statFloat(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function secondsToDate(x: unknown): Date | null {
  const n = asNumber(x);
  return n && n > 0 ? new Date(n * 1000) : null;
}
/** `{lang}`→`en` in the faceit_url templates the API returns. */
function enUrl(x: unknown): string | null {
  const s = asString(x);
  return s ? s.replace("{lang}", "en") : null;
}

/** Deterministic 0–23 bucket for the cron sweep, from the player guid. */
export function chunkForPlayer(playerId: string): number {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) {
    h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  return h % 24;
}

async function fetchJson(
  url: string,
  apiKey: string,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FACEIT_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, body };
  } catch {
    return null; // timeout / network — caller treats null as transient
  }
}

/** Apply a flat list of Drizzle statements in bounded batches. */
async function runBatched(
  db: FaceitDb,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stmts: any[],
): Promise<void> {
  for (let i = 0; i < stmts.length; i += STMT_BATCH) {
    const chunk = stmts.slice(i, i + STMT_BATCH);
    if (!chunk.length) continue;
    const [first, ...rest] = chunk;
    await db.batch([first, ...rest]);
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type FaceitProfile = {
  playerId: string;
  nickname: string;
  avatarUrl: string | null;
  country: string | null;
  game: string;
  gamePlayerId: string | null;
  gamePlayerName: string | null;
  skillLevel: number | null;
  faceitElo: number | null;
  region: string | null;
  faceitUrl: string | null;
  verified: boolean | null;
  activatedAt: Date | null;
};

type FaceitPlayerBody = {
  player_id?: string;
  nickname?: string;
  avatar?: string;
  country?: string;
  games?: Record<
    string,
    {
      region?: string;
      game_player_id?: string;
      game_player_name?: string;
      skill_level?: number;
      faceit_elo?: number;
    }
  >;
  faceit_url?: string;
  verified?: boolean;
  activated_at?: string;
};

export function parseProfile(
  body: unknown,
  game = "ow2",
): FaceitProfile | null {
  const p = body as FaceitPlayerBody;
  if (!p?.player_id || !p.nickname) return null;
  const g = p.games?.[game];
  const activated = asString(p.activated_at);
  const activatedAt = activated ? new Date(activated) : null;
  return {
    playerId: p.player_id,
    nickname: p.nickname,
    avatarUrl: asString(p.avatar),
    country: asString(p.country),
    game,
    gamePlayerId: asString(g?.game_player_id),
    gamePlayerName: asString(g?.game_player_name),
    skillLevel: asNumber(g?.skill_level),
    faceitElo: asNumber(g?.faceit_elo),
    region: asString(g?.region),
    faceitUrl: enUrl(p.faceit_url),
    verified: typeof p.verified === "boolean" ? p.verified : null,
    activatedAt: activatedAt && !Number.isNaN(activatedAt.getTime()) ? activatedAt : null,
  };
}

/** Resolve by nickname (search box) or by guid. Returns 'not_found' distinctly. */
export async function resolveFaceitPlayer(
  apiKey: string,
  opts: { nickname?: string; playerId?: string; game?: string },
): Promise<FaceitProfile | "not_found" | null> {
  const game = opts.game ?? "ow2";
  const url = opts.playerId
    ? `${FACEIT_DATA}/players/${encodeURIComponent(opts.playerId)}`
    : `${FACEIT_DATA}/players?nickname=${encodeURIComponent(opts.nickname ?? "")}&game=${game}`;
  const res = await fetchJson(url, apiKey);
  if (!res) return null; // transient
  if (res.status === 404) return "not_found";
  if (res.status !== 200) return null;
  return parseProfile(res.body, game);
}

// ---------------------------------------------------------------------------
// LIST phase — /players/{id}/history
// ---------------------------------------------------------------------------

type HistoryFactionPlayer = {
  player_id?: string;
  nickname?: string;
  avatar?: string;
  skill_level?: number;
  game_player_id?: string;
  game_player_name?: string;
  faceit_url?: string;
};
type HistoryItem = {
  match_id?: string;
  game_id?: string;
  region?: string;
  match_type?: string;
  game_mode?: string;
  teams?: Record<
    string,
    {
      team_id?: string;
      nickname?: string;
      avatar?: string;
      players?: HistoryFactionPlayer[];
    }
  >;
  competition_id?: string;
  competition_name?: string;
  competition_type?: string;
  organizer_id?: string;
  status?: string;
  started_at?: number;
  finished_at?: number;
  results?: { winner?: string; score?: Record<string, number> };
  faceit_url?: string;
};

function normalizeStatus(status: string | undefined): string {
  switch ((status ?? "").toUpperCase()) {
    case "ONGOING":
    case "LIVE":
      return "live";
    case "CANCELLED":
      return "cancelled";
    case "FINISHED":
      return "finished";
    default:
      return status ? "scheduled" : "finished";
  }
}

export type ParsedMatchPlayer = {
  playerId: string;
  nickname: string | null;
  avatarUrl: string | null;
  faction: string;
  teamId: string | null;
  gamePlayerId: string | null;
  gamePlayerName: string | null;
  gameSkillLevel: number | null;
  result: "win" | "loss" | "draw" | null;
};
export type ParsedHistoryMatch = {
  matchId: string;
  match: Record<string, unknown>;
  players: ParsedMatchPlayer[];
  seenProfiles: FaceitProfile[];
};

export function parseHistoryItem(item: HistoryItem): ParsedHistoryMatch | null {
  if (!item.match_id) return null;
  const factions = Object.entries(item.teams ?? {});
  const winner = asString(item.results?.winner);
  const status = normalizeStatus(item.status);
  const factionsSummary: Record<string, unknown> = {};
  const players: ParsedMatchPlayer[] = [];
  const seenProfiles: FaceitProfile[] = [];

  for (const [factionKey, faction] of factions) {
    const score = asNumber(item.results?.score?.[factionKey]);
    factionsSummary[factionKey] = {
      teamId: asString(faction.team_id),
      nickname: asString(faction.nickname),
      avatar: asString(faction.avatar),
      score,
    };
    const result: ParsedMatchPlayer["result"] = winner
      ? winner === factionKey
        ? "win"
        : "loss"
      : status === "finished"
        ? "draw"
        : null;
    for (const pl of faction.players ?? []) {
      if (!pl.player_id) continue;
      players.push({
        playerId: pl.player_id,
        nickname: asString(pl.nickname),
        avatarUrl: asString(pl.avatar),
        faction: factionKey,
        teamId: asString(faction.team_id),
        gamePlayerId: asString(pl.game_player_id),
        gamePlayerName: asString(pl.game_player_name),
        gameSkillLevel: asNumber(pl.skill_level),
        result,
      });
      seenProfiles.push({
        playerId: pl.player_id,
        nickname: pl.nickname ?? pl.player_id,
        avatarUrl: asString(pl.avatar),
        country: null,
        game: item.game_id ?? "ow2",
        gamePlayerId: asString(pl.game_player_id),
        gamePlayerName: asString(pl.game_player_name),
        skillLevel: asNumber(pl.skill_level),
        faceitElo: null,
        region: asString(item.region),
        faceitUrl: enUrl(pl.faceit_url),
        verified: null,
        activatedAt: null,
      });
    }
  }

  return {
    matchId: item.match_id,
    match: {
      matchId: item.match_id,
      game: item.game_id ?? "ow2",
      region: asString(item.region),
      competitionId: asString(item.competition_id),
      competitionName: asString(item.competition_name),
      competitionType: asString(item.competition_type),
      organizerId: asString(item.organizer_id),
      gameMode: asString(item.game_mode),
      matchType: asString(item.match_type),
      status,
      winnerFaction: winner,
      factionsJson: JSON.stringify(factionsSummary),
      startedAt: secondsToDate(item.started_at),
      finishedAt: secondsToDate(item.finished_at),
      faceitUrl: enUrl(item.faceit_url),
    },
    players,
    seenProfiles,
  };
}

/** Upsert a full/lightweight profile. `search` marks a searched player (sets
    mode + poll_chunk); omitted keeps the row seen-only (cron ignores it). */
export function upsertProfileStmt(
  db: FaceitDb,
  p: FaceitProfile,
  search?: { mode: "quick" | "deep"; now: Date },
) {
  const now = search?.now ?? new Date();
  const searchCols = search
    ? {
        searchMode: search.mode,
        pollChunk: chunkForPlayer(p.playerId),
        lastSearchedAt: now,
        status: "collecting" as const,
      }
    : {};
  return db
    .insert(faceitPlayers)
    .values({
      playerId: p.playerId,
      nickname: p.nickname,
      avatarUrl: p.avatarUrl,
      country: p.country,
      game: p.game,
      gamePlayerId: p.gamePlayerId,
      gamePlayerName: p.gamePlayerName,
      skillLevel: p.skillLevel,
      faceitElo: p.faceitElo,
      region: p.region,
      faceitUrl: p.faceitUrl,
      verified: p.verified,
      activatedAt: p.activatedAt,
      ...(search ? { firstSearchedAt: now } : {}),
      ...searchCols,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: faceitPlayers.playerId,
      set: {
        nickname: p.nickname,
        // Don't blank real identity fields with a lightweight seed's nulls.
        ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
        ...(p.country ? { country: p.country } : {}),
        ...(p.gamePlayerId ? { gamePlayerId: p.gamePlayerId } : {}),
        ...(p.gamePlayerName ? { gamePlayerName: p.gamePlayerName } : {}),
        ...(p.skillLevel != null ? { skillLevel: p.skillLevel } : {}),
        ...(p.faceitElo != null ? { faceitElo: p.faceitElo } : {}),
        ...(p.region ? { region: p.region } : {}),
        ...(p.faceitUrl ? { faceitUrl: p.faceitUrl } : {}),
        ...(p.verified != null ? { verified: p.verified } : {}),
        ...(p.activatedAt ? { activatedAt: p.activatedAt } : {}),
        ...searchCols,
        updatedAt: now,
      },
    });
}

function matchSummaryStmt(db: FaceitDb, m: Record<string, unknown>, now: Date) {
  // List-phase columns only; overview/scoreboard columns are left for DETAIL,
  // so an incoming list re-page never clobbers already-collected detail.
  return db
    .insert(faceitMatches)
    .values({ ...(m as typeof faceitMatches.$inferInsert), updatedAt: now })
    .onConflictDoUpdate({
      target: faceitMatches.matchId,
      set: {
        game: m.game as string | null,
        region: m.region as string | null,
        competitionId: m.competitionId as string | null,
        competitionName: m.competitionName as string | null,
        competitionType: m.competitionType as string | null,
        organizerId: m.organizerId as string | null,
        gameMode: m.gameMode as string | null,
        matchType: m.matchType as string | null,
        status: m.status as string,
        winnerFaction: m.winnerFaction as string | null,
        factionsJson: m.factionsJson as string | null,
        startedAt: m.startedAt as Date | null,
        finishedAt: m.finishedAt as Date | null,
        faceitUrl: m.faceitUrl as string | null,
        updatedAt: now,
      },
    });
}

function matchPlayerListStmt(
  db: FaceitDb,
  matchId: string,
  p: ParsedMatchPlayer,
  now: Date,
) {
  return db
    .insert(faceitMatchPlayers)
    .values({
      id: `${matchId}:${p.playerId}`,
      matchId,
      playerId: p.playerId,
      nickname: p.nickname,
      avatarUrl: p.avatarUrl,
      faction: p.faction,
      teamId: p.teamId,
      gamePlayerId: p.gamePlayerId,
      gamePlayerName: p.gamePlayerName,
      gameSkillLevel: p.gameSkillLevel,
      result: p.result,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: faceitMatchPlayers.id,
      set: {
        nickname: p.nickname,
        ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
        faction: p.faction,
        teamId: p.teamId,
        ...(p.gamePlayerId ? { gamePlayerId: p.gamePlayerId } : {}),
        ...(p.gamePlayerName ? { gamePlayerName: p.gamePlayerName } : {}),
        ...(p.gameSkillLevel != null ? { gameSkillLevel: p.gameSkillLevel } : {}),
        result: p.result,
        updatedAt: now,
      },
    });
}

async function historyPage(
  apiKey: string,
  playerId: string,
  game: string,
  offset: number,
  limit: number,
): Promise<HistoryItem[] | null> {
  const res = await fetchJson(
    `${FACEIT_DATA}/players/${playerId}/history?game=${encodeURIComponent(game)}&offset=${offset}&limit=${limit}`,
    apiKey,
  );
  if (!res || res.status !== 200) return null;
  const items = (res.body as { items?: HistoryItem[] })?.items;
  return Array.isArray(items) ? items : [];
}

export type ListChunkResult = {
  pagesFetched: number;
  matchesSeen: number;
  newOffset: number;
  listDone: boolean;
  failed: boolean;
};

/**
 * Advance the LIST backfill by up to `maxPages` history pages from the player's
 * stored offset, writing match summaries + participant rows + seen profiles.
 * Idempotent (all upserts), so an overlapping cron/trigger run is safe.
 */
export async function collectListChunk(
  db: FaceitDb,
  apiKey: string,
  player: { playerId: string; game: string; listOffset: number },
  maxPages: number,
): Promise<ListChunkResult> {
  let offset = player.listOffset;
  let pagesFetched = 0;
  let matchesSeen = 0;
  let listDone = false;

  for (let i = 0; i < maxPages; i++) {
    const items = await historyPage(
      apiKey,
      player.playerId,
      player.game,
      offset,
      FACEIT_HISTORY_PAGE_SIZE,
    );
    if (items === null) {
      // Transient: keep the offset so nothing is skipped; retry next tick.
      return { pagesFetched, matchesSeen, newOffset: offset, listDone: false, failed: true };
    }
    pagesFetched++;
    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stmts: any[] = [];
    const seen = new Map<string, FaceitProfile>();
    for (const item of items) {
      const parsed = parseHistoryItem(item);
      if (!parsed) continue;
      matchesSeen++;
      stmts.push(matchSummaryStmt(db, parsed.match, now));
      for (const pl of parsed.players) {
        stmts.push(matchPlayerListStmt(db, parsed.matchId, pl, now));
      }
      for (const prof of parsed.seenProfiles) {
        if (!seen.has(prof.playerId)) seen.set(prof.playerId, prof);
      }
    }
    // Seed seen profiles (never overwrites a searched row's search state).
    for (const prof of seen.values()) stmts.push(upsertProfileStmt(db, prof));
    if (stmts.length) await runBatched(db, stmts);

    offset += items.length;
    if (items.length < FACEIT_HISTORY_PAGE_SIZE) {
      listDone = true;
      break;
    }
  }

  return { pagesFetched, matchesSeen, newOffset: offset, listDone, failed: false };
}

// ---------------------------------------------------------------------------
// DETAIL phase — /matches/{id} (overview) + /matches/{id}/stats (scoreboard)
// ---------------------------------------------------------------------------

type VotingEntity = {
  guid?: string;
  name?: string;
  game_location_id?: string;
  game_map_id?: string;
  game_heroes_id?: string;
  filters?: { voting_tags?: string[] };
};
type VotingBlock = { entities?: VotingEntity[]; pick?: unknown };
type MatchDetailBody = {
  region?: string;
  competition_id?: string;
  competition_name?: string;
  competition_type?: string;
  organizer_id?: string;
  best_of?: number | string;
  round?: number;
  group?: number;
  status?: string;
  configured_at?: number;
  started_at?: number;
  finished_at?: number;
  demo_url?: string[];
  results?: { winner?: string; score?: Record<string, number> };
  faceit_url?: string;
  voting?: {
    location?: VotingBlock;
    map?: VotingBlock;
    heroes?: VotingBlock;
    attacking_first?: VotingBlock;
  };
  teams?: Record<
    string,
    {
      faction_id?: string;
      name?: string;
      avatar?: string;
      roster?: Array<{
        player_id?: string;
        nickname?: string;
        avatar?: string;
        membership?: string;
        game_player_id?: string;
        game_player_name?: string;
        game_skill_level?: number;
      }>;
    }
  >;
};

function flattenPick(pick: unknown): string[] {
  if (!Array.isArray(pick)) return [];
  const out: string[] = [];
  for (const el of pick) {
    if (Array.isArray(el)) out.push(...el.filter((x): x is string => typeof x === "string"));
    else if (typeof el === "string") out.push(el);
  }
  return out;
}

/** First voting tag matching `cat:` / `tcat:` → the OW2 mode ("Push"). */
function modeFromTags(tags: string[] | undefined): string | null {
  for (const t of tags ?? []) {
    const m = /^(?:t?cat):(.+)$/.exec(t);
    if (m) return m[1];
  }
  return null;
}

export type ParsedDetail = {
  overview: Record<string, unknown>;
  rosterEnrichment: Array<{
    playerId: string;
    membership: string | null;
    gameSkillLevel: number | null;
    gamePlayerName: string | null;
  }>;
};

export function parseMatchDetail(body: unknown): ParsedDetail | null {
  const d = body as MatchDetailBody;
  if (!d || typeof d !== "object") return null;
  const v = d.voting ?? {};

  // Server: location pick → the chosen datacenter's display name.
  const locPick = flattenPick(v.location?.pick)[0] ?? null;
  const locEntity = (v.location?.entities ?? []).find(
    (e) => e.guid === locPick || e.game_location_id === locPick,
  );

  // Map: pick → name + mode.
  const mapPick = flattenPick(v.map?.pick)[0] ?? null;
  const mapEntity = (v.map?.entities ?? []).find(
    (e) => e.guid === mapPick || e.game_map_id === mapPick,
  );

  // Hero bans: the votable pool MINUS the picked (kept) heroes.
  const heroEntities = v.heroes?.entities ?? [];
  const kept = new Set(flattenPick(v.heroes?.pick));
  const heroBans = heroEntities
    .filter((e) => {
      const id = e.guid ?? e.game_heroes_id;
      return id != null && !kept.has(id);
    })
    .map((e) => ({ guid: e.guid ?? e.game_heroes_id ?? null, name: e.name ?? null }));

  const replayCodes = Array.isArray(d.demo_url)
    ? d.demo_url.filter((x): x is string => typeof x === "string")
    : [];

  const winner = asString(d.results?.winner);
  const factionsSummary: Record<string, unknown> = {};
  const rosterEnrichment: ParsedDetail["rosterEnrichment"] = [];
  for (const [key, faction] of Object.entries(d.teams ?? {})) {
    factionsSummary[key] = {
      teamId: asString(faction.faction_id),
      nickname: asString(faction.name),
      avatar: asString(faction.avatar),
      score: asNumber(d.results?.score?.[key]),
    };
    for (const r of faction.roster ?? []) {
      if (!r.player_id) continue;
      rosterEnrichment.push({
        playerId: r.player_id,
        membership: asString(r.membership),
        gameSkillLevel: asNumber(r.game_skill_level),
        gamePlayerName: asString(r.game_player_name),
      });
    }
  }

  return {
    overview: {
      region: asString(d.region),
      competitionId: asString(d.competition_id),
      competitionName: asString(d.competition_name),
      competitionType: asString(d.competition_type),
      organizerId: asString(d.organizer_id),
      bestOf: statInt(d.best_of),
      round: asNumber(d.round),
      groupNum: asNumber(d.group),
      status: normalizeStatus(d.status),
      winnerFaction: winner,
      factionsJson: Object.keys(factionsSummary).length
        ? JSON.stringify(factionsSummary)
        : null,
      locationId: locPick,
      serverName: asString(locEntity?.name),
      mapId: mapPick,
      mapName: asString(mapEntity?.name),
      mapMode: modeFromTags(mapEntity?.filters?.voting_tags),
      heroBansJson: heroBans.length ? JSON.stringify(heroBans) : null,
      replayCodesJson: replayCodes.length ? JSON.stringify(replayCodes) : null,
      attackingFirst: flattenPick(v.attacking_first?.pick)[0] ?? null,
      configuredAt: secondsToDate(d.configured_at),
      startedAt: secondsToDate(d.started_at),
      finishedAt: secondsToDate(d.finished_at),
      faceitUrl: enUrl(d.faceit_url),
    },
    rosterEnrichment,
  };
}

type StatsBody = {
  rounds?: Array<{
    round_stats?: Record<string, string>;
    teams?: Array<{
      team_id?: string;
      team_stats?: Record<string, string>;
      players?: Array<{
        player_id?: string;
        nickname?: string;
        player_stats?: Record<string, string>;
      }>;
    }>;
  }>;
};

export type ParsedScoreboardPlayer = {
  playerId: string;
  nickname: string | null;
  role: string | null;
  eliminations: number | null;
  deaths: number | null;
  assists: number | null;
  kdRatio: number | null;
  damageDealt: number | null;
  healingDone: number | null;
  damageMitigated: number | null;
  finalBlows: number | null;
  soloKills: number | null;
  objectiveTime: number | null;
  timePlayed: number | null;
  statsJson: string;
};

/** Sum a countable stat across a player's per-round stat maps. */
function sumStat(rounds: Array<Record<string, string>>, key: string): number | null {
  let total = 0;
  let any = false;
  for (const r of rounds) {
    const n = statInt(r[key]);
    if (n != null) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

export function parseMatchStats(body: unknown): ParsedScoreboardPlayer[] {
  const s = body as StatsBody;
  const rounds = Array.isArray(s?.rounds) ? s.rounds : [];
  // A player may appear in several rounds (Bo>1). Collect their per-round stat
  // maps, then aggregate countable columns; keep every round in stats_json.
  const byPlayer = new Map<
    string,
    { nickname: string | null; rounds: Array<Record<string, string>> }
  >();
  for (const round of rounds) {
    for (const team of round.teams ?? []) {
      for (const pl of team.players ?? []) {
        if (!pl.player_id) continue;
        const entry = byPlayer.get(pl.player_id) ?? {
          nickname: asString(pl.nickname),
          rounds: [],
        };
        if (pl.player_stats) entry.rounds.push(pl.player_stats);
        byPlayer.set(pl.player_id, entry);
      }
    }
  }

  const out: ParsedScoreboardPlayer[] = [];
  for (const [playerId, entry] of byPlayer) {
    const rs = entry.rounds;
    const single = rs.length === 1 ? rs[0] : null;
    const deaths = sumStat(rs, "Deaths");
    const elims = sumStat(rs, "Eliminations");
    const assists = sumStat(rs, "Assists");
    // Single round: trust the API's K/D Ratio; multi-round: recompute from sums.
    const kdRatio = single
      ? statFloat(single["K/D Ratio"])
      : deaths && deaths > 0 && elims != null
        ? Math.round((elims / deaths) * 100) / 100
        : elims != null
          ? elims
          : null;
    out.push({
      playerId,
      nickname: entry.nickname,
      role: single ? asString(single["Role"]) : asString(rs[0]?.["Role"]),
      eliminations: elims,
      deaths,
      assists,
      kdRatio,
      damageDealt: sumStat(rs, "Damage Dealt"),
      healingDone: sumStat(rs, "Healing Done"),
      damageMitigated: sumStat(rs, "Damage Mitigated"),
      finalBlows: sumStat(rs, "Final Blows"),
      soloKills: sumStat(rs, "Solo Kills"),
      objectiveTime: sumStat(rs, "Objective Time"),
      timePlayed: sumStat(rs, "Time Played"),
      statsJson: JSON.stringify(rs.length === 1 ? rs[0] : rs),
    });
  }
  return out;
}

/** The next matches (newest-first) that this player is in and that still miss
    overview and/or scoreboard detail. */
async function matchesNeedingDetail(
  db: FaceitDb,
  playerId: string,
  limit: number,
): Promise<Array<{ matchId: string; needDetail: boolean; needStats: boolean }>> {
  const rows = await db
    .select({
      matchId: faceitMatches.matchId,
      detailSyncedAt: faceitMatches.detailSyncedAt,
      statsSyncedAt: faceitMatches.statsSyncedAt,
      startedAt: faceitMatches.startedAt,
    })
    .from(faceitMatchPlayers)
    .innerJoin(faceitMatches, eq(faceitMatchPlayers.matchId, faceitMatches.matchId))
    .where(
      and(
        eq(faceitMatchPlayers.playerId, playerId),
        or(isNull(faceitMatches.detailSyncedAt), isNull(faceitMatches.statsSyncedAt)),
      ),
    )
    .orderBy(sql`${faceitMatches.startedAt} DESC`)
    .limit(limit);
  return rows.map((r) => ({
    matchId: r.matchId,
    needDetail: r.detailSyncedAt == null,
    needStats: r.statsSyncedAt == null,
  }));
}

export type DetailChunkResult = { processed: number; failed: number };

/**
 * Fetch + store overview and scoreboard for up to `maxMatches` of this player's
 * matches that still need it, newest-first. Each match's two API calls run in
 * parallel; matches are processed sequentially to stay under the shared Data-API
 * rate limit. A failed match is left for the next tick (its *_synced_at stays
 * null), never marked done.
 */
export async function collectDetailChunk(
  db: FaceitDb,
  apiKey: string,
  playerId: string,
  maxMatches: number,
): Promise<DetailChunkResult> {
  const due = await matchesNeedingDetail(db, playerId, maxMatches);
  let processed = 0;
  let failed = 0;

  for (const { matchId, needDetail, needStats } of due) {
    const [detailRes, statsRes] = await Promise.all([
      needDetail ? fetchJson(`${FACEIT_DATA}/matches/${matchId}`, apiKey) : Promise.resolve(null),
      needStats ? fetchJson(`${FACEIT_DATA}/matches/${matchId}/stats`, apiKey) : Promise.resolve(null),
    ]);
    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stmts: any[] = [];
    let didSomething = false;
    let hadFailure = false;

    // Overview.
    if (needDetail) {
      if (detailRes && detailRes.status === 200) {
        const parsed = parseMatchDetail(detailRes.body);
        if (parsed) {
          stmts.push(
            db
              .update(faceitMatches)
              .set({ ...parsed.overview, detailSyncedAt: now, updatedAt: now })
              .where(eq(faceitMatches.matchId, matchId)),
          );
          for (const r of parsed.rosterEnrichment) {
            stmts.push(
              db
                .update(faceitMatchPlayers)
                .set({
                  ...(r.membership ? { membership: r.membership } : {}),
                  ...(r.gameSkillLevel != null ? { gameSkillLevel: r.gameSkillLevel } : {}),
                  ...(r.gamePlayerName ? { gamePlayerName: r.gamePlayerName } : {}),
                  updatedAt: now,
                })
                .where(eq(faceitMatchPlayers.id, `${matchId}:${r.playerId}`)),
            );
          }
          didSomething = true;
        } else hadFailure = true;
      } else if (detailRes && detailRes.status === 404) {
        // A genuinely gone match: mark detail done so it stops being retried.
        stmts.push(
          db.update(faceitMatches).set({ detailSyncedAt: now, updatedAt: now }).where(eq(faceitMatches.matchId, matchId)),
        );
        didSomething = true;
      } else hadFailure = true;
    }

    // Scoreboard.
    if (needStats) {
      if (statsRes && statsRes.status === 200) {
        const scoreboard = parseMatchStats(statsRes.body);
        for (const sp of scoreboard) {
          stmts.push(
            db
              .update(faceitMatchPlayers)
              .set({
                role: sp.role,
                eliminations: sp.eliminations,
                deaths: sp.deaths,
                assists: sp.assists,
                kdRatio: sp.kdRatio,
                damageDealt: sp.damageDealt,
                healingDone: sp.healingDone,
                damageMitigated: sp.damageMitigated,
                finalBlows: sp.finalBlows,
                soloKills: sp.soloKills,
                objectiveTime: sp.objectiveTime,
                timePlayed: sp.timePlayed,
                statsJson: sp.statsJson,
                ...(sp.nickname ? { nickname: sp.nickname } : {}),
                statsSyncedAt: now,
                updatedAt: now,
              })
              .where(eq(faceitMatchPlayers.id, `${matchId}:${sp.playerId}`)),
          );
        }
        stmts.push(
          db.update(faceitMatches).set({ statsSyncedAt: now, updatedAt: now }).where(eq(faceitMatches.matchId, matchId)),
        );
        didSomething = true;
      } else if (statsRes && statsRes.status === 404) {
        stmts.push(
          db.update(faceitMatches).set({ statsSyncedAt: now, updatedAt: now }).where(eq(faceitMatches.matchId, matchId)),
        );
        didSomething = true;
      } else hadFailure = true;
    }

    if (stmts.length) await runBatched(db, stmts);
    if (hadFailure) failed++;
    if (didSomething && !hadFailure) processed++;
  }

  return { processed, failed };
}

// ---------------------------------------------------------------------------
// Player-level bookkeeping
// ---------------------------------------------------------------------------

/** How many of this player's matches still lack overview/scoreboard detail. */
export async function countUndetailed(db: FaceitDb, playerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(faceitMatchPlayers)
    .innerJoin(faceitMatches, eq(faceitMatchPlayers.matchId, faceitMatches.matchId))
    .where(
      and(
        eq(faceitMatchPlayers.playerId, playerId),
        or(isNull(faceitMatches.detailSyncedAt), isNull(faceitMatches.statsSyncedAt)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** How many matches this player is in total. */
export async function countMatches(db: FaceitDb, playerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(faceitMatchPlayers)
    .where(eq(faceitMatchPlayers.playerId, playerId));
  return Number(row?.n ?? 0);
}

/**
 * Recompute + persist a searched player's collection state after a chunk:
 * match_count, list_offset/list_done, detail_done, and the surfaced status.
 */
export async function finalizePlayerState(
  db: FaceitDb,
  playerId: string,
  patch: { listOffset?: number; listDone?: boolean; failed?: boolean },
): Promise<{ listDone: boolean; detailDone: boolean; matchCount: number }> {
  const matchCount = await countMatches(db, playerId);
  const undetailed = await countUndetailed(db, playerId);
  const detailDone = patch.listDone === true && undetailed === 0;
  const status = patch.failed
    ? "error"
    : patch.listDone && detailDone
      ? "ready"
      : "collecting";
  await db
    .update(faceitPlayers)
    .set({
      matchCount,
      ...(patch.listOffset != null ? { listOffset: patch.listOffset } : {}),
      ...(patch.listDone != null ? { listDone: patch.listDone } : {}),
      detailDone,
      status,
      statusDetail: patch.failed ? "A provider call failed; collection will retry." : null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(faceitPlayers.playerId, playerId));
  return { listDone: patch.listDone ?? false, detailDone, matchCount };
}
