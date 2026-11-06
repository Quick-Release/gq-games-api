# gq-games-api

Research-first games API for the Cloudflare ecosystem, built with **Alchemy,
Effect, Hono, Drizzle, and Vite+**.

**Status: research + synthetic catalog lookup/ingestion/publication control.**
The repository implements process health, last-known snapshot lookup (anonymous
by default), complete snapshot submission, publication authorization
acquisition, and admin inspection/withdrawal/reinstatement on local D1. Issue #6
adds composed HTTP lifecycle/recovery acceptance, verified in isolated local
workerd. See the [acceptance matrix](docs/catalog-acceptance.md) for
reproducible test sections, completed quality commands, and evidence limits. Per
[ADR 0002](docs/adr/0002-first-hosted-deployment.md), the anonymous consumer
read is deployed at **<https://games-api.bnq.pt>** (revision `7c5f3ea`), serving
one synthetic verification record (App ID 1001) and no real game data. See the
[deployment record](docs/deployment-record.md). `gq-crawl` integration and
real-source approval remain out of scope.

## Direction

- **Cloudflare Workers + D1**: API runtime and declared relational database. D1
  runs locally with minimal publication control and complete synthetic
  snapshots. Evaluate R2, Queues, Workflows, and caching against actual
  requirements before provisioning them.
- **Alchemy**: TypeScript infrastructure, local workerd development, Worker
  builds, and eventual deployments.
- **Effect**: application services, typed failures, schemas, and resource
  lifecycles. Hono remains the HTTP boundary.
- **Hono**: routing and HTTP responses.
- **Drizzle**: Effect-native D1 queries, typed SQLite schema, and SQL migration
  generation; Alchemy owns migration application.
- **Vite+**: checks, tests, formatting, linting, and task running.
- **gq-crawl**: private upstream ingestion research/application. Publish only
  reviewed, licensed, normalized game records—not raw crawls or internal data.

See [architecture](docs/research/architecture.md), the
[research backlog](docs/research/backlog.md),
[development/deployment notes](docs/development.md), and
[database tooling](docs/database.md). The planned
[business model](docs/business-model.md) is an open-source server with a paid
managed API, not a personal-use-only license.

## Getting started

Use Node.js 24.21.0 (or another version supported by `package.json`) and the
pinned pnpm 10.29.1. Vite+ is installed locally; a global `vp` is optional.

```sh
pnpm install --frozen-lockfile
pnpm dev
# http://localhost:8787/health
```

Implemented routes:

| Method | Path                                                                   | Purpose                                                      |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/`                                                                    | Scaffold metadata                                            |
| GET    | `/health`                                                              | Process health through an Effect service                     |
| GET    | `/v1/steam/applications/{steamAppId}`                                  | Last-known approved English snapshot; anonymous by default   |
| POST   | `/internal/v1/steam/applications/{steamAppId}/ingestion-authorization` | Ingestion-role acquisition of current publication generation |
| GET    | `/internal/v1/steam/applications/{steamAppId}/publication`             | Admin-role inspection, including absent control              |
| PUT    | `/internal/v1/steam/applications/{steamAppId}/snapshot`                | Ingestion-role atomic complete-snapshot submission           |
| PUT    | `/internal/v1/steam/applications/{steamAppId}/publication`             | Admin-role generation-checked withdrawal/reinstatement       |
| PUT    | `/v1/keys/{keyId}`                                                     | Registry-credential upsert of a full API key record          |
| GET    | `/v1/keys/{keyId}`                                                     | Registry-credential inspection of an API key record          |
| DELETE | `/v1/keys/{keyId}`                                                     | Registry-credential revocation of an API key record          |

Consumer reads can require customer API keys with
`CATALOG_ACCESS_MODE=protected`. See
[verification and access modes](docs/verification-registry.md#protected-catalog-reads)
for the credential format and rejection behavior.

Acquisition atomically initializes only absent control, preserves existing
eligible generation/timestamp, and refuses withdrawal. Inspection does not
initialize control. Snapshot PUT requires the acquired generation unchanged in
`X-Publication-Generation`, validates one complete English observation, and
atomically applies a newer snapshot, ignores stale delivery, accepts equal-time
identical content unchanged, or rejects equal-time conflicts. Explicit nulls
clear old fields; no-op/rejection preserves the accepted event. Submission never
initializes or changes publication control. No real upstream content,
publication reason, raw body, or delivery history is stored. See
[the contract](docs/steam-catalog-contract.md) for response shapes. Successful
writes respond only after commit. After transport/server uncertainty, retry the
same snapshot, event ID, and generation: a lost successful response can yield
`unchanged`, then `ignored_stale` after a newer accepted observation. These are
safe synchronous outcomes, not replay-ledger or exactly-once guarantees. Acquire
before collection and stamp genuine UTC Unix-second observations using
synchronized clocks. The generation's second-precision floor is a guardrail, not
proof of collection order; never fabricate a newer timestamp or relabel an old
queued payload with a new generation.

Admin publication PUT requires exactly `state` (`eligible` or `withdrawn`) and
`expected_generation` (the inspected generation, or null for absent control).
Initialization/transitions issue a fresh generation and observation floor;
current-generation same-state commands preserve both and return `unchanged`.
Mismatched expectations return 409 even for a matching state. Withdrawal deletes
all snapshot metadata, accepted event, and provenance atomically with control
advancement, retaining only the four minimal control fields. Reinstatement
restores no metadata: acquire the new generation, then genuinely recollect.
Queued old generations cannot republish, even with newer timestamps. After an
uncertain admin response, GET control and reconcile the intended decision; do
not blindly replace an old expectation with a newer one. Delisting/source
omission and calendar passage do not change publication or Release Status. There
is no withdrawal-reason archive, event ledger, control expiry, or forget
operation. Real publication still requires express minimal-control retention
permission and source-field access/storage/redistribution/deletion approval.

Public lookup accepts canonical decimal App IDs from 1 through 4294967295,
without credentials or a generation. It is rate limited to 100 requests per 60
seconds per client IP (`429 RATE_LIMITED`); the limit is approximate abuse
control, not a quota. It returns only metadata and public provenance
(`source_url`, `language`, `observed_at`), using one primary D1 query that
requires both eligible control and an existing snapshot. Missing and withdrawn
applications have identical `NOT_FOUND` 404s. All catalog responses, including
failures, are no-store with server-owned request IDs. Lookup never fetches
upstream content or promises current availability/freshness. No-store does not
recall previously read responses or consumer-held copies. A lookup whose primary
read starts after withdrawal commits cannot serve metadata; an earlier read may
still finish afterward. Synthetic workerd acceptance covers
withdrawal/reinstatement, gated real HTTP commit-order races, delayed captured
outcomes, uncertain-response recovery, rollback, and restart. The acceptance
matrix records the completed local run; this does not prove production routing
or real-source rights.

All five catalog routes require HTTPS outside explicit local tests. Private
routes additionally require distinct opaque Worker secrets
`INGESTION_BEARER_TOKEN` / `PUBLICATION_ADMIN_BEARER_TOKEN`; missing or
ambiguous configuration fails closed with 503. Alchemy resolves these via
redacted Config bindings into Worker secrets. Local Worker state stays in memory
so Alchemy cannot persist them in plaintext JSON; only credential-free D1
identity/migration state is persisted, keeping D1 durable. Deployed stages keep
all state, secrets included, in Alchemy's encrypted Cloudflare state store
(ADR 0002) and never use the plaintext local adapter. Test credentials are
ephemeral; only test factory options allow insecure local HTTP. The regular
local scaffold/health remain usable without secrets. Private responses and
errors are no-store with server-owned request IDs and sanitized envelopes.

Snapshot submission additionally requires `APPROVED_SNAPSHOT_SOURCES`, a JSON
array of exact `{source_url, extractor_version}` pairs. Empty, malformed, or
unmatched policy denies submission with `SOURCE_NOT_APPROVED`. This slice admits
only synthetic HTTPS URLs on `example.invalid` or its subdomains, without
credentials, query strings, or fragments; it never fetches sources. For example,
a synthetic policy can pair `https://catalog.example.invalid/apps/1001` with
`synthetic-v1`. Exact spelling matters. Policy matching is not legal approval.
Bodies are strict uncompressed UTF-8 JSON, bounded by actual bytes at 32 KiB.

Health reports only this process, not crawler or storage readiness. Missing
routes return JSON 404s; unexpected failures return a generic JSON 500.

```sh
pnpm format       # Oxfmt
pnpm lint         # Oxlint + type-aware checks
pnpm check        # formatting + lint + TypeScript checks
pnpm test         # Node HTTP, tooling, and database service unit tests
pnpm test:integration # real local workerd, synthetic catalog atomicity + D1
pnpm db:generate  # generate migration SQL after defining approved tables
pnpm db:check     # check migration consistency
pnpm build        # offline Alchemy/Rolldown Worker build
pnpm preview      # Alchemy/workerd; stop dev first (same port)
```

With a global Vite+ CLI, use `vp install`, `vp check`, `vp lint`, `vp fmt`, and
`vp test`. Use `vp run dev`, `vp run build`, and `vp run preview` for the
Alchemy-backed Worker tooling, not bare `vp dev/build/preview`. Project scripts
also include `vp run plan` and `vp run deploy`. Vite+ supplies `vp pack`
(tsdown), dependency/runtime management, caching, and staged-file tools; no
library packaging or hooks are configured because this is an API, not a library.
Quality-tool settings live in `vite.config.ts`; **all Worker configuration lives
in `alchemy.run.ts`**, with no Wrangler file. Dev and preview use reserved local
stages and require no cloud credentials for this scaffold; review new resources
before assuming they can be emulated locally.

CI runs checks, lint, both test suites, migration checks, and a Worker build. It
does **not** deploy. Drizzle ORM/Kit are pinned to Alchemy's expected v1 RC; see
[database notes](docs/database.md) before changing those versions.

## Deployment is deliberately manual

Alchemy is pinned to **2.0.0-beta.81**, using its v2 API and **Effect 4.0.1**.
Examples for Alchemy v1 or Effect 3 are not interchangeable. The Node CLI uses
`@effect/platform-node`; Bun is not required.

After selecting a Cloudflare account, authenticating Alchemy, and reviewing the
security/state requirements in [development notes](docs/development.md) and
[ADR 0002](docs/adr/0002-first-hosted-deployment.md), deploy from a clean
checkout of the commit being served:

```sh
pnpm exec alchemy profile edit --add cloudflare
export API_DOMAIN='games-api.your-zone.example' # existing zone in the account
export SOURCE_REVISION="$(git rev-parse HEAD)"
pnpm plan --stage production
pnpm run deploy --stage production
```

**Deploy creates a public Workers endpoint on `API_DOMAIN`, provisions a D1
database, and on first run bootstraps Alchemy's encrypted state store in the
account.** Supply ingestion and publication-admin secrets from your own secret
store in the same shell; never commit them. Write endpoints stay bearer-gated;
real-source publication still needs source licensing approval. No credentials,
hostnames, or account identifiers are committed.

`GET /` offers the corresponding source: licence, repository, and the exact
`SOURCE_REVISION` served (AGPL-3.0 section 13). Forks set `SOURCE_REPOSITORY`.

## Publication

GitHub: <https://github.com/Quick-Release/gq-games-api> (public).
`private: true` in `package.json` prevents accidental npm publishing; it does
not change GitHub visibility. `gq-crawl` remains private. Do not copy its
research, credentials, artifacts, or implementation into this public repository
without approval.

## License and hosted service

Copyright (C) 2026 gq-games-api contributors.

This project's original code is licensed under the **GNU Affero General Public
License, version 3 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE). You may
use, modify, and redistribute it under those terms, including commercial
self-hosting. The software is provided without warranty; see the license for
details.

The planned paid service charges for the managed API, infrastructure, maintained
data, and support—not for the right to use the code commercially. No paid
service, pricing, billing, or real-source ingestion exists. The one hosted
deployment serves synthetic data only and offers its exact source revision at
`GET /`.

Modified network-served versions must prominently offer their corresponding
source to users as required by AGPL section 13. Future SDKs are intended to use
MIT under separate explicit licenses; none exist today. Third-party dependencies
retain their own licenses, and game-data rights are separate from the code
license.

See [business model and licensing boundaries](docs/business-model.md).
