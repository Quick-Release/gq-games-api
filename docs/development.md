# Development and deployment

## Layout

```text
src/app.ts               Hono HTTP boundary, exported factory for tests
src/services/health.ts   First Effect service
src/index.ts             Cloudflare Worker entrypoint
alchemy.run.ts           Alchemy v2 stack and Worker declaration
wrangler.jsonc           Local Vite/Workers runtime configuration
vite.config.ts           Vite+ build, test, lint, format, and check settings
tests/app.test.ts        Node unit tests of the HTTP boundary
docs/research/           Proposed architecture and experiments
```

`pnpm dev` uses the Cloudflare Vite plugin and workerd locally, without
provisioning cloud resources. `pnpm build` produces a Worker under `dist/`;
`pnpm preview` serves that build locally. Tests use Hono's request helper in
Node, not a simulated Cloudflare deployment. Keep a separate workerd integration
suite when real bindings are introduced.

Alchemy owns **deployment**, while Wrangler configuration currently supports
only the local Vite dev/build path. Both use `src/index.ts`, compatibility date
`2026-10-07`, and `nodejs_compat`. Keep these aligned as bindings are added. Do
not run `wrangler deploy` beside Alchemy for the same resources.

Alchemy bundles the same source independently through its own Rolldown pipeline;
`pnpm build` verifies Vite's artifact, not an Alchemy deployment. The two build
paths must be validated against workerd when dependencies or bindings change.

## Vite+ tooling

Use `vp check`, `vp lint`, `vp fmt`, `vp test`, `vp dev`, `vp build`, and
`vp preview`, or the corresponding `pnpm` scripts. A project-local CLI is
available via `pnpm exec vp` without a global installation. `vp run` is the task
runner; `vp run plan` and `vp run deploy` invoke the Alchemy scripts. `vp pack`
exists for future independently published libraries but has no configured target
today.

pnpm overrides align Vite and Vitest with Vite+'s bundled versions. The Vite
alias reports the Vite+ version, so the targeted peer-version exception is
intentional. Use `pnpm exec vp toolchain` when upgrading, and update overrides
with the package. TypeScript 6 is pinned to satisfy Alchemy's transitive tooling
peers; Vite+ uses its bundled TypeScript Go tooling for checks. Native build
scripts are restricted to esbuild and workerd.

CI does not need Cloudflare secrets and never executes Alchemy deployment tasks.
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
   stack/stage/resource identity; do not assume the local Wrangler name is the
   deployed resource name.
5. Verify `/health` on the returned URL and record the runtime experiment.

`workersDev: true` makes the deployed Worker publicly accessible. No public game
API, authenticated ingestion, quotas, CORS policy, or data storage is
implemented by the scaffold. Review them before exposing anything beyond
health/metadata.

## State and secrets

The stack explicitly uses `localState()`, keeping state in ignored `.alchemy/`.
Local state is sufficient for a single-developer experiment, not collaborative
production deployment. Protect and back it up; deleting state or deploying from
a fresh checkout can orphan resources or break reconciliation. Do not switch to
shared state or add CI deployment without a migration/recovery plan.

A future `Cloudflare.state()` backend can bootstrap real state infrastructure,
even during commands people expect to be read-only or local. Do not add
automatic approval flags casually. Likewise, Alchemy dev can use real remote
resources; this project defaults to Vite/workerd dev instead.

Ignore `.env*`, `.dev.vars*`, `.alchemy/`, `.wrangler/`, logs, and build output.
Commit only reviewed placeholder examples if secrets become necessary. Public
source must never contain private crawl data, credentials, or account-specific
configuration.
