# Research backlog

## Implemented and verified locally

The initial consumer capability is Steam App ID lookup for last-known approved
English application identity and Release Metadata, including verified Game,
Demo, and DLC product types. Five versioned routes, strict complete snapshots,
separate ingestion/admin roles, source-policy enforcement, generation-fenced
publication, and reviewed control/snapshot migrations are implemented locally
with synthetic records. `/health` remains process-only.

See the [catalog contract](../steam-catalog-contract.md),
[acceptance matrix](../catalog-acceptance.md), and
[architecture](architecture.md). The matrix maps every parent HTTP/D1 category
to test files/sections and records successful format/check/lint, Node tests,
workerd integration, migration consistency, and offline build commands for issue
#6. No production or real-source approval follows from those commands.

The composed workerd lifecycle extends the existing fixture: acquire before
constructing a synthetic observation stamped with the actual local clock;
submit/lookup; retry discarded snapshot responses with unchanged
body/event/generation; reconcile a discarded admin response by GET; withdraw,
then reinstate without restoration and genuinely recollect. Clock waits create
genuinely newer integer-second observations, not sleep-only race evidence or
manufactured `floor + 1` timestamps. Explicit gates order actual batches/primary
reads and delay captured results through competing commits; later-statement
failure and restart checks remain local. Node HTTP doubles do not establish
Cloudflare binding/atomicity behavior.

## Questions before real publication

- Which sources and fields may be accessed, stored, and publicly redistributed?
  Verify actual product/base/release/credit/OS field contracts, attribution,
  retention, corrections/deletion, and express permission for minimal durable
  App ID/state/generation/timestamp control. Policy matching is not rights
  clearance. If durable control cannot be retained, an approved alternative
  authority requires a new design; deleting metadata alone cannot prevent
  republishing.
- Will the private `gq-crawl` producer adopt the agreed synchronous HTTP
  contract, acquire-before-collect, synchronized clocks, exact policy matching,
  ordering, same-body/event/generation retry, and fresh recollection after
  generation changes? The second-precision floor cannot prove collection order.
  No private adapter or collection is authorized here.
- Which consumers, abuse/rate limits, quotas/CORS policy, and access budgets
  support anonymous lookup? Which independently rotatable credentials, protected
  state, monitoring/recovery, and operational owners support private writes?
  After uncertain admin responses, reconcile, do not blindly substitute a newer
  expectation.
- What availability, latency, scale, and cost targets matter? Lookup is
  last-known, not live source state or a freshness guarantee. Measure App ID
  primary-read costs before adding indexes/stores. Workerd does not establish
  production routing, global latency/outages, or replication behavior.
- Which account, domains, environments, secret/state ownership, and explicit
  deployment approval will be used? A later approved Alchemy experiment may
  investigate state recovery, drift, naming, and teardown; do not provision or
  bootstrap state as part of this documentation/acceptance work.
- Which data licenses support a managed service? Code remains AGPL-3.0-only,
  with commercial self-hosting permitted. Pricing/billing/managed tiers and any
  freshness/support promises remain plans, not a hosted service.
- How will an actual network-served version meet corresponding-source
  obligations, and what contributor rights are needed for any future alternative
  commercial code license? Keep source-data/private-component rights separate.

## Preserved scope and limits

Use the [glossary](../../GLOSSARY.md): a Steam Application is not a canonical
Game. Optional source-verified Base Application links need not have cataloged
targets and do not imply grouping. Discovery/listing, editorial editions,
multiple languages, translation, mixed-source patches, and cross-app atomic
updates are not selected. Players, histories, reviews/ratings, followers,
rankings, prices, and ownership estimates remain excluded, including indirect
raw-body/blob retention.

Synchronous retries do not promise exactly-once delivery or an event/history
ledger. Withdrawal removes snapshot/event/provenance, and reinstatement restores
none. One primary query includes eligibility: reads begun after withdrawal
commits cannot serve metadata, but already-read/in-flight responses and held
copies cannot be recalled. No-store is not consumer revocation; no cache or
Sessions/replica optimization is selected.

Broader Worker cancellation/resource cleanup and production operational behavior
remain research, not measurements established by catalog acceptance. Only D1 is
declared; do not provision speculative R2/Queues/Workflows/KV resources. Record
genuine hard-to-reverse tradeoffs in small ADRs; do not present proposals as
implemented behavior.

## Official references

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Alchemy Workers](https://alchemy.run/cloudflare/compute/workers)
- [Alchemy state](https://alchemy.run/state-store)
- [Alchemy CLI](https://alchemy.run/cli)
- [Drizzle D1](https://orm.drizzle.team/docs/get-started/d1-new)
- [Drizzle v0/v1 changes](https://orm.drizzle.team/docs/v0-v1-changes)
- [Effect](https://effect.website/)
- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Vite+](https://viteplus.dev/guide/)

Consult [pinned versions](../../package.json) and
[database notes](../database.md) before using examples; Alchemy v1/Effect
3/Drizzle v0 examples are not interchangeable with this foundation. Alchemy
alone applies reviewed migrations; no second executor, schema push, cloud
provisioning, or deployment is acceptance work.
