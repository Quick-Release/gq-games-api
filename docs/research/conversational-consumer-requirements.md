# Conversational consumer requirements

Research date: 2026-11-01. **Proposal only.** This note collects requirements
that a planned read-only consumer would need. It does not change the
[catalog contract](../steam-catalog-contract.md), authorize implementation, or
approve any source, field, or producer integration.

## Context

The approved direction (2026-11-01) is a private GETQUICK consumer, a Discord
bot called `gq-poirot`, that answers natural-language game questions. The
motivating example is "when is the release date of GTA 6". The bot reads from
this API. When a lookup misses, it asks the private `gq-crawl` producer.
`gq-crawl` is still the only producer, and it updates this API through the
existing ingestion routes. The consumer only reads and never writes. A matching
ADR is being drafted in `gq-platform`. This repository records only what that
decision means for the public catalog.

## Current contract versus consumer needs

| Need                    | Current contract (implemented)                                                      | Gap                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Lookup by game name     | Only consumer read is `GET /v1/steam/applications/{steamAppId}`                     | The contract excludes search and listing, so there is no name-to-identity resolution.         |
| Cross-platform identity | One record per Steam Application. No canonical **Game** identities.                 | A question is about a **Game**, not a Steam App ID.                                           |
| Non-Steam games         | Steam-only model. Ingestion admits verified Game, Demo, and DLC Steam applications. | A title that has no Steam Application, such as the motivating example, cannot be represented. |
| Release questions       | **Release Metadata**, **Release Window**, **Release Status** per Steam Application  | These are Steam-scoped and say nothing about a Game's release across platforms.               |
| News                    | Not modeled. Snapshots are catalog metadata only.                                   | Open question (see below).                                                                    |

Use [glossary](../../GLOSSARY.md) terms. A Steam Application is not a canonical
Game, and its Release Metadata does not describe the underlying work's release
across all platforms. Answering the motivating example needs a
source-independent **Game** identity, a non-Steam source, or both. Each of these
reopens a scope decision recorded in the contract and in the
[Steam schema note](steam-game-schema.md).

## Candidate requirements

These are research proposals. None of them is an agreed contract change.

1. **Name lookup.** Resolve a user-supplied title to zero, one, or several
   candidate identities. Ambiguity must be reported, not hidden: return
   candidates and do not guess. Matching rules (aliases, localized titles, fuzzy
   matching) and their abuse and cost profile still need design. The contract
   currently forbids fuzzy and text canonicalization of snapshot fields, and
   that rule stays in force for those fields.
2. **Canonical Game identities.** A curated, source-independent Game that may
   link to zero or more source-specific products (Steam Applications and future
   non-Steam records). Linking must be explicit and source-verified. A Base
   Application link still does not imply grouping.
3. **Non-Steam sources.** Release information for games that have no Steam
   Application. Each source needs the same approved-source gates as Steam:
   source policy, field contracts, storage, redistribution, attribution,
   retention, and correction or deletion rights. Policy matching is not rights
   clearance.
4. **Release status and date first.** The first question type is release timing.
   A Game-level answer must keep **Release Status**, exact date, and **Release
   Window** distinct, and must not invent day precision or infer status from an
   announced date. How per-source release records combine into a Game-level
   answer (per platform, per region, or with conflicting sources) is open.
5. **Distinguishable approved data.** The consumer must be able to tell
   approved, published catalog data apart from anything else it might say (model
   output, producer responses, or its own assumptions). Today every 200 lookup
   is an approved snapshot with provenance (`source_url`, `language`,
   `observed_at`), and a 404 `NOT_FOUND` deliberately does not tell uncataloged
   apart from withdrawn. Any extension must keep that property: no unapproved,
   draft, or inferred data in consumer responses.
6. **Miss handling stays outside this API.** On a miss, the consumer contacts
   the producer, and the producer writes through the existing authenticated
   ingestion and publication routes. This API does not proxy to, queue for, or
   notify the producer, and it adds no consumer write path.

## Constraints confirmed against current docs

Checked against the contract and [architecture](architecture.md) at this
revision, not assumed:

- Every catalog response, errors included, uses `Cache-Control: no-store`. The
  contract forbids a CDN or application cache, read replicas, and request-path
  source fetches ("Never fetch a source URL in an HTTP handler").
- Lookup returns the last approved snapshot, not live source state. It has no
  stale or current flag, TTL, inferred availability, or freshness promise. So a
  consumer cannot treat a hit as "current" and must present it as last-known.
- `no-store` does not revoke consumer-held copies. If the consumer keeps
  answers, for example in chat history or its own cache, it becomes responsible
  for Publication Withdrawal no longer reaching them.
- Consumer reads are anonymous by default. Under **Protected Mode** they need an
  **API Key** with `catalog:read`, which grants no ingestion or publication
  authority ([ADR 0001](../adr/0001-self-hostable-api-key-verification.md)). A
  read-only consumer fits that scope as it stands.

## Open questions

- **News.** News is not catalog metadata: it has no stable per-identity snapshot
  or approved field contract, and it implies history and freshness that the
  contract avoids. Does news belong in this API at all, in a separate service,
  or nowhere? Its rights and retention profile also differs from catalog
  metadata.
- Is the canonical Game identity curated in this repository's data model, and
  who approves links between Games and products?
- Which non-Steam source covers the motivating example, and does it have
  approvable rights?
- Should name lookup be a new public read, a protected-only read, or a
  capability the consumer resolves elsewhere before calling an identity-based
  route?
- What latency and cost budget does a chat-driven read pattern need, given
  primary-only D1 reads and no caching?
- Which consumer-side retention rules keep withdrawn data from being repeated
  after withdrawal?

Any change here needs a design interview, an updated contract, and (for
hard-to-reverse choices such as identity modeling) a small ADR before
implementation.
