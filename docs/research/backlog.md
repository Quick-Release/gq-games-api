# Research backlog

## Questions before a games implementation

- The initial consumer contract is Steam App ID lookup for application identity
  and release metadata, including verified Game, Demo, and DLC product types.
  Versioned routes and representations are agreed in the
  [catalog contract](../steam-catalog-contract.md), not implemented. Which
  consumers and production access limits support that lookup? Discovery, search,
  and canonical Game grouping are not initial requirements. Players, reviews,
  prices, and the other excluded datasets are not optional additions to this
  metadata-only scope. See the [Steam catalog design](steam-game-schema.md).
- Which sources may legally be collected, stored, and redistributed? What
  attribution, retention, and deletion obligations apply?
- Use the root [glossary](../../GLOSSARY.md): Steam Application identity is its
  App ID; canonical Game identity and editorial edition grouping are not part of
  the initial catalog. Optional verified base-application links do not require
  cataloged targets. Cross-source Game reconciliation would need a future use
  case and separate design.
- Initial lookup serves last-known approved English metadata with observation
  time, not a real-time freshness promise. What availability, latency, scale,
  and cost targets matter?
- Agree the private `gq-crawl` producer's adoption of the versioned HTTP
  contract: one full English single-source snapshot per synchronous PUT,
  acquire-before-collect publication generation, clock synchronization, source
  policy matching, ordering, and retry behavior. Contract bounds/equality and
  atomic guarantees are specified; verify source fields and runtime behavior. No
  private adapter, patches, or exactly-once ledger is implemented.
- Lookup is anonymous; ingestion and publication administration use separate
  credentials. What production abuse limits, quotas, credential rotation, and
  operational controls are required? Withdrawal atomically purges metadata;
  reinstatement changes generation without restoring it. Obtain express rights
  approval for durable App ID/state/generation/timestamp control retention.
- Which Cloudflare account, domains, environments, secrets, and ownership model
  will be used?
- Which data licenses and redistribution rights support the hosted service?
  Server code is AGPL-3.0-only; data licensing is a separate decision.
- What paid managed-service tiers, quotas, freshness guarantees, and support are
  viable? Commercial self-hosting remains permitted under AGPL.
- How will deployed versions provide corresponding source, and what contributor
  rights are needed for any future alternative commercial code license?

## First experiments

1. **Catalog contract:** implement the agreed
   [HTTP and persistence acceptance tests](../steam-catalog-contract.md#required-synthetic-acceptance-tests)
   with synthetic records: strict payloads, provenance, latest-state ordering,
   role separation, and generation-fenced publication. No real source data until
   rights are reviewed.
2. **Workers runtime:** run Hono + Effect application tests in workerd,
   including cancellation, typed failures, cleanup, logging, and binding access.
   Unit tests execute in Node; `pnpm test:integration` now covers synthetic
   Drizzle/D1 CRUD, migrations, and restart behavior in workerd. Broader request
   lifecycle behavior remains to be measured.
3. **Storage requirements:** D1/Drizzle are selected and declared, without
   application tables or remote provisioning. Review catalog/control schema and
   generated SQL; verify conditional upserts, atomic batches, outcome
   classification, rollback, and primary lookup/withdrawal races in workerd.
   Measure App ID lookup costs before adding indexes or stores.
4. **Ingestion delivery:** validate the selected synchronous private HTTP
   contract with duplicate/out-of-order snapshots, generation changes,
   failure/retry uncertainty, and concurrent privileged operations. Use
   synthetic fixtures; do not introduce a second transport or processing ledger
   by default.
5. **Deployment:** validate Alchemy beta behavior in a disposable stage,
   including plan, state recovery, drift, resource naming, and teardown. Select
   shared state before introducing CI deployment.
6. **Public API:** test anonymous lookup, role-separated private operations,
   no-store/request-ID headers, safe error contracts, payload budgets, and
   post-withdrawal visibility. Decide production rate limiting, CORS, and abuse
   handling before deployment; listing/pagination and caching are not selected.

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
