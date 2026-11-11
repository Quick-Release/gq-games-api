# Artwork API v1 normative contract

This normative contract specifies the approved synthetic boundary of #19–#23.
Only the registry scope prerequisite is implemented in this change. Asset
routes, persistence, lifecycle and their acceptance evidence remain
unimplemented. Existing metadata wire contracts and role credentials continue to
apply. No real source or delivery origin is approved by this document.

All routes require HTTPS, return `Cache-Control: no-store` and server-generated
`X-Request-ID`; errors use `{error:{code,request_id}}`. JSON bodies use the
existing 32 KiB actual-byte limit, strict UTF-8 and phase-aware cancellation.
Unknown fields are rejected at every object boundary. No request fetches bytes.

## Routes and authorization

- `GET /v1/assets/{provider}/{assetId}` resolves an eligible reference.
- `GET /v1/steam/applications/{steamAppId}/assets?limit=20&cursor=...`
  enumerates eligible associations. Both reads always require `assets:read`,
  even in anonymous catalog mode. Registry management accepts empty,
  metadata-only, artwork-only and combined grants; grants never imply roles.
- `POST /internal/v1/assets/{provider}/{assetId}/ingestion-authorization` uses
  the existing ingestion credential and no body. It initializes eligible asset
  control once and returns generation and minimum observation time.
- `PUT /internal/v1/assets/{provider}/{assetId}/observation` uses that
  credential, `X-Publication-Generation`, and the complete observation below.
- `GET /internal/v1/assets/{provider}/{assetId}/publication` and `PUT` at that
  path use the existing publication administrator credential. PUT strictly
  accepts `{state,expected_generation}` as application publication does. GET
  reconciles discarded administrative responses.

Provider and asset ID match `[A-Za-z0-9_-]{1,128}`. App IDs are canonical
decimal integers 1–4294967295. Identity is the pair and is never recycled.
Rendition, revision, URL, or identical bytes do not create or merge identities.

## Complete observations

Fields are `revision` (nonblank string, at most 128 characters), `observed_at`
(nonnegative safe integer seconds), `renditions` (1–16 items), `provenance`,
`rights`, and `applications` (1–32 unique application authorizations). Each
rendition strictly contains `id` (identifier), `url` (HTTPS, at most 2048
characters, no credentials or fragment), `mime` (`image/png`, `image/jpeg`,
`image/webp`, or `image/avif`), `width` and `height` (integers 1–32768).
Rendition IDs are unique. Provenance strictly contains `source_url` (same URL
rules) and `extractor_version` (nonblank, at most 128 characters). Rights
strictly contain `holder`, `permission`, and `attribution` (nonblank, at most
2048 characters each). Applications strictly contain `steam_app_id` and
`generation` (nonblank, at most 128 characters). Application authorizations are
acquired through the existing application ingestion authorization route.

Artwork source approval is independent of snapshot tuples.
`APPROVED_ARTWORK_SOURCES` is a JSON array of at most 64 strict objects with
`provider`, `source_url`, `extractor_version`, `rights` (the exact object
above), and `delivery_origins` (1–16 distinct HTTPS origins without paths). The
configured artwork policy must exactly match provider, provenance, rights and
delivery origins; malformed or missing configuration approves nothing. Synthetic
tests use only reserved example.invalid locations. Approval must separately
establish access, reuse, embedding, transformations, credit, retention and
withdrawal.

An observation replaces the complete rendition and association sets atomically.
Its timestamp must meet both asset and application generation floors. A newer
observation supersedes current content; older observations are ignored without
mutation. Equal timestamp plus identical canonical payload is an unchanged
retry; equal timestamp with different content is a conflict. Revision strings
are opaque, not lexical sequence numbers. URL changes require a newer complete
observation and leave identity unchanged.

## Lifecycle and reconciliation

Control, deletable content and associations are separate. Writes atomically
check asset and every application generation/state on the primary. Global
withdrawal purges content and all associations, retaining only identity, state,
generation and issue time. Application withdrawal atomically deletes its links
with its metadata snapshot. Other eligible links remain usable. Last-link loss
blocks resolution. Reinstatement changes generation and restores no content or
links. Fresh acquired authorization and a complete observation are required.

Success is returned only after commit. Discarded producer responses are
reconciled by fresh acquisition and resolution, or an identical retry under
still-current generations; an authorization failure requires reacquisition and
fresh approval, never blind replay under a replacement generation. Discarded
admin responses are reconciled with administrative GET before another command.

## Pages, errors and visibility

Limit is canonical decimal 1–100, default 20. Pages sort by provider then asset
ID in SQLite binary ascending order. Cursor is the last returned pair encoded as
a URI component of `provider:assetId`; it is exclusive and scoped to the
requested application. Invalid/unknown query fields, repeated query parameters,
malformed cursor and invalid bounds yield 422. Pages return
`{items,next_cursor}`; `next_cursor` is null when exhausted. Current membership
is queried on every page. There is no snapshot across pages: removals disappear
and insertions before the cursor require restarting enumeration. Each item
matches resolution. Unknown/withdrawn/unlinked references yield the same 404
`NOT_FOUND`; empty application pages are successful, including unknown/withdrawn
applications.

Missing, invalid, expired, revoked or insufficient read credentials yield 401
`UNAUTHORIZED`. Registry unavailability fails closed with 503. Role mismatch
is 403. Invalid JSON is 400, invalid strict payload is 422, unsupported media is
415, oversized body is 413, cancellation is 408. Unapproved sources yield 403
`SOURCE_NOT_APPROVED`. Generation/state conflicts yield the existing 409
publication error codes; equal-time differences yield 409 `SNAPSHOT_CONFLICT`.
Unexpected errors are sanitized 500; known temporary database failures are 503.

Eligibility is part of each primary content query. A new read after withdrawal
commit cannot reveal withdrawn content. An already-read response, emitted URL or
previously delivered bytes cannot be recalled. Durable remote URLs have no
signed renewal, expiry guarantee, private delivery guarantee or API credentials.
Protected metadata does not make public image bytes private.

Consumers persist references and their editorial text only. Runtime resolution
must omit artwork and credit on failure; static/saved shells must resolve at
render time. The site owner implements and tests this; no AMF adoption follows.
Rights, retention, origin operations and deployment approval remain rollout
blockers, not synthetic implementation gates.
