// ---------------------------------------------------------------------------
// Cross-provider player data (external teams + match history) — the client-safe
// half. Provider ids, labels, the row shapes the UI renders, and the cache/TTL
// constants both writers share. No server-only imports (db, cloudflare context,
// provider fetches): the sync core is lib/player-data-sync.ts and the D1
// read/write layer is lib/player-data.ts. Follows the *-shared.ts convention.
// ---------------------------------------------------------------------------

/**
 * The providers that feed external teams / match history. Challonge contributes
 * MATCHES only — it has no persistent team concept (a "team" there exists per
 * tournament entry), so synthesizing team cards from it would only make noisy
 * duplicates.
 */
export const PD_PROVIDERS = ["faceit", "startgg", "challonge"] as const;
export type PdProvider = (typeof PD_PROVIDERS)[number];

export const PD_PROVIDER_LABELS: Record<PdProvider, string> = {
  faceit: "FACEIT",
  startgg: "start.gg",
  challonge: "Challonge",
};

/** Providers that surface persistent teams (see PD_PROVIDERS note). */
export const PD_TEAM_PROVIDERS: readonly PdProvider[] = ["faceit", "startgg"];

/**
 * Sync outcome per provider, shown to the member on the Match Data tab so an
 * inaccessible account is an explained state, not silently-missing data.
 * Only a definitive provider answer may set private/not_found (the
 * connectReachability rule); an outage stays 'error'.
 */
export type PdSyncStatus = "ok" | "private" | "not_found" | "error";

export const PD_STATUS_MESSAGES: Record<
  Exclude<PdSyncStatus, "ok">,
  string
> = {
  private:
    "This account's data isn't publicly readable — set the profile to public on the provider to sync it.",
  not_found: "We couldn't find this account on the provider anymore.",
  error: "We couldn't reach this provider just now — this is usually temporary.",
};

/** How long a page-open sync considers the last sync fresh. */
export const PD_SYNC_TTL_MS = 60 * 60 * 1000;
/** Floor under the refresh icon's force, so a click storm can't hammer APIs. */
export const PD_FORCE_FLOOR_MS = 2 * 60 * 1000;
/** Roster rewrites are budgeted; a roster older than this is due a refresh. */
export const PD_ROSTER_TTL_MS = 24 * 60 * 60 * 1000;

/** An external team as the Teams tab renders it, inline with MyTeam cards. */
export type ExternalTeamSummary = {
  /** pd_teams.id — `${provider}:${externalTeamId}`; percent-encoded into the
      /teams/<id>/ route, which branches on the ':' (like tournaments). */
  id: string;
  provider: PdProvider;
  name: string;
  game: string | null;
  logoUrl: string | null;
  /** Out-link to the provider's team page. */
  url: string | null;
  memberCount: number;
};

/** One roster row on the external team detail view. */
export type ExternalTeamMember = {
  handle: string | null;
  role: "leader" | "captain" | "member" | null;
  avatarUrl: string | null;
};

/** One match row (Match Data tab and the team detail's match list). */
export type ExternalMatchRow = {
  matchKey?: string;
  reportedTime?: { revision: number; scheduledAt: number; sourceUrl: string; conflictsWithProvider: boolean };
  id: string;
  provider: PdProvider;
  game: string | null;
  competitionName: string | null;
  roundText: string | null;
  teamName: string | null;
  opponentName: string | null;
  scoreFor: number | null;
  scoreAgainst: number | null;
  result: "win" | "loss" | "draw" | null;
  status: "scheduled" | "live" | "finished" | "cancelled";
  /** Epoch ms (client-serializable), or null when the provider gave no time. */
  startedAt: number | null;
  url: string | null;
};

/** Per-provider sync state the Match Data tab's status strip renders. */
export type PdProviderState = {
  provider: PdProvider;
  status: PdSyncStatus | null;
  statusDetail: string | null;
  lastSyncedAt: number | null;
  backfillDone: boolean;
};

/** GET /api/statistics/matches response. */
export type MatchDataResponse = {
  providers: PdProviderState[];
  matches: ExternalMatchRow[];
};
