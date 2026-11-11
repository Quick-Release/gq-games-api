# Artwork consumer handoff

This is a synthetic local integration guide for the
[normative API contract](artwork-api-contract.md). All source and delivery URLs
use reserved `example.invalid` names. They are illustrations, not approved
sources, usable media, credentials, rights evidence or production configuration.
No site implementation or AMF adoption is included.

## Wire examples

The [fixture directory](fixtures/artwork/) contains request/response pairs with
relative request paths. Use an HTTPS API base URL. Every illustrated response
has a server-owned request ID and `Cache-Control: no-store`.
`synthetic-request-id`, `SYNTHETIC_*` role credentials, generation strings and
integer timestamps are explicit placeholders. In an actual local run, use each
returned generation and an observation time at least as large as **every**
returned authorization floor; do not replay these historical fixture values.

1. [Register an explicit artwork grant](fixtures/artwork/registry.json) through
   `PUT /v1/keys/synthetic-reader` with the registry administrator credential.
   The sample verifier is SHA-256 of the UTF-8 string consisting of 64 `1`
   characters. Its deliberately public sample secret is used in the read
   fixtures; never use it outside synthetic testing. Actual issuance must use a
   high-entropy secret and retain only its verifier. `assets:read` does not
   grant `catalog:read` or either write role. Both artwork reads require it even
   when catalog metadata is anonymous. Grants are checked on each request.
2. [Acquire application and asset authorizations](fixtures/artwork/authorizations.json)
   using the ingestion credential. Both POSTs are bodyless. This initializes
   eligible control but publishes no content. The application generation goes
   into `applications`; the asset generation goes into the
   `X-Publication-Generation` header.
3. [Submit a complete observation](fixtures/artwork/observation.json). The
   separately configured `APPROVED_ARTWORK_SOURCES` binding must be a JSON
   **string** encoding the
   [synthetic policy array](fixtures/artwork/source-policy.json). Provider,
   provenance and rights match exactly; every rendition origin must be listed.
   Blank or malformed policy approves nothing. The current URL validator accepts
   stable HTTPS locations with no query strings, credentials, fragments,
   whitespace, backslashes or parser-repaired paths. No route fetches image
   bytes. Each newer observation replaces all renditions and associations;
   revision strings are opaque. Equal-time identical retries are unchanged;
   equal-time differences conflict. Stale observations cannot replace newer
   content, and every write still needs current authorization.
4. [Resolve a reference](fixtures/artwork/resolution.json) with a server-held
   consumer API key. The result contains the reference, revision, observation
   time, renditions, provenance and rights. It contains no application
   authorizations. Choose an available rendition by its declared dimensions and
   MIME type; do not invent resizing URLs or silently use an unsuitable image.
5. [Enumerate application artwork](fixtures/artwork/pages.json) for an editor's
   picker. These two page examples assume a second independently approved and
   published `synthetic/artwork-2` associated with application 1001; that seed
   observation and its separate exact source policy entry are omitted. JSON
   `next_cursor` is raw `synthetic:artwork-1`. Encode it **once** as the cursor
   query value (`synthetic%3Aartwork-1`), or pass the raw value to
   URLSearchParams. Stop at null. Limits are canonical decimal 1–100,
   default 20. Ordering is provider then asset ID, SQLite binary ascending;
   membership is current on every page. Removed items disappear; insertions
   before the cursor require a restart. Unknown or withdrawn applications yield
   successful empty pages.
6. [Withdraw and reconcile publication](fixtures/artwork/withdrawal.json) with
   the separate publication administrator credential. PUT requires the last
   inspected generation; use administrative GET after a discarded response
   before issuing another command. Global asset withdrawal purges its content
   and links. Application withdrawal removes that application's links; other
   eligible links can keep the asset resolvable. Last-link loss blocks
   resolution. Reinstatement changes generation and restores no content: acquire
   fresh authorization and submit a fresh complete observation. An uncertain
   producer result requires fresh acquisition/resolution or an identical retry
   under still-current generations; never blindly replay under a new generation.

## Site-owned rendering

Persist only the
[stable reference and editorial text](fixtures/artwork/saved-consumer-record.json).
Do not persist provider URLs, rights credit, renditions or resolved metadata in
saved blocks, static shells or attachments as an alternate publication source. A
URL change leaves the saved reference unchanged.

The site owner must implement the following at its runtime/GraphQL boundary:

- Keep the consumer credential on the server. Resolve the saved reference when
  rendering and use only that successful result's selected URL and required
  attribution alongside the site's editorial text.
- On **any** unsuccessful resolution, including 401, 404, 503, network failure
  or invalid response, omit both artwork and provider credit. Do not fall back
  to a previously resolved URL or credit. Unknown, withdrawn and unlinked
  references all return the same 404 `NOT_FOUND`.
- Ensure saved-block, static-shell, GraphQL and page caching paths cannot bypass
  runtime eligibility checks by retaining resolved provider fields. Test these
  paths, reference reuse, URL updates and failure omission in the site
  repository. An optional reused native attachment needs the same reference-only
  semantics and runtime resolution; it does not authorize copying binaries or
  retaining provider metadata.

A read after withdrawal commits cannot return withdrawn content. An already-read
response, emitted URL or previously delivered bytes cannot be recalled. Remote
URLs have no signed renewal, expiry or private-delivery guarantee. API
protection does not make image bytes private. Consumers must not put API
credentials into image URLs or browser delivery requests.

The external, untracked
[site AMF assessment](/data/code/getquick/internal/cooldowngaming.com/docs/research/asset-manager-framework.md)
is read-only research, not a public repository artifact or adoption decision.
Its default stored URL/metadata model is not automatically compatible with this
runtime contract. This guide neither copies that private material nor authorizes
changes to that site.

## Remaining owner handoffs

The source-rights owner must separately approve access, reuse, embedding,
transformations, credit, retention and withdrawal for each real source. Matching
syntactic policy fields enforces configuration; it does not establish clearance.
The private producer owner must supply approved observations, acquire current
application/asset authorizations and reconcile uncertain outcomes. The delivery
owner must approve origin operations, binary caching and withdrawal behavior.
The site owner owns runtime rendering and its acceptance tests. Real ingestion,
private producer changes, infrastructure, deployment and production rollout need
separate approval; these synthetic examples grant none of them.
