import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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

function load(file) {
  const path = file.endsWith('.ts') ? file : `${file}.ts`;
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (id) => (id.startsWith('.') ? load(resolve(dirname(path), id)) : require(id)),
    Date, console,
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
