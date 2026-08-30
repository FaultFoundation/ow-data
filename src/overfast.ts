// ⚠️ MIRROR of the Commons `lib/overfast.ts` (a pure module — no imports to
// adjust). Keep the two in sync.
// ---------------------------------------------------------------------------
// OverFast API client — the ONLY module that talks to OverFast
// (https://overfast-api.tekrop.fr), an unofficial Overwatch API that scrapes a
// player's public Blizzard career page by BattleTag.
//
// Deliberately PURE: it takes the base URL as an argument and uses global
// `fetch` only — no `getCloudflareContext`, no `@/` imports — so it can be
// imported unchanged by BOTH the Commons (lib/ow-stats.ts) and the standalone
// ow-data poller Worker (a separate repo, which keeps its own copy). Keep the
// two copies in sync.
//
// Best-effort throughout, mirroring the provider adapters in lib/schedule.ts:
// a timeout, and never throws — every read returns null / 'unknown' on trouble
// so a Statistics render or a cron tick degrades instead of failing.
//
// OverFast caches player CAREER data for ~1 hour (its player *search* cache is
// 10 min — a different thing). So a member who just flipped their profile to
// public may still read back as private until that hour-long cache turns over;
// the Statistics page copy says so.
// ---------------------------------------------------------------------------

export const DEFAULT_OVERFAST_BASE = "https://overfast-api.tekrop.fr";

const TIMEOUT_MS = 6000;

/** BattleTag ("Name#1234") → OverFast player id ("Name-1234"). Case matters. */
export function battletagToPlayerId(battletag: string): string {
  return battletag.trim().replace(/#/g, "-");
}

/** Trim a trailing slash so `${base}/players/...` never doubles up. */
function normalizeBase(base: string | null | undefined): string {
  const b = (base || DEFAULT_OVERFAST_BASE).trim();
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

// --- Response shapes (parsed defensively; every field optional) -------------

/** One role's competitive rank inside a platform block. */
export type OverfastRank = {
  division?: string | null;
  tier?: number | null;
  role_icon?: string | null;
  rank_icon?: string | null;
  tier_icon?: string | null;
};

export type OverfastPlatformComp = {
  season?: number | null;
  tank?: OverfastRank | null;
  damage?: OverfastRank | null;
  support?: OverfastRank | null;
  open?: OverfastRank | null;
};

export type OverfastSummary = {
  username?: string;
  avatar?: string | null;
  namecard?: string | null;
  title?: string | null;
  endorsement?: { level?: number | null; frame?: string | null } | null;
  competitive?: {
    pc?: OverfastPlatformComp | null;
    console?: OverfastPlatformComp | null;
  } | null;
  last_updated_at?: number | null;
};

/** The `general` block (also the shape of each role/hero entry). */
export type OverfastStatBlock = {
  games_played?: number | null;
  games_won?: number | null;
  games_lost?: number | null;
  time_played?: number | null;
  winrate?: number | null;
  kda?: number | null;
  total?: Record<string, number | null> | null;
  average?: Record<string, number | null> | null;
};

export type OverfastStatsSummary = {
  general?: OverfastStatBlock | null;
  roles?: Record<string, OverfastStatBlock> | null;
  heroes?: Record<string, OverfastStatBlock> | null;
};

/** Public/private/unfound state of a career profile, or unknown on any trouble. */
export type OwVisibility = "public" | "private" | "not_found" | "unknown";

async function getJson(url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 is meaningful (unknown player), not an error — return it with a null
    // body so callers can distinguish it from a transient failure.
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  } catch {
    return null;
  }
}

/** GET /players/{id}/summary — profile card + competitive ranks. null on trouble. */
export async function fetchOwSummary(
  base: string | null | undefined,
  playerId: string,
): Promise<OverfastSummary | null> {
  const result = await getJson(
    `${normalizeBase(base)}/players/${encodeURIComponent(playerId)}/summary`,
  );
  if (!result || result.body == null || typeof result.body !== "object") return null;
  return result.body as OverfastSummary;
}

/** GET /players/{id}/stats/summary — aggregated general/roles/heroes stats. */
export async function fetchOwStatsSummary(
  base: string | null | undefined,
  playerId: string,
): Promise<OverfastStatsSummary | null> {
  const result = await getJson(
    `${normalizeBase(base)}/players/${encodeURIComponent(playerId)}/stats/summary`,
  );
  if (!result || result.body == null || typeof result.body !== "object") return null;
  return result.body as OverfastStatsSummary;
}

/**
 * Whether a career profile is publicly readable, via /stats/summary:
 *   - 404              → 'not_found' (bad BattleTag / no such player)
 *   - 200 with general → 'public'
 *   - 200 empty {}     → 'private' (public page hides the stats we scrape)
 *   - anything else    → 'unknown' (timeout / 5xx / rate limit) — never trusted
 *
 * Only a definitive answer flags private, exactly like connectReachability in
 * lib/integrations.ts: an outage must never tell a member their profile is
 * private when it isn't. NOTE: private-profile behaviour is written against the
 * documented/observed shape and wants one live-verify against a genuinely
 * private account — consistent with the repo's other not-yet-live-verified
 * adapters.
 */
export async function checkOwVisibility(
  base: string | null | undefined,
  playerId: string,
): Promise<OwVisibility> {
  const result = await getJson(
    `${normalizeBase(base)}/players/${encodeURIComponent(playerId)}/stats/summary`,
  );
  if (!result) return "unknown";
  if (result.status === 404) return "not_found";
  if (result.status !== 200 || result.body == null || typeof result.body !== "object") {
    return "unknown";
  }
  const body = result.body as OverfastStatsSummary;
  if (body.general && typeof body.general === "object") return "public";
  // A populated roles/heroes map without `general` still means readable data.
  if (
    (body.roles && Object.keys(body.roles).length > 0) ||
    (body.heroes && Object.keys(body.heroes).length > 0)
  ) {
    return "public";
  }
  return "private";
}
