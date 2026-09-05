import { and, eq, inArray } from "drizzle-orm";

import {
  pdMatches,
  pdSync,
  pdTeamLinks,
  pdTeamMembers,
  pdTeams,
} from "./ow-schema";
import {
  PD_ROSTER_TTL_MS,
  type PdProvider,
  type PdSyncStatus,
} from "./player-data-shared";

// ---------------------------------------------------------------------------
// Cross-provider player-data sync — the PURE core. Fetches a member's external
// teams + match history from FACEIT / start.gg / Challonge and applies them to
// the pd_* tables against a passed-in Drizzle D1 handle. Deliberately free of
// getCloudflareContext / React cache / Better Auth so the ow-data Worker can
// keep a COLUMN-COMPATIBLE copy (like overfast.ts) — only the two import paths
// above change on copy. The Commons wrapper is lib/player-data.ts.
//
// Best-effort in the lib/schedule.ts spirit: every provider call has a timeout
// and never throws out of runProviderSync — a failure lands as status 'error'
// with the cursor UNCHANGED, so the backfill resumes where it left off. Only a
// definitive provider answer (a real 404 / null user) may set 'not_found'.
//
// The history backfill is unbounded by design (the member asked for everything)
// but each sync tick does a BOUNDED number of API calls, advancing
// pd_sync.backfill_cursor until the provider is exhausted; after that each tick
// is one cheap incremental page. Matches upsert on (user, provider, match id),
// so backfill/incremental overlap is idempotent.
//
// Live-verified (2026-09): FACEIT /players/{id}/teams + /teams/{id} +
// /history (history factions carry `players`; older docs said `roster` — both
// parsed), start.gg documented player.sets and the UNDOCUMENTED internal
// user→teams read (www.start.gg/api/-/gql, client-version header, no auth —
// same endpoint precedent as cen-scraper's widget layouts; user.teams nodes are
// EventTeams normalized here to their GlobalTeam). Challonge shapes match the
// org-key reads in lib/challonge.ts (same v2.1 API, member token auth).
// ---------------------------------------------------------------------------

const PD_TIMEOUT_MS = 6000;

const FACEIT_DATA = "https://open.faceit.com/data/v4";
const STARTGG_GQL = "https://api.start.gg/gql/alpha";
/** start.gg's internal GraphQL — the only place user→teams exists. */
const STARTGG_INTERNAL_GQL = "https://www.start.gg/api/-/gql";
const STARTGG_CLIENT_VERSION = "20";
const CHALLONGE_V21 = "https://api.challonge.com/v2.1";

// Per-tick call budgets — the "bounded work per tick" half of the unbounded
// backfill. A tick is one page-open sync or one cron visit.
const FACEIT_BACKFILL_PAGES = 4; // × 100 matches
const FACEIT_PAGE_SIZE = 100;
const FACEIT_INCREMENTAL_LIMIT = 20;
const FACEIT_MAX_GAMES = 5;
const FACEIT_ROSTER_FETCH_CAP = 4;
const STARTGG_BACKFILL_PAGES = 4;
const STARTGG_PAGE_SIZE = 20; // keeps the sets query under the complexity cap
const CHALLONGE_TOURNAMENTS_PER_TICK = 2;
const CHALLONGE_LIST_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The pd_sync columns the sync core needs (row shape shared by both writers). */
export type PdSyncRowLike = {
  userId: string;
  provider: string;
  externalId: string;
  handle: string | null;
  meta: string | null;
  backfillCursor: string | null;
  backfillDone: boolean;
};

export type PdTeamRosterEntry = {
  playerExternalId: string | null;
  handle: string | null;
  role: "leader" | "captain" | "member" | null;
  avatarUrl: string | null;
};

export type TeamUpsert = {
  externalTeamId: string;
  name: string;
  game: string | null;
  logoUrl: string | null;
  url: string | null;
  /** null = roster not fetched this tick (existing rows are kept). */
  roster: PdTeamRosterEntry[] | null;
};

export type MatchUpsert = {
  externalMatchId: string;
  game: string | null;
  competitionName: string | null;
  roundText: string | null;
  teamExternalId: string | null;
  teamName: string | null;
  opponentTeamId: string | null;
  opponentName: string | null;
  scoreFor: number | null;
  scoreAgainst: number | null;
  result: "win" | "loss" | "draw" | null;
  status: "scheduled" | "live" | "finished" | "cancelled";
  startedAt: Date | null;
  finishedAt: Date | null;
  url: string | null;
};

export type SyncOutcome = {
  /** null = the teams list was not refreshed this tick (Challonge always;
      others on failure) — existing teams/links are left alone. */
  teams: TeamUpsert[] | null;
  matches: MatchUpsert[];
  cursor: string | null;
  backfillDone: boolean;
  status: PdSyncStatus;
  statusDetail: string | null;
  /** Shallow-merged into pd_sync.meta by applySyncOutcome. */
  metaPatch: Record<string, unknown> | null;
};

export type RunProviderSyncArgs = {
  row: PdSyncRowLike;
  /** Whichever credentials this side has; a missing key skips that provider's
      work rather than erroring (config degradation, not member-visible). */
  faceitApiKey?: string | null;
  startggApiKey?: string | null;
  /** Member OAuth token — only the Commons can mint one, so the cron passes
      nothing and Challonge rows stay page-open-synced. */
  challongeToken?: string | null;
  /** Given candidate team ids, return the subset whose roster is stale/unknown
      (used to budget FACEIT's per-team roster calls; start.gg rosters are free). */
  rosterDue: (teamExternalIds: string[]) => Promise<string[]>;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The public/deterministic pd_teams id. */
export function pdTeamRowId(provider: string, externalTeamId: string): string {
  return `${provider}:${externalTeamId}`;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asString(x: unknown): string | null {
  return typeof x === "string" && x.length ? x : null;
}

function asNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function secondsToDate(x: unknown): Date | null {
  const n = asNumber(x);
  return n && n > 0 ? new Date(n * 1000) : null;
}

function isoToDate(x: unknown): Date | null {
  const s = asString(x);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PD_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, body };
  } catch {
    return null; // timeout / network — the caller treats null as transient
  }
}

const err = (detail: string): SyncOutcome => ({
  teams: null,
  matches: [],
  cursor: null, // applySyncOutcome keeps the stored cursor when null
  backfillDone: false, // ignored unless cursor advances (see apply)
  status: "error",
  statusDetail: detail,
  metaPatch: null,
});

// ---------------------------------------------------------------------------
// FACEIT — server Data API key, keyed by the member's player guid.
// ---------------------------------------------------------------------------

type FaceitCursor = { games: string[]; gi: number; offset: number };

type FaceitHistoryItem = {
  match_id?: string;
  game_id?: string;
  status?: string;
  competition_name?: string;
  started_at?: number;
  finished_at?: number;
  faceit_url?: string;
  teams?: Record<
    string,
    {
      team_id?: string;
      nickname?: string;
      // Live responses carry `players`; some documented examples say `roster`.
      players?: Array<{ player_id?: string }>;
      roster?: Array<{ player_id?: string }>;
    }
  >;
  results?: { winner?: string; score?: Record<string, number> };
};

function faceitMatchStatus(
  status: string | undefined,
): MatchUpsert["status"] {
  switch ((status ?? "").toUpperCase()) {
    case "ONGOING":
      return "live";
    case "CANCELLED":
      return "cancelled";
    case "FINISHED":
      return "finished";
    default:
      return "scheduled";
  }
}

function parseFaceitMatch(
  m: FaceitHistoryItem,
  playerId: string,
  game: string,
): MatchUpsert | null {
  if (!m.match_id) return null;
  const factions = Object.entries(m.teams ?? {});
  const onSide = (f: FaceitHistoryItem["teams"] extends Record<string, infer V> | undefined ? V : never) =>
    [...(f.players ?? []), ...(f.roster ?? [])].some(
      (p) => p.player_id === playerId,
    );
  const mine = factions.find(([, f]) => onSide(f)) ?? null;
  const theirs = factions.find(([key]) => key !== mine?.[0]) ?? null;
  const scoreFor = mine ? asNumber(m.results?.score?.[mine[0]]) : null;
  const scoreAgainst = theirs ? asNumber(m.results?.score?.[theirs[0]]) : null;
  const winner = asString(m.results?.winner);
  const result: MatchUpsert["result"] =
    mine && winner ? (winner === mine[0] ? "win" : "loss") : null;
  return {
    externalMatchId: m.match_id,
    game: m.game_id ?? game,
    competitionName: m.competition_name ?? null,
    roundText: null,
    teamExternalId: mine?.[1].team_id ?? null,
    teamName: mine?.[1].nickname ?? null,
    opponentTeamId: theirs?.[1].team_id ?? null,
    opponentName: theirs?.[1].nickname ?? null,
    scoreFor,
    scoreAgainst,
    result,
    status: faceitMatchStatus(m.status),
    startedAt: secondsToDate(m.started_at),
    finishedAt: secondsToDate(m.finished_at),
    url: m.faceit_url ? m.faceit_url.replace("{lang}", "en") : null,
  };
}

async function faceitHistoryPage(
  apiKey: string,
  playerId: string,
  game: string,
  offset: number,
  limit: number,
): Promise<FaceitHistoryItem[] | null> {
  const res = await fetchJson(
    `${FACEIT_DATA}/players/${playerId}/history?game=${encodeURIComponent(game)}&offset=${offset}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res || res.status !== 200) return null;
  const items = (res.body as { items?: FaceitHistoryItem[] })?.items;
  return Array.isArray(items) ? items : [];
}

async function syncFaceit(
  args: RunProviderSyncArgs,
  apiKey: string,
): Promise<SyncOutcome> {
  const { row } = args;
  const playerId = row.externalId;

  // Player read — validates the account and yields the games list for history.
  const playerRes = await fetchJson(`${FACEIT_DATA}/players/${playerId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!playerRes) return err("FACEIT was unreachable.");
  if (playerRes.status === 404) {
    return { ...err(""), status: "not_found", statusDetail: null };
  }
  if (playerRes.status !== 200) return err(`FACEIT returned ${playerRes.status}.`);
  const player = playerRes.body as {
    nickname?: string;
    games?: Record<string, unknown>;
  };
  const games = Object.keys(player.games ?? {}).slice(0, FACEIT_MAX_GAMES);

  // Teams list (one call) + budgeted roster reads for stale teams.
  let teams: TeamUpsert[] | null = null;
  const teamsRes = await fetchJson(
    `${FACEIT_DATA}/players/${playerId}/teams?offset=0&limit=100`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (teamsRes?.status === 200) {
    const items = (teamsRes.body as {
      items?: Array<{
        team_id?: string;
        name?: string;
        nickname?: string;
        avatar?: string;
        game?: string;
        leader?: string;
        faceit_url?: string;
      }>;
    })?.items;
    const list = (Array.isArray(items) ? items : []).filter((t) => t.team_id);
    const dueIds = (
      await args.rosterDue(list.map((t) => t.team_id as string))
    ).slice(0, FACEIT_ROSTER_FETCH_CAP);
    teams = [];
    for (const t of list) {
      const teamId = t.team_id as string;
      let roster: PdTeamRosterEntry[] | null = null;
      if (dueIds.includes(teamId)) {
        const teamRes = await fetchJson(`${FACEIT_DATA}/teams/${teamId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (teamRes?.status === 200) {
          const detail = teamRes.body as {
            leader?: string;
            members?: Array<{
              user_id?: string;
              nickname?: string;
              avatar?: string;
            }>;
          };
          roster = (detail.members ?? []).map((m) => ({
            playerExternalId: m.user_id ?? null,
            handle: m.nickname ?? null,
            role: m.user_id && m.user_id === detail.leader ? "leader" : "member",
            avatarUrl: m.avatar || null,
          }));
        }
      }
      teams.push({
        externalTeamId: teamId,
        name: t.name ?? t.nickname ?? "FACEIT team",
        game: t.game ?? null,
        logoUrl: t.avatar || null,
        url: t.faceit_url ? t.faceit_url.replace("{lang}", "en") : null,
        roster,
      });
    }
  }

  // Matches: unbounded backfill in bounded pages, then cheap incremental.
  const matches: MatchUpsert[] = [];
  const stored = parseJsonRecord(row.backfillCursor) as Partial<FaceitCursor>;
  let cursor: FaceitCursor = {
    games: Array.isArray(stored.games) && stored.games.length ? stored.games : games,
    gi: asNumber(stored.gi) ?? 0,
    offset: asNumber(stored.offset) ?? 0,
  };
  let backfillDone = row.backfillDone;

  if (!backfillDone) {
    for (let calls = 0; calls < FACEIT_BACKFILL_PAGES; calls++) {
      if (cursor.gi >= cursor.games.length) {
        backfillDone = true;
        break;
      }
      const game = cursor.games[cursor.gi];
      const items = await faceitHistoryPage(
        apiKey,
        playerId,
        game,
        cursor.offset,
        FACEIT_PAGE_SIZE,
      );
      if (items === null) {
        // A failed page is not an exhausted history. Preserve the saved cursor
        // so a transient error cannot permanently discard this game's matches.
        return err("FACEIT history could not be loaded. The import will retry.");
      }
      for (const m of items) {
        const parsed = parseFaceitMatch(m, playerId, game);
        if (parsed) matches.push(parsed);
      }
      cursor =
        items.length < FACEIT_PAGE_SIZE
          ? { ...cursor, gi: cursor.gi + 1, offset: 0 }
          : { ...cursor, offset: cursor.offset + FACEIT_PAGE_SIZE };
    }
    if (cursor.gi >= cursor.games.length) backfillDone = true;
  } else {
    // Incremental: newest page per game picks up anything since last tick.
    for (const game of games) {
      const items = await faceitHistoryPage(
        apiKey,
        playerId,
        game,
        0,
        FACEIT_INCREMENTAL_LIMIT,
      );
      if (items === null) return err("FACEIT history could not be refreshed. The sync will retry.");
      for (const m of items) {
        const parsed = parseFaceitMatch(m, playerId, game);
        if (parsed) matches.push(parsed);
      }
    }
  }

  return {
    teams,
    matches,
    cursor: JSON.stringify(cursor),
    backfillDone,
    status: "ok",
    statusDetail: null,
    metaPatch: { faceitGames: games, handle: player.nickname ?? undefined },
  };
}

// ---------------------------------------------------------------------------
// start.gg — documented gql for sets, internal gql for user→teams.
// ---------------------------------------------------------------------------

type StartggCursor = { page: number };

type StartggSetNode = {
  id?: number | string;
  completedAt?: number | null;
  startedAt?: number | null;
  fullRoundText?: string | null;
  winnerId?: number | null;
  event?: {
    slug?: string | null;
    name?: string | null;
    videogame?: { name?: string | null } | null;
    tournament?: { name?: string | null } | null;
  } | null;
  slots?: Array<{
    entrant?: {
      id?: number | null;
      name?: string | null;
      team?: {
        id?: number | null;
        globalTeam?: { id?: number | null } | null;
      } | null;
      participants?: Array<{ player?: { id?: number | null } | null }> | null;
    } | null;
    standing?: {
      stats?: { score?: { value?: number | null } | null } | null;
    } | null;
  }> | null;
};

const STARTGG_SETS_QUERY = `query($playerId:ID!,$page:Int!,$perPage:Int!){
  player(id:$playerId){
    sets(page:$page,perPage:$perPage){
      pageInfo{totalPages}
      nodes{
        id completedAt startedAt fullRoundText winnerId
        event{slug name videogame{name} tournament{name}}
        slots{
          entrant{
            id name
            team{id ... on EventTeam{globalTeam{id}}}
            participants{player{id}}
          }
          standing{stats{score{value}}}
        }
      }
    }
  }
}`;

function parseStartggSet(
  set: StartggSetNode,
  playerId: number,
): MatchUpsert | null {
  if (set.id == null) return null;
  const slots = set.slots ?? [];
  const mine =
    slots.find((s) =>
      (s.entrant?.participants ?? []).some((p) => p.player?.id === playerId),
    ) ?? null;
  const theirs = slots.find((s) => s !== mine && s.entrant) ?? null;
  const myScore = asNumber(mine?.standing?.stats?.score?.value);
  const theirScore = asNumber(theirs?.standing?.stats?.score?.value);
  const myEntrantId = mine?.entrant?.id ?? null;
  const result: MatchUpsert["result"] =
    mine && set.winnerId != null && myEntrantId != null
      ? set.winnerId === myEntrantId
        ? "win"
        : "loss"
      : null;
  const globalTeamId = mine?.entrant?.team?.globalTeam?.id ?? null;
  const theirGlobalTeamId = theirs?.entrant?.team?.globalTeam?.id ?? null;
  const eventSlug = asString(set.event?.slug);
  const finished = set.completedAt != null || set.winnerId != null;
  return {
    externalMatchId: String(set.id),
    game: set.event?.videogame?.name ?? null,
    competitionName: set.event?.tournament?.name ?? set.event?.name ?? null,
    roundText: set.fullRoundText ?? null,
    teamExternalId: globalTeamId != null ? String(globalTeamId) : null,
    teamName: mine?.entrant?.name ?? null,
    opponentTeamId: theirGlobalTeamId != null ? String(theirGlobalTeamId) : null,
    opponentName: theirs?.entrant?.name ?? null,
    // start.gg reports a DQ/forfeit as -1; that's not a score.
    scoreFor: myScore != null && myScore >= 0 ? myScore : null,
    scoreAgainst: theirScore != null && theirScore >= 0 ? theirScore : null,
    result,
    status: finished ? "finished" : "scheduled",
    startedAt: secondsToDate(set.startedAt) ?? secondsToDate(set.completedAt),
    finishedAt: secondsToDate(set.completedAt),
    // Same deep-link shape cen-scraper builds: {eventSlug}/set/{id}.
    url: eventSlug ? `https://www.start.gg/${eventSlug}/set/${set.id}` : null,
  };
}

async function startggSetsPage(
  apiKey: string,
  playerId: number,
  page: number,
): Promise<{ nodes: StartggSetNode[]; totalPages: number } | null> {
  const res = await fetchJson(STARTGG_GQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: STARTGG_SETS_QUERY,
      variables: { playerId, page, perPage: STARTGG_PAGE_SIZE },
    }),
  });
  if (!res || res.status !== 200) return null;
  const sets = (res.body as {
    data?: {
      player?: {
        sets?: { pageInfo?: { totalPages?: number }; nodes?: StartggSetNode[] };
      } | null;
    };
  })?.data?.player?.sets;
  if (!sets) return null;
  return {
    nodes: Array.isArray(sets.nodes) ? sets.nodes : [],
    totalPages: asNumber(sets.pageInfo?.totalPages) ?? 1,
  };
}

/**
 * The member's teams from the internal endpoint. user.teams nodes are
 * EventTeams (one per event entered); each carries its persistent GlobalTeam,
 * which is what we store — deduped by global id, roster included for free.
 */
async function startggTeams(userId: string): Promise<TeamUpsert[] | null> {
  const res = await fetchJson(STARTGG_INTERNAL_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-version": STARTGG_CLIENT_VERSION,
    },
    body: JSON.stringify({
      query: `query($id:ID!){user(id:$id){teams(query:{perPage:50}){nodes{
        __typename
        ... on EventTeam{globalTeam{...TF}}
        ... on GlobalTeam{...TF}
      }}}}
      fragment TF on GlobalTeam{
        id name url videogame{name} images{url type}
        members(status:ACCEPTED){isCaptain memberType player{id gamerTag}}
      }`,
      variables: { id: userId },
    }),
  });
  if (!res || res.status !== 200) return null;
  type GT = {
    id?: number | null;
    name?: string | null;
    url?: string | null;
    videogame?: { name?: string | null } | null;
    images?: Array<{ url?: string | null; type?: string | null }> | null;
    members?: Array<{
      isCaptain?: boolean | null;
      memberType?: string | null;
      player?: { id?: number | null; gamerTag?: string | null } | null;
    }> | null;
  };
  const nodes = (res.body as {
    data?: {
      user?: { teams?: { nodes?: Array<{ globalTeam?: GT | null } & GT> } } | null;
    };
  })?.data?.user?.teams?.nodes;
  if (!Array.isArray(nodes)) return null;

  const byId = new Map<string, TeamUpsert>();
  for (const node of nodes) {
    const gt: GT | null = node.globalTeam ?? (node.id != null ? node : null);
    if (!gt || gt.id == null) continue;
    const id = String(gt.id);
    if (byId.has(id)) continue;
    const images = gt.images ?? [];
    const logo =
      images.find((i) => i.type === "profile")?.url ?? images[0]?.url ?? null;
    byId.set(id, {
      externalTeamId: id,
      name: gt.name ?? "start.gg team",
      game: gt.videogame?.name ?? null,
      logoUrl: logo,
      url: gt.url ? `https://www.start.gg${gt.url}` : null,
      roster: (gt.members ?? []).map((m) => ({
        playerExternalId: m.player?.id != null ? String(m.player.id) : null,
        handle: m.player?.gamerTag ?? null,
        role: m.isCaptain
          ? "captain"
          : m.memberType && m.memberType !== "PLAYER"
            ? "leader"
            : "member",
        avatarUrl: null,
      })),
    });
  }
  return [...byId.values()];
}

async function syncStartgg(
  args: RunProviderSyncArgs,
  apiKey: string,
): Promise<SyncOutcome> {
  const { row } = args;
  const meta = parseJsonRecord(row.meta);

  // Sets are keyed by PLAYER id; platform_identities stores the USER id. One
  // documented lookup resolves it, then it's cached in pd_sync.meta.
  let playerId = asNumber(meta.startggPlayerId);
  if (playerId == null) {
    const res = await fetchJson(STARTGG_GQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "query($id:ID!){user(id:$id){player{id}}}",
        variables: { id: row.externalId },
      }),
    });
    if (!res) return err("start.gg was unreachable.");
    const user = (res.body as { data?: { user?: { player?: { id?: number } } | null } })
      ?.data?.user;
    if (res.status === 200 && user === null) {
      return { ...err(""), status: "not_found", statusDetail: null };
    }
    playerId = asNumber(user?.player?.id);
    if (playerId == null) return err("start.gg didn't resolve your player id.");
  }

  // Teams (internal endpoint) — best-effort; a miss keeps existing teams.
  const teams = await startggTeams(row.externalId);

  // Matches: walk pages during backfill, else just page 1.
  const matches: MatchUpsert[] = [];
  const stored = parseJsonRecord(row.backfillCursor) as Partial<StartggCursor>;
  let page = Math.max(1, asNumber(stored.page) ?? 1);
  let backfillDone = row.backfillDone;
  let pulledAnything = false;
  let historyFailed = false;

  if (!backfillDone) {
    for (let calls = 0; calls < STARTGG_BACKFILL_PAGES; calls++) {
      const res = await startggSetsPage(apiKey, playerId, page);
      if (!res) { historyFailed = true; break; } // preserve cursor and retry
      pulledAnything = true;
      for (const node of res.nodes) {
        const parsed = parseStartggSet(node, playerId);
        if (parsed) matches.push(parsed);
      }
      if (page >= res.totalPages || res.nodes.length === 0) {
        backfillDone = true;
        break;
      }
      page++;
    }
  } else {
    const res = await startggSetsPage(apiKey, playerId, 1);
    if (!res) historyFailed = true;
    if (res) {
      pulledAnything = true;
      for (const node of res.nodes) {
        const parsed = parseStartggSet(node, playerId);
        if (parsed) matches.push(parsed);
      }
    }
  }

  if (!pulledAnything && teams === null) {
    return err("start.gg was unreachable.");
  }

  return {
    teams,
    matches,
    cursor: JSON.stringify({ page } satisfies StartggCursor),
    backfillDone,
    status: historyFailed ? "error" : "ok",
    statusDetail: historyFailed ? "start.gg match history could not be loaded. The import will retry." : null,
    metaPatch: { startggPlayerId: playerId },
  };
}

// ---------------------------------------------------------------------------
// Challonge — member OAuth token; matches/tournament history only (no
// persistent teams exist there). Commons-side only: the cron has no token path.
// ---------------------------------------------------------------------------

type ChallongeCursor = {
  page: number;
  activeOffset?: number;
  /** tournament id → state at last ingestion; completed tournaments never
      change, so this is what makes incremental re-lists cheap. Bounded by the
      member's own tournament count. */
  seen: Record<string, string>;
};

function challongeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Authorization-Type": "v2",
    // v2.1 (JSON:API) 415s without this, even on a GET (see lib/schedule.ts).
    "Content-Type": "application/vnd.api+json",
    Accept: "application/json",
  };
}

type ChallongeResource = {
  id?: string | number;
  attributes?: Record<string, unknown>;
};

function challongeMatchStatus(state: unknown): MatchUpsert["status"] {
  return asString(state) === "complete" ? "finished" : "scheduled";
}

/** "3-1,2-3,3-0" → summed sets won per side, best-effort. */
function parseScoresCsv(csv: string | null): [number, number] | null {
  if (!csv) return null;
  const single = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(csv);
  if (single) return [Number(single[1]), Number(single[2])];
  let a = 0;
  let b = 0;
  let any = false;
  for (const set of csv.split(",")) {
    const m = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(set);
    if (!m) continue;
    any = true;
    if (Number(m[1]) > Number(m[2])) a++;
    else if (Number(m[2]) > Number(m[1])) b++;
  }
  return any ? [a, b] : null;
}

async function challongeTournamentMatches(
  token: string,
  tournament: { id: string; name: string | null; game: string | null; url: string | null },
  handle: string | null,
): Promise<MatchUpsert[] | null> {
  const [pRes, mRes] = await Promise.all([
    fetchJson(`${CHALLONGE_V21}/tournaments/${tournament.id}/participants.json`, {
      headers: challongeHeaders(token),
    }),
    fetchJson(`${CHALLONGE_V21}/tournaments/${tournament.id}/matches.json`, {
      headers: challongeHeaders(token),
    }),
  ]);
  if (!pRes || pRes.status !== 200 || !mRes || mRes.status !== 200) return null;

  const participants = new Map<
    string,
    { name: string | null; username: string | null }
  >();
  for (const r of ((pRes.body as { data?: ChallongeResource[] })?.data ?? [])) {
    if (r.id == null) continue;
    const a = r.attributes ?? {};
    participants.set(String(r.id), {
      name: asString(a.name),
      username: asString(a.username) ?? asString(a.challonge_username),
    });
  }
  // The member's participant, matched by their Challonge handle when the
  // attribute is present — otherwise sides stay unattributed (result null).
  const my = handle
    ? [...participants.entries()].find(
        ([, p]) => p.username?.toLowerCase() === handle.toLowerCase(),
      )?.[0] ?? null
    : null;

  const out: MatchUpsert[] = [];
  for (const r of ((mRes.body as { data?: ChallongeResource[] })?.data ?? [])) {
    if (r.id == null) continue;
    const a = r.attributes ?? {};
    const p1 = asString(a.player1_id);
    const p2 = asString(a.player2_id);
    const winner = asString(a.winner_id);
    const round = asNumber(a.round);
    const scores = parseScoresCsv(asString(a.scores_csv) ?? asString(a.scores));
    const iAmP1 = my != null && p1 === my;
    const iAmP2 = my != null && p2 === my;
    const known = iAmP1 || iAmP2;
    const meId = iAmP1 ? p1 : iAmP2 ? p2 : null;
    const themId = iAmP1 ? p2 : iAmP2 ? p1 : null;
    // Skip matches the member wasn't in when we know who they are (a
    // tournament they merely organized still lists every match).
    if (my != null && !known) continue;
    const meName = meId ? participants.get(meId)?.name ?? null : p1 ? participants.get(p1)?.name ?? null : null;
    const themName = themId
      ? participants.get(themId)?.name ?? null
      : p2
        ? participants.get(p2)?.name ?? null
        : null;
    const flip = iAmP2;
    out.push({
      externalMatchId: String(r.id),
      game: tournament.game,
      competitionName: tournament.name,
      roundText:
        round == null
          ? null
          : round < 0
            ? `Losers Round ${Math.abs(round)}`
            : `Round ${round}`,
      teamExternalId: null, // no persistent teams on Challonge
      teamName: meName,
      opponentTeamId: null,
      opponentName: themName,
      scoreFor: scores ? (flip ? scores[1] : scores[0]) : null,
      scoreAgainst: scores ? (flip ? scores[0] : scores[1]) : null,
      result:
        known && winner
          ? winner === meId
            ? "win"
            : "loss"
          : null,
      status: challongeMatchStatus(a.state),
      startedAt:
        isoToDate(a.started_at) ??
        isoToDate(a["started-at"]) ??
        isoToDate(a.created_at) ??
        isoToDate(a["created-at"]),
      finishedAt: isoToDate(a.completed_at) ?? isoToDate(a["completed-at"]),
      url: tournament.url,
    });
  }
  return out;
}

async function syncChallonge(
  args: RunProviderSyncArgs,
  token: string,
): Promise<SyncOutcome> {
  const { row } = args;
  const stored = parseJsonRecord(row.backfillCursor) as Partial<ChallongeCursor>;
  const cursor: ChallongeCursor = {
    page: Math.max(1, asNumber(stored.page) ?? 1),
    seen:
      stored.seen && typeof stored.seen === "object"
        ? (stored.seen as Record<string, string>)
        : {},
  };
  let backfillDone = row.backfillDone;

  // List one page of the member's tournaments: page `cursor.page` during
  // backfill, page 1 (most recent) once done.
  const listPage = backfillDone ? 1 : cursor.page;
  const listRes = await fetchJson(
    `${CHALLONGE_V21}/tournaments.json?page=${listPage}&per_page=${CHALLONGE_LIST_PAGE_SIZE}`,
    { headers: challongeHeaders(token) },
  );
  if (!listRes) return err("Challonge was unreachable.");
  if (listRes.status === 401 || listRes.status === 403) {
    return err("Challonge needs re-connecting to read your tournaments.");
  }
  if (listRes.status !== 200) return err(`Challonge returned ${listRes.status}.`);

  const list = (((listRes.body as { data?: ChallongeResource[] })?.data) ?? []).flatMap(
    (t) => {
      if (t.id == null) return [];
      const a = t.attributes ?? {};
      const url =
        asString(a["full-challonge-url"]) ??
        asString(a.full_challonge_url) ??
        (asString(a.url) ? `https://challonge.com/${asString(a.url)}` : null);
      return [
        {
          id: String(t.id),
          state: asString(a.state) ?? "unknown",
          name: asString(a.name),
          game: asString(a.game_name) ?? asString(a["game-name"]),
          url,
        },
      ];
    },
  );

  // Ingest tournaments that are new or whose state moved, a bounded number per
  // tick (each costs a participants + a matches call).
  const eligible = list.filter(t => cursor.seen[t.id] !== t.state || (backfillDone && !["complete", "completed", "cancelled"].includes(t.state)));
  const offset = backfillDone && eligible.length ? Math.max(0, asNumber(stored.activeOffset) ?? 0) % eligible.length : 0;
  const due = [...eligible.slice(offset), ...eligible.slice(0, offset)].slice(0, CHALLONGE_TOURNAMENTS_PER_TICK);
  let historyFailed = false;
  const matches: MatchUpsert[] = [];
  const seen = { ...cursor.seen };
  for (const t of due) {
    const pulled = await challongeTournamentMatches(token, t, row.handle);
    if (pulled === null) { historyFailed = true; continue; } // retry next tick
    matches.push(...pulled);
    seen[t.id] = t.state;
  }

  // Advance the backfill page only once everything on it has been ingested.
  let page = cursor.page;
  if (!backfillDone) {
    const pageFullySeen = list.every((t) => seen[t.id] === t.state);
    if (pageFullySeen) {
      if (list.length < CHALLONGE_LIST_PAGE_SIZE) backfillDone = true;
      else page++;
    }
  }

  return {
    teams: null, // Challonge contributes matches only
    matches,
    cursor: JSON.stringify({ page, seen, activeOffset: offset + due.length } satisfies ChallongeCursor),
    backfillDone,
    status: historyFailed ? "error" : "ok",
    statusDetail: historyFailed ? "Some Challonge results could not be loaded. The sync will retry." : null,
    metaPatch: null,
  };
}

// ---------------------------------------------------------------------------
// Entry + apply
// ---------------------------------------------------------------------------

/**
 * Run one provider's sync tick for one member. Never throws; a missing
 * credential returns null (nothing to do, not an error — config degradation).
 */
export async function runProviderSync(
  args: RunProviderSyncArgs,
): Promise<SyncOutcome | null> {
  try {
    const provider = args.row.provider as PdProvider;
    if (provider === "faceit") {
      return args.faceitApiKey ? await syncFaceit(args, args.faceitApiKey) : null;
    }
    if (provider === "startgg") {
      return args.startggApiKey
        ? await syncStartgg(args, args.startggApiKey)
        : null;
    }
    if (provider === "challonge") {
      return args.challongeToken
        ? await syncChallonge(args, args.challongeToken)
        : null;
    }
    return null;
  } catch (error) {
    console.error(`player-data sync failed for ${args.row.provider}:`, error);
    return err("Sync failed unexpectedly.");
  }
}

/** Minimal structural type both writers' Drizzle handles satisfy (the Commons
    builds its client with the full schema, the poller without one). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdDb = Pick<
  import("drizzle-orm/d1").DrizzleD1Database<any>,
  "insert" | "update" | "delete" | "select" | "batch"
>;

/**
 * Which of these external teams' rosters are due a rewrite: unknown teams, and
 * known ones whose roster is older than PD_ROSTER_TTL_MS. Both writers pass
 * this as runProviderSync's rosterDue.
 */
export async function staleRosterTeamIds(
  db: PdDb,
  provider: string,
  externalTeamIds: string[],
): Promise<string[]> {
  if (!externalTeamIds.length) return [];
  const rows = await db
    .select({
      externalTeamId: pdTeams.externalTeamId,
      rosterRefreshedAt: pdTeams.rosterRefreshedAt,
    })
    .from(pdTeams)
    .where(
      and(
        eq(pdTeams.provider, provider),
        inArray(pdTeams.externalTeamId, externalTeamIds),
      ),
    );
  const fresh = new Set(
    rows
      .filter(
        (r) =>
          r.rosterRefreshedAt &&
          Date.now() - r.rosterRefreshedAt.getTime() < PD_ROSTER_TTL_MS,
      )
      .map((r) => r.externalTeamId),
  );
  return externalTeamIds.filter((id) => !fresh.has(id));
}

/** Chunk size for match upsert batches (bounded statements per D1 batch). */
const MATCH_BATCH = 40;

/**
 * Land a sync outcome in D1. Matches first (idempotent upserts, chunked), then
 * teams + links + the pd_sync bookkeeping in one final batch — so a failure
 * mid-matches leaves the cursor unadvanced and the next tick re-pulls.
 *
 * lastSyncedAt is bumped even on an 'error' outcome (the markSynced rule: an
 * unreachable provider defers by a TTL instead of retrying every render), but
 * the cursor/backfill state only advances on success.
 */
export async function applySyncOutcome(
  db: PdDb,
  row: PdSyncRowLike,
  outcome: SyncOutcome,
): Promise<void> {
  const now = new Date();
  const provider = row.provider;

  // 1) Matches, in bounded chunks.
  for (let i = 0; i < outcome.matches.length; i += MATCH_BATCH) {
    const chunk = outcome.matches.slice(i, i + MATCH_BATCH);
    const stmts = chunk.map((m) =>
      db
        .insert(pdMatches)
        .values({
          id: crypto.randomUUID(),
          userId: row.userId,
          provider,
          externalMatchId: m.externalMatchId,
          game: m.game,
          competitionName: m.competitionName,
          roundText: m.roundText,
          teamExternalId: m.teamExternalId,
          teamName: m.teamName,
          opponentTeamId: m.opponentTeamId,
          opponentName: m.opponentName,
          scoreFor: m.scoreFor,
          scoreAgainst: m.scoreAgainst,
          result: m.result,
          status: m.status,
          startedAt: m.startedAt,
          finishedAt: m.finishedAt,
          url: m.url,
        })
        .onConflictDoUpdate({
          target: [pdMatches.userId, pdMatches.provider, pdMatches.externalMatchId],
          set: {
            game: m.game,
            competitionName: m.competitionName,
            roundText: m.roundText,
            teamExternalId: m.teamExternalId,
            teamName: m.teamName,
            opponentTeamId: m.opponentTeamId,
            opponentName: m.opponentName,
            scoreFor: m.scoreFor,
            scoreAgainst: m.scoreAgainst,
            result: m.result,
            status: m.status,
            startedAt: m.startedAt,
            finishedAt: m.finishedAt,
            url: m.url,
            updatedAt: now,
          },
        }),
    );
    const [first, ...rest] = stmts;
    await db.batch([first, ...rest]);
  }

  // 2) Teams + links + bookkeeping, atomically.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmts: any[] = [];

  if (outcome.teams) {
    for (const t of outcome.teams) {
      const teamRowId = pdTeamRowId(provider, t.externalTeamId);
      stmts.push(
        db
          .insert(pdTeams)
          .values({
            id: teamRowId,
            provider,
            externalTeamId: t.externalTeamId,
            name: t.name,
            game: t.game,
            logoUrl: t.logoUrl,
            url: t.url,
            rosterRefreshedAt: t.roster ? now : null,
          })
          .onConflictDoUpdate({
            target: pdTeams.id,
            set: {
              name: t.name,
              game: t.game,
              logoUrl: t.logoUrl,
              url: t.url,
              updatedAt: now,
              ...(t.roster ? { rosterRefreshedAt: now } : {}),
            },
          }),
      );
      if (t.roster) {
        stmts.push(db.delete(pdTeamMembers).where(eq(pdTeamMembers.teamId, teamRowId)));
        for (const m of t.roster) {
          stmts.push(
            db.insert(pdTeamMembers).values({
              id: crypto.randomUUID(),
              teamId: teamRowId,
              playerExternalId: m.playerExternalId,
              handle: m.handle,
              role: m.role,
              avatarUrl: m.avatarUrl,
            }),
          );
        }
      }
    }
    // Rewrite this member's link set for the provider.
    stmts.push(
      db
        .delete(pdTeamLinks)
        .where(
          and(eq(pdTeamLinks.userId, row.userId), eq(pdTeamLinks.provider, provider)),
        ),
    );
    for (const t of outcome.teams) {
      const teamRowId = pdTeamRowId(provider, t.externalTeamId);
      stmts.push(
        db.insert(pdTeamLinks).values({
          id: `${row.userId}:${teamRowId}`,
          userId: row.userId,
          teamId: teamRowId,
          provider,
        }),
      );
    }
  }

  const succeeded = outcome.status === "ok";
  const mergedMeta = outcome.metaPatch
    ? JSON.stringify({ ...parseJsonRecord(row.meta), ...outcome.metaPatch })
    : row.meta;
  stmts.push(
    db
      .update(pdSync)
      .set({
        lastSyncedAt: now,
        status: outcome.status,
        statusDetail: outcome.statusDetail,
        updatedAt: now,
        ...(succeeded && outcome.cursor != null
          ? { backfillCursor: outcome.cursor, backfillDone: outcome.backfillDone }
          : {}),
        ...(mergedMeta !== row.meta ? { meta: mergedMeta } : {}),
      })
      .where(
        and(eq(pdSync.userId, row.userId), eq(pdSync.provider, provider)),
      ),
  );

  const [first, ...rest] = stmts;
  await db.batch([first, ...rest]);
}
