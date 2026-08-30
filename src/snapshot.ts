// Flattens an OverFast summary + stats/summary pair into the ow_snapshots
// column values. This is a MIRROR of the extraction in the Commons
// `lib/ow-stats.ts` (extractSnapshotColumns) — keep the two in sync so both
// writers produce identical rows.

import type {
  OverfastRank,
  OverfastStatsSummary,
  OverfastSummary,
} from "./overfast";

/** Don't re-snapshot a player whose last snapshot is younger than this. Matches
    MIN_SNAPSHOT_INTERVAL_MS in the Commons lib/ow-stats-shared.ts. */
export const MIN_SNAPSHOT_INTERVAL_MS = 20 * 60 * 60 * 1000;

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function intOrNull(x: unknown): number | null {
  const n = num(x);
  return n == null ? null : Math.round(n);
}

function pickPlatform(summary: OverfastSummary | null): "pc" | "console" {
  return summary?.competitive?.pc ? "pc" : summary?.competitive?.console ? "console" : "pc";
}

function rank(r: OverfastRank | null | undefined) {
  return { division: r?.division ?? null, tier: num(r?.tier) };
}

export function extractSnapshotColumns(
  summary: OverfastSummary | null,
  stats: OverfastStatsSummary | null,
) {
  const platform = pickPlatform(summary);
  const comp = summary?.competitive?.[platform] ?? null;
  const general = stats?.general ?? null;
  const total = general?.total ?? {};
  const average = general?.average ?? {};
  const tank = rank(comp?.tank);
  const damage = rank(comp?.damage);
  const support = rank(comp?.support);
  const open = rank(comp?.open);

  return {
    platform,
    endorsementLevel: num(summary?.endorsement?.level),
    title: summary?.title ?? null,
    avatarUrl: summary?.avatar ?? null,
    namecardUrl: summary?.namecard ?? null,
    compSeason: num(comp?.season),
    tankDivision: tank.division,
    tankTier: tank.tier,
    damageDivision: damage.division,
    damageTier: damage.tier,
    supportDivision: support.division,
    supportTier: support.tier,
    openDivision: open.division,
    openTier: open.tier,
    gamesPlayed: intOrNull(general?.games_played),
    gamesWon: intOrNull(general?.games_won),
    gamesLost: intOrNull(general?.games_lost),
    timePlayed: intOrNull(general?.time_played),
    winrate: num(general?.winrate),
    kda: num(general?.kda),
    totalEliminations: intOrNull(total?.eliminations),
    totalAssists: intOrNull(total?.assists),
    totalDeaths: intOrNull(total?.deaths),
    totalDamage: intOrNull(total?.damage),
    totalHealing: intOrNull(total?.healing),
    avgEliminations: num(average?.eliminations),
    avgAssists: num(average?.assists),
    avgDeaths: num(average?.deaths),
    avgDamage: num(average?.damage),
    avgHealing: num(average?.healing),
  };
}
