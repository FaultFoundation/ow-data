import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { faceitPlayers, faceitMatches, faceitScoutTeams, faceitScoutTeamMatches } from "./faceit-schema";
import { fetchJson, resolveFaceitPlayer, upsertProfileStmt, collectListChunk, collectDetailChunk, finalizePlayerState, parseHistoryItem, matchSummaryStmt, matchPlayerListStmt } from "./faceit-collect";

// Team membership is never inferred from the roster's individual match lists.
// This is the feed used by FACEIT's team Stats page (getMatchHistoryTeamStats).
const DATA = "https://open.faceit.com/data/v4";
const PAGE_SIZE = 20;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;
export type TeamMember = { playerId: string; nickname: string };
export type TeamProfile = { teamId: string; name: string; nickname: string; avatarUrl: string | null; members: TeamMember[] };

export function parseTeamProfile(body: unknown): TeamProfile | null {
  const t = body as { team_id?: string; game?: string; name?: string; nickname?: string; avatar?: string; members?: { user_id?: string; nickname?: string }[] } | null;
  if (!t?.team_id || t.game !== "ow2" || !t.name || !Array.isArray(t.members)) return null;
  return { teamId: t.team_id, name: t.name, nickname: t.nickname || t.name, avatarUrl: t.avatar || null,
    members: [...new Map(t.members.filter(m => m.user_id && m.nickname).map(m => [m.user_id!, { playerId: m.user_id!, nickname: m.nickname! }])).values()] };
}

export function teamSearchParts(raw: string) {
  const value = raw.trim();
  const id = value.match(/^(?:https:\/\/(?:www\.)?faceit\.com\/[a-z-]+\/teams\/)?([a-f0-9-]{36})(?:\/.*)?$/i)?.[1];
  const parts = value.match(/^(.*?)\s*\(([^()]*)\)$/);
  return { id, name: (parts?.[1] ?? value).trim(), tag: parts?.[2]?.trim() };
}

export async function resolveFaceitTeam(apiKey: string, raw: string): Promise<TeamProfile | "not_found" | null> {
  const query = teamSearchParts(raw);
  const detail = async (id: string) => {
    const res = await fetchJson(`${DATA}/teams/${encodeURIComponent(id)}`, apiKey);
    if (res?.status === 404) return "not_found" as const;
    return res?.status === 200 ? parseTeamProfile(res.body) : null;
  };
  if (query.id) return detail(query.id);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const candidates: TeamProfile[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await fetchJson(`${DATA}/search/teams?${new URLSearchParams({ nickname: query.name, game: "ow2", offset: String(offset), limit: "100" })}`, apiKey);
    const items = (res?.body as { items?: { team_id: string; name: string }[] })?.items;
    if (res?.status !== 200 || !Array.isArray(items)) return null;
    for (const item of items.filter(t => same(t.name, query.name))) {
      const team = await detail(item.team_id);
      if (!team) return null;
      if (team !== "not_found" && (!query.tag || same(team.nickname, query.tag))) candidates.push(team);
    }
    if (items.length < 100) break;
  }
  // Never silently scout the first fuzzy/ambiguous search result.
  return candidates.length === 1 ? candidates[0] : "not_found";
}

export function parseTeamHistory(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null;
  const ids: string[] = [];
  for (const row of body) {
    const id = row?.matchId ?? row?.match_id;
    if (typeof id !== "string" || !id) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

export async function registerTeam(db: Db, team: TeamProfile, mode: "quick" | "deep") {
  const values = { teamId: team.teamId, name: team.name, nickname: team.nickname, avatarUrl: team.avatarUrl,
    rosterJson: JSON.stringify(team.members), searchMode: mode, updatedAt: new Date() };
  // Refresh page zero for new matches; inserts are idempotent and cached details survive.
  await db.insert(faceitScoutTeams).values(values).onConflictDoUpdate({ target: faceitScoutTeams.teamId,
    set: { ...values, listPage: 0, listDone: false } });
}

export async function advanceTeam(db: Db, apiKey: string, teamId: string, mode: "quick" | "deep") {
  const [team] = await db.select().from(faceitScoutTeams).where(eq(faceitScoutTeams.teamId, teamId));
  if (!team) return "not_found";
  const stopAt = Date.now() + 18_000;
  const members = JSON.parse(team.rosterJson) as TeamMember[];
  const links = await db.select().from(faceitScoutTeamMatches).where(eq(faceitScoutTeamMatches.teamId, teamId));
  if (!team.listDone && (mode === "deep" || team.listPage === 0 || links.length < 50)) {
    const res = await fetchJson(`https://api.faceit.com/stats/v1/stats/time/teams/${encodeURIComponent(teamId)}/games/ow2?page=${team.listPage}&size=${PAGE_SIZE}`, "");
    const ids = res?.status === 200 ? parseTeamHistory(res.body) : null;
    if (!ids) return "error";
    for (const matchId of ids) {
      if (links.some(link => link.matchId === matchId)) continue;
      if (Date.now() >= stopAt) return "collecting";
      // Seed the normal match and participant rows from the match itself, not a player's history.
      const res = await fetchJson(`${DATA}/matches/${encodeURIComponent(matchId)}`, apiKey);
      if (res?.status !== 200) return "error";
      // The Data API's match and history endpoints name faction fields differently.
      const body = res.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const teams = Object.fromEntries(Object.entries(body.teams ?? {}).map(([f, raw]) => {
        const t = raw as { faction_id?: string; name?: string; roster?: NonNullable<NonNullable<Parameters<typeof parseHistoryItem>[0]["teams"]>[string]["players"]> };
        return [f, { ...t, team_id: t.faction_id, nickname: t.name, players: t.roster }];
      }));
      const parsed = parseHistoryItem({ ...body, match_id: matchId, teams });
      if (!parsed || !parsed.players.some(player => player.teamId === teamId)) return "error";
      const now = new Date();
      await db.batch([matchSummaryStmt(db, parsed.match, now),
        ...parsed.players.map(p => matchPlayerListStmt(db, matchId, p, now)),
        ...parsed.seenProfiles.map(p => upsertProfileStmt(db, p)),
        db.insert(faceitScoutTeamMatches).values({ id: `${teamId}:${matchId}`, teamId, matchId }).onConflictDoNothing()]);
    }
    await db.update(faceitScoutTeams).set({ listPage: team.listPage + 1, listDone: (res!.body as unknown[]).length < PAGE_SIZE, searchMode: mode, updatedAt: new Date() }).where(eq(faceitScoutTeams.teamId, teamId));
  }
  const all = await db.select({ matchId: faceitMatches.matchId }).from(faceitScoutTeamMatches)
    .innerJoin(faceitMatches, eq(faceitScoutTeamMatches.matchId, faceitMatches.matchId))
    .where(eq(faceitScoutTeamMatches.teamId, teamId)).orderBy(sql`${faceitMatches.startedAt} desc`);
  const matchIds = (mode === "quick" ? all.slice(0, 50) : all).map(r => r.matchId);
  if (matchIds.length) {
    // Bound the SQL parameter list even for very large team histories.
    const due = await db.select({ matchId: faceitMatches.matchId }).from(faceitScoutTeamMatches)
      .innerJoin(faceitMatches, eq(faceitScoutTeamMatches.matchId, faceitMatches.matchId))
      .where(and(eq(faceitScoutTeamMatches.teamId, teamId), or(isNull(faceitMatches.detailSyncedAt), isNull(faceitMatches.statsSyncedAt), isNull(faceitMatches.roundsSyncedAt), isNull(faceitMatches.votingSyncedAt))))
      .orderBy(sql`${faceitMatches.startedAt} desc`).limit(12);
    const ids = due.map(r => r.matchId).filter(id => mode === "deep" || matchIds.includes(id));
    if (ids.length) {
      const result = await collectDetailChunk(db, apiKey, "", 12, stopAt, ids);
      if (result.failed) return "error";
    }
  }
  // One unfinished roster member per request keeps the same bounded collection
  // engine and avoids multiplying the request deadline by the roster size.
  for (const member of members) {
    if (Date.now() >= stopAt) break;
    let [row] = await db.select().from(faceitPlayers).where(eq(faceitPlayers.playerId, member.playerId));
    if (!row?.searchMode || row.searchMode !== mode) {
      const profile = await resolveFaceitPlayer(apiKey, { playerId: member.playerId });
      if (!profile || profile === "not_found") return "error";
      await db.batch([upsertProfileStmt(db, profile, { mode, now: new Date() })]);
      [row] = await db.select().from(faceitPlayers).where(eq(faceitPlayers.playerId, member.playerId));
    }
    if (row.listDone && row.detailDone) continue;
    if (mode === "quick") {
      const recent = await db.all<{ complete: number }>(sql`select count(*) as complete from (select m.stats_synced_at from faceit_matches m join faceit_match_players p on p.match_id=m.match_id where p.player_id=${member.playerId} order by m.started_at desc limit 48) where stats_synced_at is not null`);
      if (row.status !== "error" && Number(recent[0]?.complete) >= 48) continue;
    }
    const list = !row.listDone && (mode === "deep" || row.listOffset === 0)
      ? await collectListChunk(db, apiKey, row, 1)
      : { newOffset: row.listOffset, listDone: row.listDone, failed: false };
    const detail = await collectDetailChunk(db, apiKey, member.playerId, 12, stopAt);
    await finalizePlayerState(db, member.playerId, { listOffset: list.newOffset, listDone: list.listDone, failed: list.failed || detail.failed > 0 });
    if (list.failed || detail.failed) return "error";
    break;
  }
  return "collecting";
}
