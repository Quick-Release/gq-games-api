# Architecture direction

## Implemented synthetic capability

Cloudflare Workers + D1, Alchemy v2, Effect 4, Hono, Drizzle's native Effect D1
driver, and Vite+ are the pinned foundation. The application now has separate
minimal publication-control and complete-snapshot tables, reviewed migrations,
and five catalog routes: anonymous Steam App ID lookup, private ingestion
acquisition/submission, and admin publication inspection/change. `/` and
process-only `/health` remain; health does not test D1 or crawler readiness. No
remote infrastructure, deployment, real source policy, or private `gq-crawl`
adapter is implemented.

```text
Synthetic producer (local acceptance only)
  acquire publication generation -> genuinely collect -> submit full snapshot
         |
         v
Hono HTTP boundary: roles, HTTPS, bounded transport, safe responses
         |
         v
Effect Catalog service: validation, exact synthetic source policy, lifecycle
         |
         v
Native Effect D1: one ordered atomic batch per mutation decision
  minimal publication control + deletable complete snapshot
         |
         v
Anonymous lookup: one primary eligibility/snapshot query -> public projection
```

Hono provides Catalog and Database layers per request, not a global
first-binding singleton. Infrastructure belongs in `alchemy.run.ts` and never
enters the Worker bundle. Alchemy alone owns migration application/history;
Drizzle Kit only generates/checks SQL. See [database tooling](../database.md)
and [development](../development.md).

## Consistency and recovery

Acquisition initializes only absent control and preserves existing eligible
generation/floor; it cannot lift withdrawal. Submission cannot initialize or
change control. One atomic batch captures eligibility, generation/floor,
ordering/equality, and mutation results; classification does not use a later
post-write read. Interactive transactions, parallel Effects, and separate
read/check/write calls are not substitutes.

Writes are synchronous: success follows commit. Retry an uncertain snapshot with
the same body/event/generation; an identical replay can be `unchanged`, or
`ignored_stale` after a newer accepted observation. There is no replay ledger or
exactly-once guarantee. A newer correction needs genuine observation, not an
invented timestamp. An obsolete generation needs reacquisition and recollection.
The second-precision floor is a guardrail, not proof of acquire-before-collect;
producer clocks must be synchronized.

Admin changes compare expected generations. Withdrawal advances control and
purges all snapshot/event/provenance content, retaining only App ID, state,
generation, and issued timestamp. Reinstatement restores no metadata. After an
uncertain admin response, GET and reconcile rather than blindly adopting a new
expectation. Upstream omission/delisting is not withdrawal.

Public reads serve last-known approved English metadata, with no upstream fetch,
cache, TTL, inferred Release Status, or freshness promise. A primary query
requires both eligible control and a snapshot. A read begun after withdrawal
commits cannot serve metadata; an earlier read/in-flight response may complete,
and consumer-held copies cannot be revoked by no-store.

## Local acceptance, not production proof

The [acceptance matrix](../catalog-acceptance.md) maps the parent's HTTP and D1
categories to Node and workerd test sections and records the completed issue #6
local quality run. `verifyHttpLifecycle` extends the existing isolated
Alchemy/workerd fixture with actual post-acquisition local-clock observations,
same-delivery lost-response retries, admin reconciliation, fresh reinstated
publication, and restart. Fixture-only gates hold actual batches/primary reads
and their results through competing commits; they store ephemeral latched
coordination signals and counters, not payloads/results. Later-statement
failures exercise rollback without a production fault endpoint.

Node HTTP doubles establish validation/security mappings, not D1 binding or
transaction guarantees. Local workerd exercises the pinned stack, not production
routing, global latency/outages, replication, source legality, or consumer
recall.

## Remaining decisions and approvals

- Real source-by-field contracts, access/storage/public redistribution,
  attribution, retention/deletion, and express permission for durable minimal
  publication control. Exact URL/extractor matching is enforcement, not rights
  approval; current policies admit reserved synthetic sources only.
- Private `gq-crawl` adoption of the
  [catalog contract](../steam-catalog-contract.md): full single-source English
  snapshots, acquire-before-collect, synchronized clocks, source policy,
  same-delivery retries, and fresh recollection. Public docs/fixtures must not
  contain private source inventories, artifacts, or code.
- Production access/abuse budgets, credential rotation/protected state,
  monitoring/recovery, operational ownership, and deployment approval.
- Measured App ID lookup cost/scale before considering any additional resource.
  R2, Queues, Workflows, KV/cache, Sessions/replicas, split Workers, discovery,
  canonical Game grouping, patches, and cross-app atomic ingestion are **not
  selected**. Excluded players/reviews/prices/histories are not future optional
  tables in this metadata-only scope.

Server code remains AGPL-3.0-only; data rights and private-component obligations
remain separate, as do eventual deployed corresponding-source obligations.
