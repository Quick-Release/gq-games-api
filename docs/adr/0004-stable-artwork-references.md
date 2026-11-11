# ADR 0004: Stable artwork references for remote consumers

- **Status:** Accepted; synthetic local implementation complete, real source
  approval pending
- **Date:** 2026-11-10
- **Deciders:** repository maintainer, approving the asset discovery
  recommendations
- **Updated:** 2026-11-11, following explicit answers to design questions Q1–Q8

WordPress consumers need to reuse artwork without copying binaries or creating
an attachment for every catalog entry. Consumers will identify an Artwork Asset
by provider namespace and opaque stable ID, independently of delivery URL,
rendition, content revision and WordPress attachment. IDs must never be
recycled. This avoids turning URL rotation or selection from another article
into a new asset identity; it does not promise deduplication of identical bytes.

The first asset contract will enumerate assets for an already selected Steam
Application and resolve individual Asset References. Global catalog search and
canonical Game grouping are deferred. Artwork remains separate from the strict
metadata snapshot contract. AMF adoption is a site decision, not a prerequisite.

Artwork enumeration and resolution initially require a separate `assets:read`
scope. Existing keys keep their current grants and anonymous application lookup
is unchanged. Browser image delivery uses permitted durable remote URLs, without
catalog credentials or expiring signed URLs in the first contract. Protected
metadata does not make disclosed image URLs private.

Consumers persist Asset References and their own editorial text, resolving
artwork afresh before emitting image URLs. Unavailable eligibility hides the
artwork. Saved content and static page shells therefore require runtime
resolution; retained URLs, copied provider metadata and periodic rebuilds are
not the selected consumer policy. This imposes a site integration requirement
and does not establish AMF compatibility or adoption.

Application withdrawal ends that application's Artwork Associations. An asset
may remain resolvable through another eligible association; Asset Withdrawal
blocks all associations. Reinstatement must not revive old authorization. A
published asset has at least one explicitly available rendition, without
mandatory fixed sizes or automatic transformations/fallbacks.

Metadata remains subject to the existing no-store boundary. Actual asset rights,
reference/control retention permission and the delivery origin remain approval
gates. Existing metadata source approvals grant no artwork rights. The
[contract proposal](../research/wordpress-artwork-contract.md) records the
acceptance criteria and dependencies. The maintainer explicitly confirmed shared
understanding on 2026-11-11 and authorized the specification/ticket workflow,
subject to its review gates. This ADR changes no runtime contract and authorizes
no real ingestion or deployment.
