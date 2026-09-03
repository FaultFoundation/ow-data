# ow-data

A tiny standalone Cloudflare Worker (deploys as **`ow-data`**) that keeps **The
Commons'** player-data store (the `ow-player-data` D1) filled on an hourly cron:

1. A **daily Overwatch career snapshot per player** (`ow_snapshots`), so members
   build up history even when they don't open the Statistics tab.
2. The **cross-provider player-data sync** (`pd_*` tables): each linked member's
   external **FACEIT / start.gg teams and full match history**, which the
   Commons shows on the Teams tab and the Statistics → Match Data tab.
   **Challonge rows are skipped here** — they read through the member's OAuth
   token, which only the Commons (Better Auth) can mint, so those sync on page
   open alone.

It is the scheduled half of those features — the same relationship `cen-scraper`
has to the Commons' Tournaments tab. **The Commons owns the database schema and
migrations**; this Worker only reads/writes rows.

## What it does

- Binds the `ow-player-data` D1 database as **`OW`** (the same database the
  Commons binds under the same name).
- On an **hourly UTC cron** (`0 * * * *`), it processes every player whose
  `poll_chunk` matches the current UTC hour (players are spread across
  24 buckets by the Commons), plus a catch-up sweep for anyone missed for a day.
- For each due player it calls the [OverFast API](https://overfast-api.tekrop.fr)
  (`/players/{id}/summary` + `/players/{id}/stats/summary`) and appends one row
  to `ow_snapshots`.
- Snapshots are **append-only** and guarded so a player is never snapshotted more
  than once per ~20 h — which is what makes it safe for both this Worker and the
  Commons (which snapshots on Battle.net connect and lazily on page reads) to
  write the same table.
- For each due `pd_sync` row (FACEIT / start.gg) it advances that member's
  unbounded **match-history backfill** by a bounded number of API pages, then
  keeps them current with cheap incremental pulls; team lists and (budgeted)
  rosters refresh on the same tick. Writes are idempotent upserts guarded by the
  same TTL the Commons' page-open sync uses, so the two writers never duplicate
  work.

## The mirror contract

`src/ow-schema.ts` and `src/overfast.ts` are **copies** of the Commons'
`db/ow-schema.ts` and `lib/overfast.ts`, `src/snapshot.ts` mirrors the
column extraction in the Commons' `lib/ow-stats.ts`, and
`src/player-data-shared.ts` + `src/player-data-sync.ts` are copies of the
Commons' `lib/player-data-shared.ts` + `lib/player-data-sync.ts` (only the two
import paths at the top of the sync core differ). Keep them
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
# → {"chunk":7,"processed":N,"snapshotted":N,"errors":0,"playerData":{"processed":N,"synced":N,"errors":0}}
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
wrangler secret put FACEIT_API_KEY    # for the pd sync; same value as the Commons'
wrangler secret put STARTGG_API_KEY   # ″
npm run deploy
```

The `ow-player-data` database and its schema must already exist — the Commons
creates/migrates it (`npm run db:ow:migrate:remote` in the Commons repo). This
Worker only needs the `OW` binding in `wrangler.jsonc` to point at the same
`database_id`.
