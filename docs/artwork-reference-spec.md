# Stable artwork references for remote consumers

Published specification:
[issue #19](https://github.com/Quick-Release/gq-games-api/issues/19). The
[approved ticket breakdown](research/artwork-ticket-breakdown.md) records the
four child issues and their native dependencies.

**Approved specification and testing boundary.** Shared understanding, the
HTTP/workerd/D1 acceptance boundary and the four-ticket breakdown were
explicitly approved on 2026-11-11. This specification covers a synthetic, local
API implementation and the consumer contract handed to other owners. Publication
does not authorize real artwork ingestion, production changes or implementation
in another repository.

## Problem Statement

Editors need to reuse artwork associated with a Steam Application across game
records and articles without copying binaries or creating attachments for every
catalog entry. The current API serves application metadata only. URLs and
WordPress attachment IDs cannot provide stable cross-consumer artwork identity,
and retained image URLs can outlive publication permission.

## Solution

Add a separate artwork capability that enumerates permitted assets for a known
Steam Application and resolves an individual stable Asset Reference. All artwork
metadata reads require `assets:read`. Consumers keep references and their own
editorial text, resolving approved remote renditions and attribution at render
time. Resolution failures omit artwork. Existing application metadata contracts
remain unchanged.

## User Stories

1. As an editor, I want artwork for a selected Steam Application, so that I can
   choose without searching a global catalog.
2. As an editor, I want to reuse the same Asset Reference in several articles,
   so that selecting it does not duplicate the binary or asset identity.
3. As a consumer, I want provider namespaces to isolate asset IDs, so that
   identical IDs from different providers cannot collide.
4. As a consumer, I want identity independent of URL and rendition, so that URL
   changes do not require replacing references throughout saved content.
5. As an editor, I want my own editorial text to survive asset updates, so that
   publication metadata refresh does not overwrite local writing.
6. As a consumer, I want bounded per-application enumeration, so that a large
   collection does not require an unbounded response.
7. As a consumer, I want direct reference resolution, so that rendering does not
   require enumerating an application's assets.
8. As a site operator, I want artwork metadata reads protected separately, so
   that existing metadata keys do not acquire artwork permissions.
9. As a self-hoster, I want existing anonymous application lookup preserved, so
   that the new capability does not change my current consumer access mode.
10. As a key administrator, I want to grant and revoke artwork access
    explicitly, so that registry changes have the existing per-request
    enforcement behavior.
11. As a consumer, I want declared rendition URLs, MIME types and dimensions, so
    that I select a representation actually available from the approved origin.
12. As a consumer, I want missing suitable renditions to omit the image, so that
    I do not silently download an oversized original or invent transformations.
13. As a rights owner, I want permission, provenance and required credit to
    travel with permitted asset metadata, so that consumers can meet the
    recorded terms.
14. As a service owner, I want unapproved asset observations rejected, so that
    metadata source approval cannot authorize unrelated artwork publication.
15. As a consumer, I want fresh eligibility checks before emitting image URLs,
    so that retained responses do not override withdrawal.
16. As a site operator, I want saved content and static shells to hold
    references, so that runtime rendering can hide artwork without waiting for a
    rebuild.
17. As an application publication administrator, I want withdrawing application
    A to end its associations, so that assets still authorized through B can
    remain available.
18. As an asset publication administrator, I want global Asset Withdrawal to
    block every association, so that a shared asset cannot escape its own
    withdrawal.
19. As a rights owner, I want reinstatement to require fresh authorization, so
    that old observations and associations do not silently reappear.
20. As an operator, I want synthetic HTTP/workerd acceptance evidence, so that
    local guarantees are demonstrated without ingesting real artwork or touching
    cloud state.

## Implementation Decisions

1. Asset Reference identity is provider namespace plus opaque stable asset ID.
   Never recycle IDs. A URL, post ID, rendition or revision is not asset
   identity; identical bytes under different references are not automatically
   deduplicated.
2. Add separate asset metadata, rendition, association and publication-control
   persistence in the existing D1 database. Keep strict metadata snapshots
   unchanged. Infrastructure remains owned by Alchemy, HTTP by Hono and
   application behavior by Effect; use the pinned native Effect D1 integration.
3. Extend the Verification Registry, Principal validation and D1 scope
   constraint additively for `assets:read`. Allow explicit metadata-only,
   artwork-only and combined grants without widening any existing grant.
   Registry management retains its existing credential and per-request
   revocation semantics.
4. Enumeration and resolution are protected even when application metadata is
   anonymous. Missing/invalid/expired/revoked/insufficient credentials share the
   existing sanitized rejection convention. Verification failures fail closed.
5. Enumeration accepts a canonical Steam App ID and bounded pagination. It
   exposes only eligible Artwork Associations and assets. Direct resolution
   exposes an asset only while globally eligible and authorized through at least
   one eligible association. Neither operation fetches upstream content.
6. A permitted representation contains Asset Reference, revision, available
   renditions, rights holder, permission/license reference, provenance and
   required attribution. Each rendition declares URL, MIME, width and height.
   Missing required rights evidence or an empty rendition set denies
   publication.
7. URLs are durable remote HTTPS delivery locations without expiry/renewal in
   this version. They are not guaranteed permanent or immutable. Browser
   delivery contains no API credentials. Publicly disclosed URLs do not
   constitute private binary delivery; image caching and revocation depend on
   approved origin terms.
8. Source approval for artwork is separate from metadata tuple approval. It must
   cover access, service/consumer reuse, embedding, transformations, required
   credit, reference/control retention, updates and withdrawal. Configure no
   real asset source as part of this synthetic implementation.
9. Asset content/metadata revisions change independently of identity. Apply only
   complete approved observations; stale or conflicting writes must not replace
   newer approved state. Repeated identical delivery is safe without asserting
   an event ledger or exactly-once delivery.
10. Asset writes use authenticated producer/admin boundaries with the existing
    role separation. Consumer grants never authorize writes. Acquire/check
    publication authorization before accepting observations and fence writes
    against intervening withdrawal. Successful writes return after atomic
    commit; uncertain outcomes require reconciliation, consistent with existing
    policy.
11. Global Asset Withdrawal removes publishable provider content and invalidates
    old authorization across all associations. Retain only permitted minimal
    identity/state/generation/time control; no content archive or reason
    history.
12. Application withdrawal ends its associations without globally withdrawing an
    asset still authorized elsewhere. Fence associations against application and
    asset generation changes, so that reinstatement cannot reactivate old links.
    Extending application withdrawal must preserve its existing response and
    atomic snapshot deletion guarantees.
13. Reads include publication checks in the primary query. A read begun after a
    withdrawal commits cannot return withdrawn artwork. Already-read/in-flight
    responses and previously delivered bytes cannot be recalled.
14. Artwork metadata responses, including errors, are no-store with server-owned
    request IDs and sanitized errors. Do not add caches, read replicas or
    request-path source fetches. Unknown and withdrawn references expose the
    same public absence behavior. Reuse existing bounded request/cancellation
    behavior.
15. Consumers persist only references and their own editorial text. Runtime
    resolution provides URLs and required credit; failed resolution emits
    neither. Rendering saved blocks or static shells must not reuse stored
    provider data. Site implementation and its server-held API credential remain
    site-owned.
16. Before code or SQL changes, record the bounded wire contract: versioned
    enumeration/resolution and role-separated write routes, strict payload
    fields, identifier/URL limits, page ordering/cursors, revision comparison,
    generation conflicts, error/status mappings and reconciliation responses.
    Use existing API conventions without changing the approved policies. Review
    generated SQL before application; Alchemy alone owns migration
    execution/history.

## Testing Decisions

**Approved acceptance boundary:** exercise the composed HTTP application backed
by local workerd/D1, extending the existing catalog fixture pattern. Test
observable requests, responses and committed state rather than Effect/Drizzle
implementation details. Use unit tests only where pure validation or
deterministic failure mapping warrants a focused check.

- Exercise the registry through its authenticated HTTP boundary and prove old
  rows/grants survive migration. Artwork-only keys cannot read protected catalog
  metadata, and metadata-only keys cannot enumerate or resolve assets.
- Publish synthetic observations through the producer boundary, then resolve and
  enumerate with explicit grants. Prove namespace isolation, URL/revision
  changes, bounded pagination and valid renditions/credit.
- Use coordinated concurrent HTTP operations and actual D1 commits to prove
  global withdrawal, application withdrawal, last-association loss, stale writes
  and reinstatement. Include the already-read response limitation explicitly.
- Preserve existing metadata/access/source-policy/cancellation regression
  suites. Demonstrate denied operations leave committed content/control
  unchanged.
- Use only synthetic content and reserved example.invalid source/delivery URLs;
  tests never request image bytes or upstream sources. Node doubles do not
  establish D1 or Cloudflare binding guarantees.
- The site owner separately tests runtime resolution, reference reuse, omitted
  URLs on failure and reference-only saved/static output at its
  rendering/GraphQL boundary. This repository supplies the contract and
  fixtures, not site code.
- Run format, check, lint, unit tests, offline build and local workerd
  integration for behavior changes; validate generated migrations through
  existing tooling.

## Out of Scope

- Real artwork ingestion, deployment, cloud state bootstrap or infrastructure
  provisioning; source permissions are not supplied by this specification.
- Canonical Game identities, global search, binary imports/storage/proxying,
  automatic resizing/cropping, expiring URLs or URL-renewal machinery.
- Anonymous artwork metadata reads, private image-byte delivery, new commercial
  quotas/pricing or changes to existing application metadata payloads/access.
- Site or private producer implementation in this checkout; AMF adoption and
  runtime compatibility certification; attachment creation/deduplication logic.
- Guaranteed recall of emitted URLs/bytes or an end-to-end withdrawal deadline
  before an approved origin and consumer delivery policy can support it.

## Further Notes

API scope: synthetic local contract implementation and owner handoff. The source
owner/private producer supplies independently approved records and observations;
the site owns references, GraphQL and runtime rendering; the delivery owner
supplies approved origin operations and binary caching/withdrawal terms. Real
rollout depends on all of these and explicit operational approval.

The supplied AMF assessment is read-only research at
`/data/code/getquick/internal/cooldowngaming.com/docs/research/asset-manager-framework.md`,
untracked in the original site checkout when inspected. It is not an adoption
decision. AMF's default retained URL/metadata behavior needs reconciliation with
this consumer contract before a site adapter can be accepted.

The approved slices are protected synthetic publish/resolve/withdraw;
per-application browsing; shared-asset updates and withdrawal races; and
composed lifecycle verification with the consumer handoff. Browsing and
shared-asset work each depend on the first slice; lifecycle verification depends
on both. External owner handoffs do not authorize creating tickets or making
changes in their repositories.
