# Architecture direction

## Confirmed choices

Cloudflare Workers, D1, Alchemy, Effect, Hono, Drizzle, and Vite+, with an
eventual `gq-crawl` integration. A D1 declaration, empty Drizzle application
schema, and Effect-native query service now exist; the synthetic integration
suite runs them locally in workerd. No remote infrastructure has been
provisioned. The domain architecture below remains a proposal.

## Proposed responsibilities

```text
Permitted source sites/APIs
         |
         v
Private gq-crawl ingestion
  fetch -> extract -> validate -> normalize -> provenance
         |
         | versioned, authenticated delivery (transport undecided)
         v
Private ingestion boundary
  schema validation -> deduplication -> idempotent persistence
         |
         v
Approved, normalized game records
         |
         v
Cloudflare Worker: Hono -> Effect services -> storage/cache
         |
         v
Public, versioned read API
```

Crawling and extraction should not occur on the public request path. The API
should serve approved records, with source attribution and freshness semantics,
rather than exposing raw upstream content. Public API and ingestion can be
separate Workers; decide after studying isolation and operational needs.

## Candidate Cloudflare capabilities

| Capability | Candidate use                         | Decision needed                         |
| ---------- | ------------------------------------- | --------------------------------------- |
| Workers    | Hono HTTP API                         | Limits, region behavior, request budget |
| D1         | Game identity, metadata, provenance   | Query patterns, indexing, scale         |
| R2         | Private artifacts or larger documents | Retention, licensing, access policy     |
| Queues     | Delivery and retry of ingestion jobs  | Contracts, DLQ, idempotency             |
| Workflows  | Durable multi-step ingestion          | Whether orchestration belongs in crawl  |
| KV/Cache   | Read optimization                     | Invalidation and consistency            |

Do not provision all of these just because they are available. Start with
measured requirements. Only D1 is declared/bound today; its application schema
is empty. No queue, workflow, or crawler binding exists.

## Hono and Effect boundary

Hono handles HTTP concerns. Effect services should own normalization,
validation, repository access, typed failures, retries, and resource management.
Map expected failures to deliberate HTTP status codes; never serialize raw
errors. Compose service Layers at the runtime boundary and scope disposable
resources per request.

The scaffold runs a pure health Effect via `Effect.runPromise` and provides an
Effect `Database` Layer for Drizzle/D1 queries. No domain tables, repositories,
or game domain models exist yet. See [database tooling](../database.md). Alchemy
v2 also uses Effect for infrastructure; infrastructure values must not enter the
Worker runtime bundle. Binding inference uses erased type-only imports.

## gq-crawl contract to investigate

Define a contract together with the private ingestion project before
implementing an adapter:

- Stable game identifiers, platform/edition identity, and duplicate resolution.
- Payload schema version, event ID, source URL, observed time, and extraction
  version. Distinguish absent, unknown, and removed fields.
- Source-specific rights, attribution, permitted distribution, and deletion.
- Authentication, payload limits, replay protection, and idempotency keys.
- Retryable versus terminal failures, backpressure, dead-letter handling, and
  reconciliation after partial writes.
- Field-level provenance, freshness indicators, quality gates, and corrections.

The public repository should contain the agreed interface and synthetic
fixtures, not private source inventories, crawl artifacts, or copied private
research.
