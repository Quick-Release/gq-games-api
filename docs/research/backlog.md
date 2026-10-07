# Research backlog

## Questions before a games implementation

- Who consumes the API, and which use cases come first: discovery, metadata,
  platforms, releases, availability, pricing, or search?
- Which sources may legally be collected, stored, and redistributed? What
  attribution, retention, and deletion obligations apply?
- What is a game versus an edition, platform release, bundle, or DLC? How are
  identifiers reconciled between sources?
- What freshness, availability, latency, scale, and cost targets matter?
- What will `gq-crawl` deliver, through which transport, and under which shared
  versioned schema? Its current integration is not implemented.
- Which read endpoints are public, authenticated, or quota-limited? Who may
  ingest or correct records?
- Which Cloudflare account, domains, environments, secrets, and ownership model
  will be used?
- Which data licenses and redistribution rights support the hosted service?
  Server code is AGPL-3.0-only; data licensing is a separate decision.
- What paid managed-service tiers, quotas, freshness guarantees, and support are
  viable? Commercial self-hosting remains permitted under AGPL.
- How will deployed versions provide corresponding source, and what contributor
  rights are needed for any future alternative commercial code license?

## First experiments

1. **Catalog contract:** use a small synthetic dataset to test identity,
   provenance, freshness, and versioned schemas. No real source data until
   rights are reviewed.
2. **Workers runtime:** run Hono + Effect application tests in workerd,
   including cancellation, typed failures, cleanup, logging, and binding access.
   Unit tests execute in Node; `pnpm test:integration` now covers synthetic
   Drizzle/D1 CRUD, migrations, and restart behavior in workerd. Broader request
   lifecycle behavior remains to be measured.
3. **Storage requirements:** D1/Drizzle are selected and declared, without
   application tables or remote provisioning. Measure representative lookups,
   filters, indexing, pagination, consistency, and costs before designing the
   real schema or adding other stores.
4. **Ingestion delivery:** simulate duplicate/out-of-order events, schema
   changes, failure/retry, and replay using synthetic fixtures. Compare
   authenticated HTTP, service bindings, and Queues only if relevant.
5. **Deployment:** validate Alchemy beta behavior in a disposable stage,
   including plan, state recovery, drift, resource naming, and teardown. Select
   shared state before introducing CI deployment.
6. **Public API:** test pagination, caching/invalidation, rate limiting, CORS,
   authorization, abuse handling, and response budgets.

## Acceptance gate for a first real endpoint

A reviewed schema and source-rights policy; measured storage choice; an agreed
`gq-crawl` interface; tested idempotent ingestion; consistent typed HTTP errors;
security limits; an operational plan; and a successful deployment experiment.

Record decisions as small ADRs with evidence and tradeoffs. Do not present
proposed Cloudflare resources, integrations, or performance as implemented or
measured.

## Official references

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Alchemy Workers](https://alchemy.run/cloudflare/compute/workers)
- [Alchemy state](https://alchemy.run/state-store)
- [Alchemy CLI](https://alchemy.run/cli)
- [Drizzle D1](https://orm.drizzle.team/docs/get-started/d1-new)
- [Drizzle v0/v1 changes](https://orm.drizzle.team/docs/v0-v1-changes)
- [Effect](https://effect.website/)
- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Vite+](https://viteplus.dev/guide/)

Versions were checked against npm while scaffolding. Recheck official APIs when
upgrading; Alchemy is still a beta release.
