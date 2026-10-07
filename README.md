# gq-games-api

Research-first games API for the Cloudflare ecosystem, built with **Alchemy,
Effect, Hono, and Vite+**.

**Status: research + minimal scaffold.** The repository contains a working
health endpoint and development tooling, not a games catalog or deployed
service. No Cloudflare resources have been created for this scaffold. `gq-crawl`
is the planned ingestion system; no crawler integration exists yet.

## Direction

- **Cloudflare Workers**: API runtime. Evaluate D1, R2, Queues, Workflows, and
  caching against actual requirements before provisioning them.
- **Alchemy**: TypeScript infrastructure and eventual deployments.
- **Effect**: application services, typed failures, schemas, and resource
  lifecycles. Hono remains the HTTP boundary.
- **Hono**: routing and HTTP responses.
- **Vite+**: development, checks, tests, builds, formatting, linting, and tasks.
- **gq-crawl**: private upstream ingestion research/application. Publish only
  reviewed, licensed, normalized game records—not raw crawls or internal data.

See [architecture](docs/research/architecture.md), the
[research backlog](docs/research/backlog.md), and
[development/deployment notes](docs/development.md). The planned
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

| Method | Path      | Purpose                                   |
| ------ | --------- | ----------------------------------------- |
| GET    | `/`       | Scaffold metadata and available endpoints |
| GET    | `/health` | Process health through an Effect service  |

Health reports only this process, not crawler or storage readiness. Missing
routes return JSON 404s; unexpected failures return a generic JSON 500.

```sh
pnpm format       # Oxfmt
pnpm lint         # Oxlint + type-aware checks
pnpm check        # formatting + lint + TypeScript checks
pnpm test         # bundled Vitest; five HTTP boundary tests
pnpm build        # Vite/Rolldown + Cloudflare Workers build
pnpm preview      # serve the built Worker locally
```

With a global Vite+ CLI, the equivalents are `vp install`, `vp dev`, `vp check`,
`vp lint`, `vp fmt`, `vp test`, `vp build`, and `vp preview`. Use
`vp run <task>` for project scripts such as `vp run plan` and `vp run deploy`.
Vite+ also supplies `vp pack` (tsdown), dependency/runtime management, caching,
and staged-file tools; no library packaging or hooks are configured because this
is an API, not a library. All tool-specific settings live in `vite.config.ts`.

CI runs checks, lint, tests, and a Worker build. It does **not** deploy.

## Deployment is deliberately manual

Alchemy is pinned to **2.0.0-beta.81**, using its v2 API and **Effect 4.0.1**.
Examples for Alchemy v1 or Effect 3 are not interchangeable. The Node CLI uses
`@effect/platform-node`; Bun is not required.

After selecting a Cloudflare account, authenticating Alchemy, and reviewing the
security/state requirements in [development notes](docs/development.md):

```sh
pnpm exec alchemy profile edit --add cloudflare
pnpm plan --stage dev
pnpm run deploy --stage dev
```

**Deploy creates a public Workers endpoint.** Do not deploy substantive game or
write endpoints before access, rate limiting, source licensing, and ingestion
contracts are settled. No credentials or account identifiers are committed.

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
data, and support—not for the right to use the code commercially. No hosted
service, pricing, billing, or catalog is implemented yet.

Modified network-served versions must prominently offer their corresponding
source to users as required by AGPL section 13. Future SDKs are intended to use
MIT under separate explicit licenses; none exist today. Third-party dependencies
retain their own licenses, and game-data rights are separate from the code
license.

See [business model and licensing boundaries](docs/business-model.md).
