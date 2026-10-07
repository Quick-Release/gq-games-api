# Contributor guidance

- This is a **public research-first repository**. Keep implemented behavior
  separate from proposals, experiments, and private `gq-crawl` material.
- Confirmed stack: Cloudflare Workers + D1, Alchemy v2, Effect 4, Hono, Drizzle,
  and Vite+. Consult the pinned versions before following examples from older
  major versions.
- Drizzle ORM/Kit must match Alchemy's pinned v1 RC peer version. Use the native
  Effect D1 service, generate/review SQL before applying it, and let Alchemy own
  migration history. Do not add Wrangler or a second migration executor.
  `pnpm test:integration` validates synthetic D1 behavior in local workerd.
- Keep infrastructure in `alchemy.run.ts`, HTTP concerns in Hono, and
  application services in Effect. Never import infrastructure values into the
  Worker bundle.
- Prefer inferred types; avoid `as any` and unnecessary explicit return types.
- Add synthetic fixtures and tests with behavior changes. Do not add real crawl
  artifacts or upstream game content without source-rights approval.
- Use Vite+ (`vp`/`pnpm` scripts), not parallel ESLint, Prettier, or standalone
  Vitest setups. Keep Vite/Vitest pnpm overrides aligned with Vite+.
- After changes, run `pnpm format`, `pnpm check`, `pnpm lint`, `pnpm test`, and
  `pnpm build`. Do not claim Node unit tests validate Cloudflare-specific
  bindings.
- Do not deploy, bootstrap cloud state, create infrastructure, or add deployment
  automation without an explicit request. Cloudflare credentials and private
  ingestion details never belong in the public repository.
- Original project code is AGPL-3.0-only. Commercial self-hosting is permitted;
  revenue is planned from the managed service, not mandatory commercial-use
  fees.
- Preserve copyright/license notices and use SPDX headers for new source files.
  Future SDKs need an explicit separate MIT license before being described as
  MIT.
- Keep data licensing and private `gq-crawl` rights separate from the server
  code. Review obligations before combining private components with AGPL-covered
  code.
- Deployments must provide any required corresponding-source offer for the
  actual network-served version. See `docs/business-model.md`; no paid service
  exists yet.

## Agent skills

### Issue tracker

Use GitHub Issues in `Quick-Release/gq-games-api`. Before ticket operations,
read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage roles. Before triage or label changes, read
`docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring
domain concepts or decisions, read `docs/agents/domain.md`.
