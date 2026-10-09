# D1 migrations

Drizzle Kit generates reviewed SQL and snapshots here from `src/db/schema.ts`.
`20261008231953_publication_control` creates only minimal Steam Application
publication control; no snapshots, metadata, seeds, or upstream content exist.
SQL and its v1 snapshot are reviewed together before local Alchemy application.

1. Define approved tables, then run `pnpm db:generate --name <description>`.
2. Add copyright and SPDX SQL comment headers before initial application, then
   review and commit the generated directory (`migration.sql` and
   `snapshot.json`); never edit an already-applied migration.
3. Restart `pnpm dev` to let Alchemy apply pending migrations to local D1.
4. Remote migration application happens only with an explicitly approved Alchemy
   deployment, alongside the D1/Worker reconciliation.

Alchemy owns the `__alchemy_migrations` history. Do not also run Drizzle Kit
`push` / `migrate`, Wrangler migrations, or request-time migrators against the
same database. The pinned Drizzle v1 layout is required by Alchemy beta.81; v0
`meta/_journal.json` layouts are not supported.

The first two applied migrations have adjacent `migration.sql.license` SPDX
notices instead of in-file headers. These sidecars supply copyright/license
metadata without changing the SQL bytes or Alchemy's content hashes. Use this
approach for missing notices on historical migrations; new SQL should have
headers before it is first applied.

This directory is public. Do not add real game content, crawl artifacts,
credentials, or account identifiers to migrations or seed files.
