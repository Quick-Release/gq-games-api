# WordPress artwork contract

2026-11-10; updated 2026-11-11. **Shared understanding confirmed; specification
and tickets approved and published.** The maintainer approved the discovery
recommendations, explicitly answered Q1–Q8 below and confirmed the resulting
shared understanding. Source-specific rights and delivery approval remain
prerequisites to real-asset rollout. The synthetic local runtime implementation
is covered by the [wire contract](../artwork-api-contract.md) and
[acceptance evidence](../implementation/artwork-progress.md). See
[ADR 0004](../adr/0004-stable-artwork-references.md).

## Historical discovery baseline

The original discovery inspected checkout
`e02bc911c95f84e27dac4d3d670cf4c1230dbd53`. At that baseline, the
[snapshot validator](../../src/services/snapshot.ts),
[database schema](../../src/db/schema.ts) and [HTTP app](../../src/app.ts)
implement application metadata, publication control and key verification, with
no artwork fields, asset service, renditions or binary storage. Existing
snapshot shapes must remain strict and unchanged.

The API is not merely an undeployed local experiment. The
[deployment record](../deployment-record.md) records production revision
`4d01f0983498ab6b8ae2ab33f992a43392de8a3f`, synthetic App ID 1001 and approval
of three Wikidata metadata tuples. The last recorded checks show those real
records unpublished. No live production inspection was performed here.
[ADR 0003](../adr/0003-rights-backed-real-source-tuples.md) approves a metadata
policy mechanism; it does not approve artwork.

Site research was read from
`/data/code/getquick/internal/cooldowngaming.com/docs/research/asset-manager-framework.md`.
It was untracked in the original site checkout at inspection and was not copied
or edited. It pins AMF research to `ec61a75914477bd7d3186e6af2cd1799f497f94d`
but uses older API baseline `7637df2`; the current API findings above supersede
that baseline. The site's research records that AMF creates attachments on
selection, performs non-atomic slug reuse and has untested WPGraphQL behavior.
Its observed latest release predates the WP7 picker fix on master. Adoption
remains undecided; no new upstream release verification is claimed here.

## Approved contract direction

- **Identity:** retain only provider namespace and stable opaque asset ID as the
  reusable reference. Never recycle IDs or derive them from expiring URLs,
  rendition sizes, post IDs or changing content. Revisions describe changes to
  content or metadata independently of asset identity. Equal bytes under
  different references are not automatically the same asset.
- **Discovery:** enumerate the permitted assets associated with an already
  selected Steam App ID, with bounded pagination. A Steam Application remains
  distinct from a canonical Game. No global search is required by this scope or
  by AMF itself.
- **Resolution:** resolve a saved reference independently of enumeration and
  return the currently permitted representation. No consumer-triggered
  collection, upstream request-path fetch or write path is introduced.
- **Renditions:** expose only explicitly available remote representations, each
  with URL, MIME type, width, height and a revision-aware identity. Arbitrary
  cropping/resizing is not promised. Exact roles, dimensions and payload syntax
  are still to be agreed.
- **Rights and credit:** require provenance, rights holder, permission/license
  reference and required attribution. Source approval must cover delivery,
  embedding, transformations, reference/control retention and withdrawal.
  Unknown permission denies publication. A source URL is not permission.
- **Updates:** the reference survives URL or metadata changes; consumers resolve
  again for the latest approved revision. Provider ID replacement requires
  explicit handling rather than silently aliasing unrelated assets.
- **Withdrawal:** withdrawn assets disappear from enumeration and cannot resolve
  to usable metadata. Reinstatement must not restore old authorization silently.
  The confirmed shared-association rules below govern application withdrawal.

## Boundaries requiring detailed agreement

The existing [catalog contract](../steam-catalog-contract.md) keeps all catalog
responses, including errors, `no-store`, forbids caches/replicas and forbids
request-path source fetches. Do not put asset data into its snapshot or add
caching to make a picker work. Retention of minimal references needs its own
approved policy; persisting a copied response is not that policy.

Binary delivery needs an approved remote origin and a separately agreed URL,
expiry, caching and revocation policy. No new R2 bucket, proxy, image service or
cloud resource is selected. Browser image requests must never contain catalog
API credentials. A stable reference does not guarantee a permanent URL.

API withdrawal cannot recall bytes or third-party URLs already received. Set the
consumer refresh/failure policy and the origin's withdrawal obligation before
promising an end-to-end withdrawal deadline. Saved HTML, attachments, GraphQL
results and frontend build output can each retain old URLs.

[ADR 0001](../adr/0001-self-hostable-api-key-verification.md) defers media
scopes. The approved extension is a separate `assets:read` scope, with
protected-only enumeration and resolution initially. `catalog:read` stays
metadata-only and existing anonymous lookup is unchanged. The Principal type,
registry validation and D1 scope constraint currently accept only
`catalog:read`; future work must extend all three additively through reviewed
Alchemy-owned migrations. Existing keys acquire no new grants. Existing
ingestion/admin authentication remains role-separated. Disclosed remote image
URLs are publicly retrievable; this is not private binary delivery.

## Decisions confirmed on 2026-11-11

The maintainer explicitly selected the recommended answer to each question:

1. **Durable URLs:** remote URLs without expiry/renewal in the first contract,
   subject to approved rights and origin operation. Durable does not mean
   permanent, immutable or irrevocable.
2. **Fresh resolution:** establish eligibility before rendering; omit artwork on
   resolution failure or unestablished eligibility. Fresh means a new check
   against the API's last approved publication state, not a live upstream fetch.
3. **Separate scope:** `assets:read` for protected artwork reads, with no
   implied grant from `catalog:read`.
4. **Protected first:** require that grant for enumeration and resolution;
   initially expose no anonymous artwork metadata endpoint.
5. **Runtime rendering:** saved content and static shells hold references,
   resolving at request/view time before emitting image URLs. Static image URLs
   refreshed only by a later build are not selected. Site runtime work belongs
   to the site session; no browser receives its API key.
6. **Independent withdrawal:** ending one application's associations does not
   globally withdraw a shared asset. Direct resolution needs at least one
   eligible association plus global asset eligibility. Asset Withdrawal blocks
   all associations. Application or asset reinstatement cannot restore old
   authorization automatically; former links must not become valid merely
   because an application is eligible again.
7. **Minimal persistence:** consumers retain the reference and their own
   editorial text. Provider responses, URLs and attribution are resolved afresh.
   Consumer reference and API tombstone/control retention require rights-policy
   permission; no provider-content archive or withdrawal-reason history is
   implied.
8. **Available renditions:** require at least one declared rendition for a
   published asset, but no fixed size set. Consumers choose an available
   rendition or omit the image. No automatic crop/resize or oversized fallback
   is promised.

These decisions constrain any optional AMF adapter: its stored URL/metadata
behavior does not automatically meet the selected retention/rendering policy.
The site must prove a compatible integration before adopting it.

## Primary source rights and delivery checks

Checked 2026-11-11, without fetching real artwork or calling production.

- [Valve Web API terms](https://steamcommunity.com/dev/apiterms), sections 1–2
  and 9, tie the license to the identified application and personal-use end-user
  distribution, retaining ungranted rights. This does not establish approval of
  this proposed artwork redistribution service.
- [Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) applies
  CC0 to structured data. That policy is not a grant for artwork linked by a
  data statement. Existing approved Wikidata metadata records therefore do not
  clear image rights.
- [Steam graphical asset documentation](https://partner.steamgames.com/doc/store/assets)
  describes multiple store/library roles and dimensions. Its
  [artwork override documentation](https://partner.steamgames.com/doc/store/assets/overrides)
  describes temporary marketing artwork. Inference: source artwork is mutable;
  documented formats alone establish neither a durable third-party URL contract
  nor reuse permission. No source size is made mandatory for this API.
- [RFC 9111 section 5.2.2.5](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5)
  prohibits caches from storing/reusing a no-store response. API metadata and
  remote image bytes are separate responses. Inference: the API's header alone
  cannot set the origin's binary caching policy or remove saved HTML.

No inspected policy approves specific artwork for this service. An origin must
be approved for external embedding, intended service/consumer uses, supported
renditions, change handling and withdrawal. Binary caching/revocation terms must
be recorded with it; no end-to-end deadline is promised before that exists.
These are evidence/rollout gates, not approvals inferred from a reachable URL.

## Acceptance criteria for future implementation

1. Existing metadata routes, strict payloads, source approval, authentication,
   request IDs, no-store behavior and publication semantics remain unchanged.
2. Synthetic fixtures prove namespace collision isolation, stable references
   across URL/revision changes, no ID reuse and independent rendition identity.
3. Per-application enumeration is bounded and agrees with direct resolution on
   eligibility, provenance, revisions and available renditions. Unknown and
   withdrawn assets do not disclose private publication state.
4. New reads begun after withdrawal commits cannot expose the withdrawn asset.
   Concurrent publication/update/withdrawal and reinstatement cannot revive old
   authorization. Already-read responses have an explicitly bounded claim,
   consistent with the catalog's existing in-flight limitation.
5. Delivery fixtures cover unavailable sizes, URL changes/expiry and credit
   requirements under the selected origin policy. Real binaries are excluded.
6. Enumeration and resolution require `assets:read` and fail closed. Old
   metadata-only keys gain no artwork rights; existing anonymous metadata reads
   remain unchanged. Browser delivery contains no management or catalog bearer
   secrets.
7. Meaningful D1 behavior/race tests run in local workerd through
   `pnpm test:integration`; Node doubles alone establish no binding guarantees.
8. Site acceptance proves reference reuse without binary imports. If AMF is
   adopted, additionally prove concurrency-safe attachment reuse, provider ID
   isolation, URL/metadata refresh, editor behavior and actual WPGraphQL fields.
9. Site-owned saved/static fixtures contain references and editorial text;
   runtime rendering omits URLs/credit on failed resolution. No stale provider
   response is used to fill a failed read. Already emitted content is outside
   the new-read visibility guarantee.
10. Synthetic shared-asset fixtures prove that withdrawing application A does
    not revoke an asset still authorized through B, but withdrawing the asset
    blocks both. Withdrawing the last eligible association blocks direct
    resolution; reinstating A does not restore its old association.

## Ownership and dependency handoff

| Owner                                    | Responsibility                                                                                         | Dependency                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Games API                                | Stable identity, enumeration/resolution, eligibility enforcement and synthetic contract tests          | Confirmed access, rights, delivery and withdrawal contracts            |
| Source-rights owner and private gq-crawl | Recorded asset-specific permissions, approved records and producer observations                        | Exact permitted fields, renditions, retention and publication protocol |
| Site                                     | Reference persistence, article reuse, optional attachment adapter, GraphQL and rendered-output refresh | Stable API contract and permitted delivery                             |
| Service/delivery owner                   | Origin operation, credentials, availability and binary withdrawal                                      | Explicit origin selection, rights and operational approval             |

All repository changes stay here. Site and producer implementation belong to
their assigned sessions. No source approval, deployment or production change
follows from the design approval.

## Specification boundary

The policy frontier Q1–Q8 is settled and shared understanding was explicitly
confirmed on 2026-11-11. The [specification](../artwork-reference-spec.md)
synthesizes the agreed requirements. The composed HTTP/workerd/D1 test boundary
and four-ticket dependency graph were explicitly approved and published as
[specification #19](https://github.com/Quick-Release/gq-games-api/issues/19) and
[tickets #20–#23](artwork-ticket-breakdown.md). Record exact payload/route
shapes, limits, pagination, publication fencing and error behavior within these
decisions before implementation. Use the approved composed HTTP boundary backed
by local workerd/D1 as the API acceptance seam, and site-owned runtime rendering
tests for consumer behavior.

Rights evidence and a viable delivery origin remain prerequisites to real-asset
rollout. Synthetic contract implementation may be specified independently after
design confirmation. No particular external provider is selected, and no
deployment, real ingestion, site modification or private producer work is
authorized by this document.
