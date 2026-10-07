# Drizzle and D1

## Implemented foundation

- `alchemy.run.ts` declares a D1 database and binds it to the Worker as `DB`.
  Alchemy owns the database identity, local emulation, binding, and migration
  application. No remote database has been provisioned.
- `src/env.ts` infers the Worker binding types from Alchemy using **type-only**
  imports. Infrastructure values never enter the Worker bundle.
- `src/db/database.ts` exposes an Effect `Database` service using Drizzle's
  native `effect-d1` driver and `@effect/sql-d1`. Queries are Effects, not
  promises wrapped in application-specific adapters.
- `src/db/schema.ts` is deliberately empty until the game model and ingestion
  contract are approved. Synthetic test tables live only under `tests/fixtures`.
  There are no new public API routes, storage readiness checks, or game records.

ORM and Kit are both pinned to **`1.0.0-rc.5-ab785fc`**, the exact optional-peer
version expected by Alchemy **`2.0.0-beta.81`**. The D1 SQL client is pinned to
**`4.0.1`**, matching Effect. Do not use v0 examples or Effect 3 integration
packages with this setup. In particular, Alchemy requires the Drizzle v1
migration directory format, not `meta/_journal.json`.

## Query boundary

Repositories/services consume `Database`; Hono supplies the binding at the
request boundary. For example, this program performs a query without depending
on an application table:

```ts
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { Database } from './db/database';

const program = Effect.gen(function* () {
  const db = yield* Database;
  return yield* db.get<{ value: number }>(sql`select 1 as value`);
});

// Inside a future Hono handler (not an implemented public endpoint):
const result = await Effect.runPromise(
  program.pipe(Effect.provide(Database.layer(c.env.DB))),
);
```

Provide a layer per request/execution rather than capturing the first request's
binding in a global singleton. Layer provisioning scopes the D1 client and its
prepared-statement cache. Table queries follow the same pattern:
`yield* db.select().from(table).where(eq(table.id, id))`. Use Drizzle
parameters, not string concatenation or `sql.raw` with untrusted input.

The driver reports SQL failures through `EffectDrizzleQueryError`; service code
should map expected failures deliberately. Do not serialize SQL, parameters, or
underlying errors into HTTP responses. The existing Hono error boundary returns
a generic JSON 500. D1 transactions and streaming queries are not supported by
this client; do not assume SQLite's transaction API is available. Assess D1's
atomic batch capabilities when adding multi-statement operations.

`/health` still reports process health only and never queries D1.

## Migration ownership

`drizzle.config.ts` is generation-only: SQLite dialect, application schema path,
and output directory, with no credentials or remote HTTP driver. Alchemy reads
that same output directory for D1's `migrations` setting.

```sh
# After defining approved tables:
pnpm db:generate --name <description>
pnpm db:check
# Review generated SQL and snapshots, then restart local dev:
pnpm dev
```

Commit the generated `drizzle/<timestamp>_<name>/migration.sql` and
`snapshot.json` together. Never rewrite a migration that has already been
applied. Alchemy applies pending SQL to local D1 on dev reconciliation and owns
history in `__alchemy_migrations`. Schema edits alone do not change a database:
generate/review migrations and restart dev to apply them.

Remote application occurs only during an explicitly approved Alchemy deployment,
which can create a billable D1 database as well as the public Worker. There is
no standalone remote-migrate script or automatic deployment. Do not run Drizzle
Kit `push`/`migrate`, Wrangler migrations, or request-time migrators beside
Alchemy for the same database.

`local-dev` and `local-preview` are separate stacks/stages with separate local
D1 data. Preview uses the built Worker, but inherits the same D1/migration
configuration. Stop dev before preview because they share the HTTP port. Local
D1 data and state live in ignored `.alchemy/`; they are not production data or
backups. Do not add credentials, upstream game content, or private crawl data to
schemas, migrations, seeds, or fixtures.

## Validation

- `pnpm test`: Node unit tests cover lazy layer construction, parameterized SQL,
  and typed error handling with a deliberately failing D1 stub. They do **not**
  validate Cloudflare bindings.
- `pnpm test:integration`: generates a migration from a synthetic table and
  launches an Alchemy fixture stack in real local workerd. It checks migration
  application, Drizzle insert/select/update/delete, parameter handling, and the
  SQL failure channel. A restart against the same isolated database checks that
  migrations are not replayed. All state, SQL, storage, logs, and a blank home
  directory live in a temporary directory and are removed after the test.
- CI runs both suites, migration checks, and the offline Worker build without
  Cloudflare credentials. The integration fixture rejects non-dev execution; it
  is not a deployment target.
