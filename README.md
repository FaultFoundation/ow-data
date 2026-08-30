# ow-data

A tiny standalone Cloudflare Worker (deploys as **`ow-data`**) that keeps **The
Commons'** Overwatch
player-statistics store filling with a **daily career snapshot per player**, so
members build up history even when they don't open the Statistics tab.

It is the scheduled half of that feature — the same relationship `cen-scraper`
has to the Commons' Tournaments tab. **The Commons owns the database schema and
migrations**; this Worker only reads/writes rows.

## What it does

- Binds the `ow-player-data` D1 database as **`OW`** (the same database the
  Commons binds under the same name).
- On an **hourly UTC cron** (`0 * * * *`), it snapshots every player whose
  `ow_players.poll_chunk` matches the current UTC hour (players are spread across
  24 buckets by the Commons), plus a catch-up sweep for anyone missed for a day.
- For each due player it calls the [OverFast API](https://overfast-api.tekrop.fr)
  (`/players/{id}/summary` + `/players/{id}/stats/summary`) and appends one row
  to `ow_snapshots`.
- Snapshots are **append-only** and guarded so a player is never snapshotted more
  than once per ~20 h — which is what makes it safe for both this Worker and the
  Commons (which snapshots on Battle.net connect and lazily on page reads) to
  write the same table.

## The mirror contract

`src/ow-schema.ts` and `src/overfast.ts` are **copies** of the Commons'
`db/ow-schema.ts` and `lib/overfast.ts`, and `src/snapshot.ts` mirrors the
column extraction in the Commons' `lib/ow-stats.ts`. Keep them
**column-compatible**: if a column is added/renamed in the Commons schema, mirror
it here (and generate the migration on the Commons side — never here).

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # set OW_POLLER_SECRET
npm run typecheck
npm run dev                      # wrangler dev on :8787
```

Cron can't be fired on demand, so exercise the run logic through the
secret-gated manual trigger:

```sh
# Poll the bucket for a specific UTC hour (0–23); omit ?chunk to use the current hour.
curl -X POST -H "authorization: Bearer $OW_POLLER_SECRET" \
  "http://localhost:8787/run?chunk=7"
# → {"chunk":7,"processed":N,"snapshotted":N,"errors":0}
```

Seed a test player (the Commons normally writes these on Battle.net connect):

```sh
wrangler d1 execute ow-player-data --local --command \
  "INSERT INTO ow_players (user_id, battletag, player_id, platform, poll_chunk, created_at, updated_at) \
   VALUES ('test-user','TeKrop#2217','TeKrop-2217','pc',7,unixepoch()*1000,unixepoch()*1000)"
```

## Deploy

```sh
wrangler secret put OW_POLLER_SECRET
npm run deploy
```

The `ow-player-data` database and its schema must already exist — the Commons
creates/migrates it (`npm run db:ow:migrate:remote` in the Commons repo). This
Worker only needs the `OW` binding in `wrangler.jsonc` to point at the same
`database_id`.
