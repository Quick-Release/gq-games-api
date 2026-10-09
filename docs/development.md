# Development and deployment

## Layout

```text
src/app.ts               Hono HTTP boundary, exported factory for tests
src/services/health.ts   Process-only health Effect
src/services/catalog.ts  Lookup/acquisition/publication/snapshot Effect service
src/services/publication.ts Strict content-free publication command validation
src/services/snapshot.ts Strict snapshot validation and synthetic source policy
src/http/catalog.ts      Catalog transport, private authentication, and errors
src/db/                 Drizzle schema and Effect-native D1 service
src/env.ts              Type-only Alchemy binding inference
src/index.ts             Cloudflare Worker entrypoint
alchemy.run.ts           Worker + D1 declarations and Alchemy v2 stack
drizzle.config.ts       Credential-free migration generation config
drizzle/                Reviewed publication-control and snapshot migrations
scripts/build-worker.ts  Offline Alchemy source-provider build adapter
scripts/preview-worker.ts Local-only preview of the built Worker
vite.config.ts           Vite+ test, lint, format, and check settings
tests/app.test.ts        Node unit tests of the HTTP boundary
tests/tooling.test.ts    Tooling configuration regression tests
tests/database.test.ts   Database service unit tests with a D1 stub
tests/integration/       Real local workerd catalog + D1/Drizzle tests
docs/research/           Proposed architecture and experiments
```

`alchemy.run.ts` owns the Worker entrypoint, compatibility settings, bindings,
build output, and local server settings. There is no Wrangler configuration or
Cloudflare Vite plugin to keep in sync. The Worker bundle never imports the
infrastructure module.

- `pnpm dev` runs `alchemy dev --stage local-dev`: Alchemy's Rolldown watcher
  rebuilds the plain Worker and runs it in local workerd at
  `http://127.0.0.1:8787`. The strict port avoids silently switching ports.
- `pnpm build` uses Alchemy's exported `resolveSource` / `makeSourceContext` API
  to run the same Worker source provider used for deployment, producing
  `dist/index.js`. It does not evaluate the stack, access state, or deploy. The
  adapter is needed because beta.81 has no standalone build command; recheck
  this API when upgrading Alchemy.
- After building and stopping dev, `pnpm preview` serves the prebuilt Worker
  through Alchemy/workerd on the same port, without rebundling the source. It
  inherits the Worker settings and bindings from `apiConfig`. The preview stack
  rejects non-dev execution and must never be deployed.

The current Worker and D1 run locally without Cloudflare credentials or remote
provisioning. Dev and preview persist only Alchemy's credential-free D1 resource
state (including its local identity); Worker state and stack outputs stay in
memory because pinned Alchemy's JSON encoder unwraps redacted secrets. Local D1
storage and its Alchemy-owned migration history remain durable across restarts;
the synthetic fixture exercises this actual state adapter and verifies that
credentials appear in neither files nor diagnostics. Existing credential-free
scaffold state files are not deleted or migrated. D1 is emulated in workerd and
receives pending migrations on local reconciliation. See
[database tooling](database.md) for Drizzle queries, generation, and migration
ownership. Alchemy defaults Workers to local emulation during dev, but **this is
not a universal no-cloud guarantee**: `Alchemy.remote()` and resources without a
local provider can operate on real infrastructure. Review new resources before
adding them. Do not use deployed stages for local dev/preview; switching
provider modes in the same stage can replace real resources. The scripts reserve
`local-dev` and `local-preview`, separate from the manual deployment stage.

Node unit tests exercise Hono, tooling configuration, and the database service
with a stub; they do not validate workerd or Cloudflare bindings. Run
`pnpm test:integration` for the synthetic Drizzle/D1 fixture in real local
workerd, including migrations and restart behavior. Smoke-test both dev and
preview against `/health` when changing the bundler/runtime.

## Vite+ tooling

Use `vp check`, `vp lint`, `vp fmt`, and `vp test`, or the corresponding `pnpm`
scripts. A project-local CLI is available via `pnpm exec vp` without a global
installation. Use `vp run dev`, `vp run build`, and `vp run preview` to invoke
Alchemy-backed tooling; bare `vp dev/build/preview` are Vite commands and are
not the Worker tooling. `vp run plan` and `vp run deploy` invoke the Alchemy
scripts. `vp run db:generate`, `vp run db:check`, and `vp run test:integration`
cover the database tooling. `vp pack` exists for future independently published
libraries but has no configured target today.

pnpm overrides align Vite and Vitest with Vite+'s bundled versions. The Vite
alias reports the Vite+ version, so the targeted peer-version exception is
intentional. Use `pnpm exec vp toolchain` when upgrading, and update overrides
with the package. TypeScript 6 is pinned to satisfy Alchemy's transitive tooling
peers; Vite+ uses its bundled TypeScript Go tooling for checks. The workerd
override retains the previously used `1.20261006.1` binary: Alchemy beta.81's
transitive default is too old for compatibility date `2026-10-07`. Keep the
runtime override compatible with the single date in `alchemy.run.ts`. Native
build scripts are restricted to esbuild and workerd.

CI runs the local D1 integration fixture, migration checks, and offline build.
It does not need Cloudflare secrets and never executes Alchemy deployment tasks.
Keep credentials out of pull-request jobs, especially contributions from forks.

## Manual deployment preparation

1. Pick an account and a disposable stage; do not infer the intended account
   from another GQ project.
2. Connect Cloudflare in the **project-local Alchemy CLI** with
   `pnpm exec alchemy profile edit --add cloudflare`. Credentials/profiles are
   separate from Wrangler and Pi authentication. For tokens, consult current
   Alchemy setup docs and scope permissions to the resources required; never
   commit tokens or copy local credential files.
3. Review `pnpm plan --stage dev`. It may access the account; it has not been
   run as part of scaffolding.
4. Deploy explicitly with `pnpm run deploy --stage dev` (bare `pnpm deploy` is
   pnpm's unrelated workspace deployment command). Alchemy determines names from
   stack/stage/resource identity; do not assume a local dev identity is the
   deployed resource name.
5. Verify `/health` on the returned URL and record the runtime experiment.

`workersDev: true` makes the deployed Worker publicly accessible. Private
publication acquisition/inspection/change and complete snapshot submission are
implemented; anonymous public lookup is also implemented. Production quotas and
CORS policy are not. D1 retains minimal publication control separately from
complete synthetic snapshots. Deploy can now create a D1 database, so review
costs and migration SQL as well as the public HTTP surface before deploying.
Lookup is last-known synthetic data, not a live upstream read or freshness
promise. One primary D1 query joins existing snapshots to eligible control;
absent/withdrawn cases share a safe 404. No-store and server request IDs apply
to every catalog response, including errors. Consumer-held copies and responses
already read cannot be revoked. Synthetic local workerd verifies
withdrawal/reinstatement, stale-generation fencing, coordinated commit-order
races, and atomic rollback; real-source approval and express minimal-control
retention permission remain required, alongside production
operational/credential rollout and deployment approval.

## State and secrets

Local dev/preview use a narrowly scoped state adapter in `alchemy.run.ts`. Only
D1 resource state is persisted, retaining the local identity needed to reopen
its files in ignored `.alchemy/`. Worker configuration and stack outputs stay in
memory so resolved bearer secrets never enter JSON state. This adapter is for
local emulation only, not cloud resource management or migration execution.
Restart reuses D1 identity and storage without replaying migrations.

For non-dev commands the original credential-free scaffold retains
`localState()`. Any configured publication secret blocks the ordinary stack
before resource reconciliation: pinned Alchemy persists even `Redacted` values
in plaintext JSON state. A secret-bearing deployment requires a separately
approved protected state store, migration/recovery plan, and credential rollout.
No cloud state bootstrap, encryption adapter, or CI deployment has been added.
Protect existing state; deleting it or deploying from a fresh checkout can
orphan resources or break reconciliation.

A future `Cloudflare.state()` backend can bootstrap real state infrastructure,
even during commands people expect to be read-only or local. Do not add
automatic approval flags casually. This project uses Alchemy's local Worker
provider with credential-free persisted D1 state and ephemeral Worker state for
development; retain local-only provider defaults. Neither ignored state nor
`Redacted` logging wrappers are secret encryption.

Private publication routes use `INGESTION_BEARER_TOKEN` and
`PUBLICATION_ADMIN_BEARER_TOKEN` via Alchemy `Config.Redacted` bindings, emitted
as Worker secret_text values. Supply independently generated opaque values
through protected local configuration/environment; never put them in examples,
SQL, fixtures, or logs. Empty defaults permit scaffold/health development but
private requests return 503 unless both secrets are present and distinct. HTTPS
is required by the production application even on the regular local HTTP dev
server; the explicit insecure factory option is reserved for tests, not a Worker
environment switch. No rotation rollout or production credential setup has been
performed.

`APPROVED_SNAPSHOT_SOURCES` is a non-secret Worker Config.String binding with an
empty deny-all default. Supply a JSON array of exact `source_url` and
`extractor_version` pairs. Only reserved synthetic HTTPS `example.invalid` URLs
(and subdomains), without userinfo, query, or fragment, are admitted. No real
policy approval or upstream fetch is implemented. Policy matching does not
establish source rights. See [README](../README.md) and
[the contract](steam-catalog-contract.md).

Ignore `.env*`, `.dev.vars*`, `.alchemy/`, `.wrangler/`, logs, and build output.
Commit only reviewed placeholder examples if secrets become necessary. Public
source must never contain private crawl data, credentials, or account-specific
configuration.
