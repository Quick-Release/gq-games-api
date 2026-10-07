# Contributor guidance

- This is a **public research-first repository**. Keep implemented behavior
  separate from proposals, experiments, and private `gq-crawl` material.
- Confirmed stack: Cloudflare Workers, Alchemy v2, Effect 4, Hono, and Vite+.
  Consult the pinned versions before following examples from older major
  versions.
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
- No open-source license is selected yet. Do not assume public visibility
  permits copying this code or privately owned source into another project.
