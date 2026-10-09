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
- `src/db/schema.ts` declares `steam_application_publication`: App ID,
  eligible/withdrawn state, opaque generation, and integer Unix-second issuance
  time. Checks enforce the App ID range, two stored states, nonempty generation,
  and nonnegative integer timestamp. Uninitialized control is absence. No source
  content, reasons, or delivery history are retained in control.
- `steam_application_snapshot` stores one complete deletable observation:
  explicit identity, base link, release tags/date/window, provenance, and
  accepted event columns. Ordered credits and canonical OS subsets use nullable
  JSON arrays; null and empty remain distinct. Free-text scalar columns use JSON
  string encoding to preserve decoded Unicode spelling (including escaped lone
  UTF-16 surrogates) across the UTF-8 D1 binding, not arbitrary payload storage.
  The App ID primary key is the only index; base targets need not exist. No raw
  payload or delivery archive exists.
- `src/services/catalog.ts` supplies the cohesive Effect `Catalog` service for
  anonymous lookup, authorization acquisition, publication inspection/change,
  and snapshot submission. Hono supplies Catalog and Database layers per
  request. Health remains process-only.

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
JSON 500 and never logs raw exceptions. All five catalog operations recognize
documented transient D1 errors as `SERVICE_UNAVAILABLE`; unknown/permanent query
errors become `INTERNAL_SERVER_ERROR`, without retaining or logging driver text.
Missing HTTP database bindings return 503. The pinned client wraps all D1
failures as UnknownError, so this narrow classification uses
[documented D1 messages](https://developers.cloudflare.com/d1/observability/debug-d1/#list-of-d1_errors),
not an assumed typed driver distinction. `tests/catalog-database-errors.test.ts`
checks the wrapping/mapping across all five routes in Node, not real outage
behavior. Interactive transactions and streaming queries are not supported by
this client; do not assume SQLite's transaction API is available. The operations
below use the native ordered atomic D1 batch, not interactive transactions or
parallel Effects.

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

### Atomic snapshot submission

After strict application validation and exact synthetic source/extractor policy
matching, one native D1 batch captures the prior control/snapshot decision with
a SELECT, then performs a guarded complete-snapshot upsert. Both statements are
inside the ordered primary transaction. Withdrawal, generation mismatch, and
observation floor checks precede timestamp/equality comparison. The write guard
repeats the eligibility, generation, floor, and newer-observation requirements;
business rejections deliberately do not mutate. Equal-time equality compares all
canonical encoded metadata/provenance columns with null-safe SQL comparisons,
excluding only the event ID; credits retain order and OS arrays are
lexicographically canonical. The pre-state result captures the response
outcome/time, so no post-commit read can reclassify it. Success waits for the
complete batch commit; a later fixture-injected SQL failure rolls back insertion
or replacement. Submission never initializes or changes control.

### Atomic administrative publication changes

After strict command validation, `Catalog.changePublication` executes one native
ordered D1 batch: capture the expectation/outcome and response fields from prior
control; conditionally delete the snapshot for an authorized withdrawal; then
conditionally initialize/advance control. Both mutation guards compare the same
prior control, because deletion does not change it. Null expectation matches
only absence; a nonnull expectation must match the current generation. Mismatch
is classified before same-state, and both mismatch and same-state paths perform
no mutations. No independent precheck or post-commit classification read exists.

Server-generated random generation and Effect-clock timestamp candidates become
issued control only on initialization or transition; same-state responses retain
the stored generation/timestamp. Batch success is required before returning the
captured `applied`/`unchanged` response. A later fixture-injected SQL failure
rolls back deletion and advancement together. Reinstatement issues eligible
control without restoring metadata. Acquisition preserves this generation, and
ingestion still enforces its generation/floor. Only the admin HTTP role can
invoke this command; acquisition/submission never call it or toggle eligibility.

Withdrawal retains only App ID, state, generation, and issued timestamp. No
content-bearing reason, raw body, accepted-event history, or alternate metadata
store is added. Existing reviewed schema/migrations already support these
operations; this slice requires no new migration.

### Atomic public lookup eligibility

`Catalog.lookupApplication` performs one parameterized primary SELECT joining
snapshot and publication control by App ID and filtering `state = 'eligible'`.
It selects only public columns and reconstructs metadata, strict tagged dates,
and the three public provenance fields. No control check or second read can
interleave with the snapshot read. Orphan metadata, absent snapshots, eligible
control without metadata, and withdrawn control all produce `NOT_FOUND`. No
Sessions, replicas, cache, TTL, inferred release state, or upstream fetch is
introduced. The observation is last-known, not a freshness guarantee. Previously
read/in-flight responses and consumer-held copies cannot be recalled. A primary
read begun after withdrawal commits cannot serve the snapshot. The composed HTTP
fixture holds an actual earlier read result until after withdrawal (allowed 200)
and executes a second read only after withdrawal (404); this is a read-start
boundary, not consumer recall or production replication evidence.

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

The [acceptance matrix](catalog-acceptance.md) maps every parent HTTP/D1
category to test files and searchable sections and records the completed local
quality run for issue #6. Node and workerd evidence remain distinct from
production guarantees.

- `pnpm test`: Node unit tests cover lazy layer construction, parameterized SQL,
  and typed error handling with a deliberately failing D1 stub. They do **not**
  validate Cloudflare bindings.
- `pnpm test:integration`: retains the synthetic generated-table CRUD fixture
  and adds a Catalog service fixture using the reviewed application migration.
  Real local workerd exercises absent/existing/withdrawn control, concurrent
  acquisition, complete snapshot insertion/replacement/null clearing,
  stale/equal/conflict preservation, generation/floor/source rejection,
  coordinated competing deliveries, captured outcomes, and real native batch
  rollback from a fixture-only later failing statement. Representative
  Hono-to-Effect-to-D1 requests use ephemeral private credentials. Anonymous
  lookup flows verify full public representations and service eligibility
  against synthetic missing/eligible/withdrawn fixture states, including
  snapshots without eligible control. Restart checks persistent control and
  Alchemy migration history without replay. Publication tests cover absent and
  populated withdrawal, mutation-free same-state/mismatched commands,
  reinstatement/fresh-publication fences, late-SQL rollback, and coordinated
  admin/acquisition/ingestion commit-order scenarios. A narrow persisted-state
  audit verifies deletion and minimal control, without relying on public lookup.
  `verifyHttpLifecycle` in `tests/integration/catalog-lifecycle.ts`, invoked
  inside `catalog.test.ts`, adds real HTTP acquire/collect/submit/lookup,
  discarded-response same-body/event/generation retries (`unchanged`, then
  `ignored_stale` after a newer observation), admin GET reconciliation, and
  withdrawal/reinstatement with genuine recollection. Observations use the
  actual local clock after acquisition, waiting for a later second instead of
  inventing floor-relative timestamps. Invalid below-floor candidates are only
  rejection tests, never accepted recollection evidence.
  `tests/fixtures/http-gates.ts` coordinates actual D1 batches/primary reads
  before execution and delays their results through competing commits. Only
  ephemeral latched signals and counters live in its registry, not payloads,
  SQL, or results. These HTTP gates supplement existing service races: captured
  classifications are asserted independently of later reads. A fixture-only
  later-statement HTTP snapshot failure checks rollback and sanitized failure
  handling, alongside control initialization, snapshot insert/replacement, and
  withdrawal deletion/advancement rollback. No production fault endpoint is
  added. All state, storage, migration copies, logs, and home/config directories
  are temporary and cleaned up; no Cloudflare credentials or second migration
  executor are involved. Restart also checks the composed lifecycle's control,
  snapshot, and public representation without reseeding.
- Local workerd evidence is not production routing, replica, latency, outage,
  real-source rights, or deployment evidence. Source-field rights and express
  durable-control retention permission remain gates before real publication.
- CI runs both suites, migration checks, and the offline Worker build without
  Cloudflare credentials. The integration fixture rejects non-dev execution; it
  is not a deployment target.
