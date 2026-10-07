# Development and deployment

## Layout

```text
src/app.ts               Hono HTTP boundary, exported factory for tests
src/services/health.ts   First Effect service
src/index.ts             Cloudflare Worker entrypoint
alchemy.run.ts           Single Worker configuration and Alchemy v2 stack
scripts/build-worker.ts  Offline Alchemy source-provider build adapter
scripts/preview-worker.ts Local-only preview of the built Worker
vite.config.ts           Vite+ test, lint, format, and check settings
tests/app.test.ts        Node unit tests of the HTTP boundary
tests/tooling.test.ts    Tooling configuration regression tests
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

The current Worker and `localState()` run locally without Cloudflare credentials
or provisioning. Alchemy defaults Workers to local emulation during dev, but
**this is not a universal no-cloud guarantee**: `Alchemy.remote()` and resources
without a local provider can operate on real infrastructure. Review new
resources before adding them. Do not use deployed stages for local dev/preview;
switching provider modes in the same stage can replace real resources. The
scripts reserve `local-dev` and `local-preview`, separate from the manual
deployment stage.

Node tests exercise Hono directly and check tooling configuration; they do not
validate workerd or Cloudflare bindings. Smoke-test both dev and preview against
`/health` when changing the bundler/runtime, and add a dedicated workerd
integration suite when real bindings are introduced.

## Vite+ tooling

Use `vp check`, `vp lint`, `vp fmt`, and `vp test`, or the corresponding `pnpm`
scripts. A project-local CLI is available via `pnpm exec vp` without a global
installation. Use `vp run dev`, `vp run build`, and `vp run preview` to invoke
Alchemy-backed tooling; bare `vp dev/build/preview` are Vite commands and are
not the Worker tooling. `vp run plan` and `vp run deploy` invoke the Alchemy
scripts. `vp pack` exists for future independently published libraries but has
no configured target today.

pnpm overrides align Vite and Vitest with Vite+'s bundled versions. The Vite
alias reports the Vite+ version, so the targeted peer-version exception is
intentional. Use `pnpm exec vp toolchain` when upgrading, and update overrides
with the package. TypeScript 6 is pinned to satisfy Alchemy's transitive tooling
peers; Vite+ uses its bundled TypeScript Go tooling for checks. The workerd
override retains the previously used `1.20261006.1` binary: Alchemy beta.81's
transitive default is too old for compatibility date `2026-10-07`. Keep the
runtime override compatible with the single date in `alchemy.run.ts`. Native
build scripts are restricted to esbuild and workerd.

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
   stack/stage/resource identity; do not assume a local dev identity is the
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
automatic approval flags casually. This project uses Alchemy's local Worker
provider with local state; retain those defaults for credential-free
development.

Ignore `.env*`, `.dev.vars*`, `.alchemy/`, `.wrangler/`, logs, and build output.
Commit only reviewed placeholder examples if secrets become necessary. Public
source must never contain private crawl data, credentials, or account-specific
configuration.
