import { defineConfig } from "drizzle-kit";

// This repo owns the migrations for the `faceit_*` tables ONLY (the FACEIT match
// search cache). Everything else in the ow-player-data D1 — ow_* and pd_* — is
// owned by the Commons, so this config deliberately scopes `schema` to
// faceit-schema.ts alone. Generate SQL with `npm run db:faceit:generate`, apply
// it with `wrangler d1 migrations apply` (see the db:faceit:migrate:* scripts),
// which tracks applied migrations in a SEPARATE table (migrations_table in
// wrangler.jsonc) so the two owners never collide. Use `generate` + `apply`
// only — never `drizzle-kit push` against this shared DB (it would drop the
// Commons' tables).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/faceit-schema.ts",
  out: "./drizzle-faceit",
});
