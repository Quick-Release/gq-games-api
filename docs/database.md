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
- `src/db/schema.ts` declares only `steam_application_publication`: App ID,
  eligible/withdrawn state, opaque generation, and integer Unix-second issuance
  time. Checks enforce the App ID range, two stored states, nonempty generation,
  and nonnegative integer timestamp. Uninitialized control is absence. No
  snapshots, source content, reasons, or delivery history are retained.
- `src/services/catalog.ts` supplies the cohesive Effect `Catalog` service for
  authorization acquisition and publication inspection. Hono supplies Catalog
  and Database layers per request. Only those two private catalog operations
  exist; health remains process-only.

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

// Inside a Hono handler with the request's binding:
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
underlying errors into HTTP responses. The Hono error boundary returns a generic
JSON 500 and never logs raw exceptions. Catalog SQL failures become a safe
`SERVICE_UNAVAILABLE` code, without driver details. D1 transactions and
streaming queries are not supported by this client; do not assume SQLite's
transaction API is available. Assess D1's atomic batch capabilities when adding
multi-statement operations.

### Atomic authorization acquisition

The native `db.$client.batch` operation contains a parameterized
`INSERT ... ON CONFLICT (steam_app_id) DO NOTHING` followed by a primary SELECT
that captures both control fields and the authorized/withdrawn outcome using SQL
CASE. D1 executes the statements in order as one transaction. Only after batch
success does Catalog decode the captured result and return or emit the captured
withdrawal failure; it never performs an independent post-commit read to
classify the response. Conflicts perform no update, so ordinary acquisition
cannot advance a generation or lift withdrawal. A database failure denies
success, and a later failed statement rolls back initialization.

Inspection uses one parameterized read and returns stored fields or the
uninitialized/null representation; it never generates a token. Generation
issuance uses server cryptographic randomness and the Effect clock. A generation
is a fence, not a credential, expiry, or proof of collection order.

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
history in `__alchemy_migrations`. That durable D1 history is independent of the
ephemeral Worker state used for secret-bearing local dev/preview. The local
state adapter persists only credential-free D1 resource state, including its
local identity; reconstructing Worker declarations after restart neither loses
D1 storage nor replays SQL. Schema edits alone do not change a database:
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
- `pnpm test:integration`: retains the synthetic generated-table CRUD fixture
  and adds a Catalog service fixture using the reviewed application migration.
  Real local workerd exercises absent/existing/withdrawn control, concurrent
  acquisition, committed captured outcomes, and real native batch rollback from
  a fixture-only later failing statement. Representative Hono-to-Effect-to-D1
  requests use ephemeral private credentials. Restart checks persistent control
  and Alchemy migration history without replay. All state, storage, migration
  copies, logs, and home/config directories are temporary and cleaned up; no
  Cloudflare credentials or second migration executor are involved.
- Local workerd evidence is not production routing, replica, latency, outage,
  real-source rights, or deployment evidence. No snapshots or administrative
  transitions are implemented or tested by this slice.
- CI runs both suites, migration checks, and the offline Worker build without
  Cloudflare credentials. The integration fixture rejects non-dev execution; it
  is not a deployment target.
