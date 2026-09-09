/** Match configuration is a base pool, not a claim of turn-by-turn eligibility. */
type Entity = { guid: string; name?: string; filters?: { voting_tags?: string[] }; status?: string; selected_by?: string; random?: boolean };
type Ticket = { entity_type: string; entities: Entity[] };
export function parseVoting(matchBody: unknown, historyBody: unknown) {
  const m = (matchBody as { payload?: any })?.payload;
  const h = (historyBody as { payload?: any })?.payload;
  if (!m?.id || !m.voting || (h && (h.match_id !== m.id || !Array.isArray(h.tickets)))) return null;
  const tickets: Ticket[] = h?.tickets ?? [];
  const teams = Object.fromEntries(Object.entries(m.teams ?? {}).map(([key, value]: [string, any]) => [key, { id: value.id, name: value.name }]));
  const actor = (e?: Entity) => e?.selected_by && teams[e.selected_by] ? e.selected_by : null;
  const maps: Entity[] = m.voting.map?.entities ?? [];
  const heroes: Entity[] = m.voting.heroes?.entities ?? [];
  const picks: string[] = m.voting.map?.pick ?? [];
  const survivorLists = m.voting.heroes?.pick ?? [];
  const games = picks.map((mapId, i) => {
    const matchingMaps = tickets.filter(t => t.entity_type === 'map' && t.entities.some(e => e.guid === mapId && e.status === 'pick'));
    const mt = matchingMaps.length === 1 ? matchingMaps[0] : undefined;
    // Preserve each game's survivor list; flattening them erases repeated availability.
    const survivors = Array.isArray(survivorLists[i]) ? survivorLists[i] : picks.length === 1 && survivorLists.every((x: unknown) => typeof x === 'string') ? survivorLists : null;
    const banned = survivors ? heroes.filter(e => !survivors.includes(e.guid)) : [];
    const matches = tickets.filter(t => t.entity_type === 'heroes' && t.entities.filter(e => e.status === 'drop').length === banned.length && banned.every(e => t.entities.some(x => x.guid === e.guid && x.status === 'drop')));
    const ht = matches.length === 1 ? matches[0] : undefined;
    return {
      game: i + 1, mapId, mapName: maps.find(e => e.guid === mapId)?.name ?? mapId,
      pickedBy: actor(mt?.entities.find(e => e.guid === mapId && e.status === 'pick')),
      mapBans: (mt?.entities ?? []).filter(e => e.status === 'drop' && actor(e)).map(e => ({ id: e.guid, name: maps.find(x => x.guid === e.guid)?.name ?? e.guid, by: actor(e), random: e.random ?? false })),
      heroBans: banned.map(e => { const event = ht?.entities.find(x => x.guid === e.guid && x.status === 'drop'); return { id: e.guid, name: e.name ?? e.guid, by: actor(event), random: event?.random ?? false }; }),
    };
  });
  const catalog = (items: Entity[]) => items.map(e => ({ id: e.guid, name: e.name, tags: e.filters?.voting_tags ?? [] }));
  const configuration = Object.fromEntries(['map', 'heroes'].map(type => [type, (m.matchCustom?.tree?.[type]?.values?.voting_per_round ?? []).map((r: any) => ({ game: r.match_round, pool: (r.value ?? []).map((e: Entity) => e.guid), steps: r.voting_steps, order: r.voting_order, firstVoter: r.first_voter, restrictions: r.restrictions ?? [], modeTagPattern: r.pre_voting_by_tag_regexp }))]));
  return { version: 1, historyAvailable: !!h, teams, games, maps: catalog(maps), heroes: catalog(heroes), configuration };
}
