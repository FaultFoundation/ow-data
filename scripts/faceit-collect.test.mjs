import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// The FACEIT payload parsers, against the shapes that made the collected data
// disagree with a player's own FACEIT profile:
//
//   * An Overwatch match is a Bo3/Bo5 SERIES. `voting.map.pick` is the planned
//     pool (up to five) while `rounds[]` is what was actually played, so the
//     maps a player played are rounds — reading pick[0] gave one map per match,
//     nearly always the Control map that opens the OW competitive format.
//   * The history listing's `results` describes the FIRST MAP, not the series:
//     a match won 3–2 is listed as `winner: <map-1 winner>, score 1–2`. Only
//     `/matches/{id}` reports the series, so DETAIL re-derives every
//     participant's result from it.
//
// Production TS is transpiled and run here so the parsers are exercised as
// shipped (this repo has no build step of its own).

const require = createRequire(import.meta.url);
const src = resolve(import.meta.dirname, '..', 'src');

function load(file, globals = {}) {
  const path = file.endsWith('.ts') ? file : `${file}.ts`;
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (id) => (id.startsWith('.') ? load(resolve(dirname(path), id), globals) : require(id)),
    Date, console, ...globals,
  }, { filename: path });
  return exports;
}
const { parseMatchDetail, parseMatchStats } = load(resolve(src, 'faceit-collect.ts'));

const US = 'faction-us';
const THEM = 'faction-them';
const MAPS = {
  '0xCF2': ['Antarctica', 'Control'],
  '0x827': ['Circuit Royal', 'Escort'],
  '0xE13': ['New Junk City', 'Flashpoint'],
  '0xEB2': ['Runasapi', 'Push'],
  '0x0D4': ["King's Row", 'Hybrid'],
};

/** A Bo5 that ended 3–2: five maps vetoed, five played, map 1 lost. */
const detailBody = {
  best_of: 5,
  status: 'FINISHED',
  results: { winner: 'faction1', score: { faction1: 3, faction2: 2 } },
  voting: {
    map: {
      pick: [['0xCF2', '0x827', '0xE13', '0xEB2', '0x0D4']],
      entities: Object.entries(MAPS).map(([guid, [name, mode]]) => ({
        guid,
        name,
        // One entity ships no filters at all — some organizers' vetos don't,
        // which is where the match-level map_mode used to come back null.
        ...(name === 'Antarctica' ? {} : { filters: { voting_tags: [`cat:${mode}`] } }),
      })),
    },
  },
  teams: {
    faction1: { faction_id: US, name: 'Us', roster: [{ player_id: 'p1', nickname: 'Scouted' }] },
    faction2: { faction_id: THEM, name: 'Them', roster: [{ player_id: 'p2', nickname: 'Rival' }] },
  },
};

const statsBody = {
  rounds: Object.entries(MAPS).map(([guid, [, mode]], i) => ({
    round_stats: {
      Map: guid,
      'OW2 Mode': mode,
      Winner: i === 0 || i === 3 ? THEM : US,
      'Score Summary': '2 / 1',
    },
    teams: [
      { team_id: US, players: [{ player_id: 'p1', nickname: 'Scouted', player_stats: { Eliminations: '20', Deaths: '5', Role: 'Tank' } }] },
      { team_id: THEM, players: [{ player_id: 'p2', nickname: 'Rival', player_stats: { Eliminations: '18', Deaths: '7' } }] },
    ],
  })),
};

test('a series yields one round per map actually played, named and moded', () => {
  const detail = parseMatchDetail(detailBody);
  const { rounds } = parseMatchStats(statsBody, detail.mapNames);

  assert.deepEqual(rounds.map((r) => r.mapName), [
    'Antarctica', 'Circuit Royal', 'New Junk City', 'Runasapi', "King's Row",
  ]);
  assert.deepEqual(rounds.map((r) => r.roundIndex), [1, 2, 3, 4, 5]);
  // The mode comes off the round itself, so an untagged veto entity (Antarctica
  // here) no longer leaves a map without one — that null used to split a single
  // map into two rows in the win-rate chart.
  assert.deepEqual(rounds.map((r) => r.mapMode), [
    'Control', 'Escort', 'Flashpoint', 'Push', 'Hybrid',
  ]);
  assert.deepEqual(rounds.map((r) => r.winnerTeamId), [THEM, US, US, THEM, US]);
});

test('the series result is re-derived from the match, not the first map', () => {
  const detail = parseMatchDetail(detailBody);
  const byPlayer = Object.fromEntries(
    detail.rosterEnrichment.map((r) => [r.playerId, r.result]),
  );
  // Map 1 went to the opponent; the series did not.
  assert.equal(parseMatchStats(statsBody, detail.mapNames).rounds[0].winnerTeamId, THEM);
  assert.equal(byPlayer.p1, 'win');
  assert.equal(byPlayer.p2, 'loss');
});

test('a round whose map guid has no veto entity keeps the id, not a guess', () => {
  const { rounds } = parseMatchStats(
    { rounds: [{ round_stats: { Map: '0xUNKNOWN', Winner: US } }] },
    {},
  );
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].mapId, '0xUNKNOWN');
  assert.equal(rounds[0].mapName, null);
});

test('a finished match with no winner is a draw, and a match with no stats has no rounds', () => {
  const drawn = parseMatchDetail({ ...detailBody, results: {} });
  assert.deepEqual([...new Set(drawn.rosterEnrichment.map((r) => r.result))], ['draw']);
  assert.equal(parseMatchStats({}, {}).rounds.length, 0);
});

test('per-player scoreboard scalars still aggregate across the series', () => {
  const { players } = parseMatchStats(statsBody, {});
  const me = players.find((p) => p.playerId === 'p1');
  assert.equal(me.eliminations, 100); // 20 across five rounds
  assert.equal(me.deaths, 25);
  assert.equal(me.kdRatio, 4);
  assert.equal(me.role, 'Tank');
});

const { parseVoting } = load(resolve(src, 'faceit-voting.ts'));
test('voting keeps bans per game and matches attribution without ticket position', () => {
  const entity = (guid) => ({ guid, name: guid });
  const match = { payload: { id: 'm', teams: { faction1: { name: 'A' }, faction2: { name: 'B' } }, voting: {
    map: { entities: [entity('map1'), entity('map2')], pick: ['map1', 'map2'] },
    heroes: { entities: [entity('Ana'), entity('Mauga'), entity('Mei')], pick: [['Mei'], ['Ana']] },
  } } };
  const history = { payload: { match_id: 'm', tickets: [
    { entity_type: 'heroes', entities: [{ guid: 'Mauga', status: 'drop', selected_by: 'faction2' }, { guid: 'Mei', status: 'drop', selected_by: 'faction1' }] },
    { entity_type: 'map', entities: [{ guid: 'map1', status: 'pick', selected_by: 'faction1' }, { guid: 'map2', status: 'drop', selected_by: '' }] },
    { entity_type: 'heroes', entities: [{ guid: 'Ana', status: 'drop', selected_by: 'faction1' }, { guid: 'Mauga', status: 'drop', selected_by: 'faction2' }] },
  ] } };
  const v = parseVoting(match, history);
  assert.equal(v.games[0].heroBans.length, 2);
  assert.equal(v.games[1].heroBans.length, 2);
  assert.equal(v.games[0].heroBans[0].by, 'faction1');
  assert.equal(v.games[0].pickedBy, 'faction1');
  assert.equal(v.games[0].mapBans.length, 0);
  assert.equal(v.games[1].pickedBy, null);
  assert.equal(parseVoting(match, null).games[0].heroBans[0].by, null);
  assert.equal(parseVoting(match, { payload: { match_id: 'wrong', tickets: [] } }), null);
  history.payload.tickets.push(history.payload.tickets[2]);
  assert.equal(parseVoting(match, history).games[0].heroBans[0].by, null);
});


test('detail deadline preserves completed work and resumes remaining matches', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(resolve(src, '../drizzle-faceit')).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(resolve(src, '../drizzle-faceit', file), 'utf8'));
  }
  const client = { prepare(sql) { return { bind(...params) { return {
    async raw() { const stmt = sqlite.prepare(sql); stmt.setReturnArrays(true); return stmt.all(...params); },
    async all() { return { results: sqlite.prepare(sql).all(...params), meta: {} }; },
    async run() { return { meta: sqlite.prepare(sql).run(...params) }; },
  }; } }; }, async batch(statements) { return Promise.all(statements.map(s => s.all())); } };
  for (const id of ['m1', 'm2']) {
    sqlite.prepare('INSERT INTO faceit_matches (match_id,created_at,updated_at) VALUES (?,0,0)').run(id);
    sqlite.prepare('INSERT INTO faceit_match_players (id,match_id,player_id,created_at,updated_at) VALUES (?,?,?,0,0)').run(id+':p1',id,'p1');
  }
  let now = 0;
  let requests = 0;
  class Clock extends Date { static now() { return now; } }
  const { collectDetailChunk, countUndetailed } = load(resolve(src, 'faceit-collect.ts'), {
    Date: Clock, AbortSignal,
    fetch: async () => { requests++; now += 6000; return { status: 404, json: async () => null }; },
  });
  const db = drizzle(client);
  try {
    await collectDetailChunk(db, 'test-key', 'p1', 24, 10_000);
    assert.equal(requests, 4, 'finish one match, do not start the next after deadline');
    assert.equal(await countUndetailed(db, 'p1'), 1);
    await collectDetailChunk(db, 'test-key', 'p1', 24, now + 10_000);
    assert.equal(requests, 8);
    assert.equal(await countUndetailed(db, 'p1'), 0);
  } finally { sqlite.close(); }
});

test('finished matches without a veto complete, while unavailable or malformed voting retries', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(resolve(src, '../drizzle-faceit')).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(resolve(src, '../drizzle-faceit', file), 'utf8'));
  }
  const client = { prepare(sql) { return { bind(...params) { return {
    async raw() { const stmt = sqlite.prepare(sql); stmt.setReturnArrays(true); return stmt.all(...params); },
    async all() { return { results: sqlite.prepare(sql).all(...params), meta: {} }; },
  }; } }; }, async batch(statements) { return Promise.all(statements.map(s => s.all())); } };
  const scenarios = [
    { id: 'no-veto', payload: { id: 'no-veto', status: 'FINISHED' }, historyStatus: 404, complete: true },
    { id: 'null-veto', payload: { id: 'null-veto', status: 'FINISHED', voting: null }, historyStatus: 404, complete: true },
    { id: 'outage', payload: { id: 'outage', status: 'FINISHED' }, historyStatus: 503, complete: false },
    { id: 'rate-limit', payload: { id: 'rate-limit', status: 'FINISHED' }, historyStatus: 429, complete: false },
    { id: 'active', payload: { id: 'active', status: 'ONGOING' }, historyStatus: 404, complete: false },
    { id: 'malformed', payload: {}, historyStatus: 404, complete: false },
    { id: 'wrong-id', payload: { id: 'another-match', status: 'FINISHED' }, historyStatus: 404, complete: false },
  ];
  const db = drizzle(client);
  try {
    for (const scenario of scenarios) {
      sqlite.prepare('INSERT INTO faceit_matches (match_id,detail_synced_at,stats_synced_at,rounds_synced_at,created_at,updated_at) VALUES (?,1,1,1,0,0)').run(scenario.id);
      sqlite.prepare('INSERT INTO faceit_match_players (id,match_id,player_id,created_at,updated_at) VALUES (?,?,?,0,0)').run(scenario.id+':p',scenario.id,scenario.id);
      let requests = 0;
      const { collectDetailChunk, countUndetailed } = load(resolve(src, 'faceit-collect.ts'), {
        AbortSignal, fetch: async url => {
          requests++;
          return url.includes('/history')
            ? { status: scenario.historyStatus, json: async () => null }
            : { status: 200, json: async () => ({ payload: scenario.payload }) };
        },
      });
      await collectDetailChunk(db, 'test-key', scenario.id, 24);
      assert.equal(await countUndetailed(db, scenario.id), scenario.complete ? 0 : 1, scenario.id);
      const row = sqlite.prepare('SELECT voting_json, voting_synced_at FROM faceit_matches WHERE match_id = ?').get(scenario.id);
      assert.equal(row.voting_json, null, 'never fabricate voting data');
      assert.equal(row.voting_synced_at !== null, scenario.complete, scenario.id);
      await collectDetailChunk(db, 'test-key', scenario.id, 24);
      assert.equal(requests, scenario.complete ? 2 : 4, scenario.id);
    }
  } finally { sqlite.close(); }
});

test('team lookup resolves exact name(tag), deduplicates roster, and rejects fuzzy names', async () => {
  const calls = [];
  const team = { team_id: 'df36dcb1-6397-4f2d-8fca-562bad8f307f', game:'ow2', name:'LGBTQI-AIM', nickname:'AIM', members:[{ user_id:'p1', nickname:'AliveFPS' }, { user_id:'p1', nickname:'AliveFPS' }] };
  const { resolveFaceitTeam, teamSearchParts, parseTeamProfile } = load(resolve(src,'faceit-team-collect.ts'), {
    URLSearchParams, AbortSignal,
    fetch: async url => { calls.push(url); return { status:200, json: async () => url.includes('/search/teams') ? { items:[{ team_id:team.team_id, name:team.name }, { team_id:'unrelated', name:'Rizz Aim' }] } : team }; },
  });
  const result = await resolveFaceitTeam('test-key','LGBTQI-AIM(AIM)');
  assert.equal(result.teamId,team.team_id);
  assert.equal(result.members.length,1);
  assert.ok(calls[0].includes('nickname=LGBTQI-AIM'));
  assert.equal(await resolveFaceitTeam('test-key','LGBTQI-AIM(wrong)'), 'not_found');
  assert.equal(await resolveFaceitTeam('test-key','fuzzy'), 'not_found');
  assert.equal(teamSearchParts(`https://www.faceit.com/en/teams/${team.team_id}/stats`).id,team.team_id);
  assert.equal(parseTeamProfile({...team,game:'cs2'}),null);
});

test('team map-history entries deduplicate to series and malformed history never means complete', () => {
  const { parseTeamHistory } = load(resolve(src,'faceit-team-collect.ts'));
  assert.deepEqual(Array.from(parseTeamHistory([{matchId:'series1'},{matchId:'series1'},{matchId:'series2'}])), ['series1','series2']);
  assert.equal(parseTeamHistory({error:'blocked'}),null);
  assert.equal(parseTeamHistory([{unexpected:'shape'}]),null);
  assert.equal(parseTeamHistory([]).length,0);
});

test('roster history cannot overwrite a collected team series with its first-map result', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(resolve(src, '../drizzle-faceit')).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(src, '../drizzle-faceit', file), 'utf8'));
  const client = { prepare(sql) { return { bind(...params) { return { async all() { return { results:sqlite.prepare(sql).all(...params),meta:{} }; } }; } }; }, async batch(statements) { return Promise.all(statements.map(s=>s.all())); } };
  try {
    const db = drizzle(client);
    const { matchSummaryStmt, matchPlayerListStmt } = load(resolve(src,'faceit-collect.ts'));
    sqlite.exec(`INSERT INTO faceit_matches (match_id,status,winner_faction,factions_json,detail_synced_at,created_at,updated_at) VALUES ('series','finished','faction1','{"faction1":{"score":3},"faction2":{"score":2}}',1,0,0);
      INSERT INTO faceit_match_players (id,match_id,player_id,faction,team_id,result,created_at,updated_at) VALUES ('series:p1','series','p1','faction1','team1','win',0,0)`);
    await db.batch([matchSummaryStmt(db, { matchId:'series',status:'finished',winnerFaction:'faction2',factionsJson:'{"faction1":{"score":1}}' },new Date()),
      matchPlayerListStmt(db,'series',{ playerId:'p1',faction:'faction1',teamId:'team1',nickname:'p1',result:'loss' },new Date())]);
    assert.equal(sqlite.prepare('SELECT winner_faction FROM faceit_matches').get().winner_faction,'faction1');
    assert.equal(JSON.parse(sqlite.prepare('SELECT factions_json FROM faceit_matches').get().factions_json).faction1.score,3);
    assert.equal(sqlite.prepare('SELECT result FROM faceit_match_players').get().result,'win');
  } finally { sqlite.close(); }
});

test('team collection pages its own feed and collects roster histories separately with shared details', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(resolve(src, '../drizzle-faceit')).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(src, '../drizzle-faceit', file), 'utf8'));
  const client = { prepare(sql) { return { bind(...params) { return {
    async raw() { const stmt=sqlite.prepare(sql);stmt.setReturnArrays(true);return stmt.all(...params); },
    async all() { return { results:sqlite.prepare(sql).all(...params),meta:{} }; },
    async run() { return {meta:sqlite.prepare(sql).run(...params)}; },
  }; } }; }, async batch(statements) { return Promise.all(statements.map(s=>s.all())); } };
  const calls=[];
  let unavailable=false;
  const { registerTeam, advanceTeam } = load(resolve(src,'faceit-team-collect.ts'), { URLSearchParams,AbortSignal,
    fetch: async url => {
      calls.push(url);
      let status=200,body;
      if(url.includes('/time/teams/')) { status=unavailable?403:200; body=unavailable?{error:'blocked'}:[{matchId:'team-match'},{matchId:'team-match'}]; }
      else if(url.includes('/players/p1/history')) body={items:[{match_id:'solo-match',game_id:'ow2',game_mode:'5v5',status:'FINISHED',teams:{faction1:{team_id:'other-team',players:[{player_id:'p1',nickname:'Player'}]}}}]};
      else if(url.endsWith('/players/p1')) body={player_id:'p1',nickname:'Player',games:{ow2:{game_player_name:'Player#1234'}}};
      else if(url.endsWith('/matches/team-match')) body={match_id:'team-match',game:'ow2',game_mode:'5v5',status:'FINISHED',teams:{faction1:{faction_id:'team',name:'Team',roster:[{player_id:'p1',nickname:'Player'}]}}};
      else { status=404;body=null; }
      return {status,json:async()=>body};
    },
  });
  const db=drizzle(client);
  try {
    await registerTeam(db,{teamId:'team',name:'Team',nickname:'T',avatarUrl:null,members:[{playerId:'p1',nickname:'Player'}]},'deep');
    await advanceTeam(db,'test-key','team','deep');
    assert.deepEqual(sqlite.prepare('SELECT match_id FROM faceit_scout_team_matches').all().map(r=>r.match_id),['team-match']);
    assert.deepEqual(sqlite.prepare("SELECT match_id FROM faceit_match_players WHERE player_id='p1' ORDER BY match_id").all().map(r=>r.match_id),['solo-match','team-match']);
    assert.equal(sqlite.prepare('SELECT list_done FROM faceit_scout_teams').get().list_done,1);
    assert.equal(sqlite.prepare('SELECT list_done,detail_done FROM faceit_players WHERE player_id=?').get('p1').detail_done,1);
    assert.ok(calls.some(url=>url.includes('/time/teams/team/')));
    assert.ok(calls.some(url=>url.includes('/players/p1/history')));
    // Provider failure must leave the team cursor unchanged, never mark it complete.
    await registerTeam(db,{teamId:'team',name:'Team',nickname:'T',avatarUrl:null,members:[]},'deep');
    unavailable=true;
    assert.equal(await advanceTeam(db,'test-key','team','deep'),'error');
    const state=sqlite.prepare('SELECT list_done,list_page FROM faceit_scout_teams').get();
    assert.equal(state.list_done,0);assert.equal(state.list_page,0);
  } finally {sqlite.close();}
});
