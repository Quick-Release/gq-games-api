# Steam application catalog contract

## Status and scope

**Agreed design; partially implemented under issues #2–#4.** Authorization
acquisition POST, publication inspection GET, complete snapshot PUT, and
anonymous public lookup GET now exist, backed by separate durable
control/snapshot tables and synthetic local workerd tests. `/` and process-only
`/health` are preserved. Publication PUT remains unimplemented.

This contract records the HTTP, payload, and atomic-persistence decisions
confirmed in the design interview. Issues #2–#4 authorize these four operations,
reviewed migrations, local configuration, and synthetic local verification, not
real collection, cloud provisioning, or deployment. Descriptions of the
remaining operations below are requirements, not claims of implemented behavior.

The initial consumer task is lookup by Steam App ID. Admit verified Game, Demo,
and DLC applications; no canonical Game identities, editorial editions, search,
listing, cross-app atomic ingestion, or patches. Players, histories, reviews,
ratings, followers, rankings, prices, and ownership estimates remain excluded,
including indirect retention in raw payloads or metadata blobs.

Use the [glossary](../GLOSSARY.md) and
[Steam research/design note](research/steam-game-schema.md). Initial fixtures
must be synthetic. Real publication additionally requires approved source-field
contracts and access, storage, redistribution, attribution, and retention
rights.

## HTTP boundary

### Routes and roles

Each `{steamAppId}` is a canonical decimal integer from `1` to `4294967295`,
without signs, whitespace, leading zeroes, or alternative numeric notation. App
IDs inside JSON are numbers in the same range, not strings.

| Method and route                                                            | Authorization     | Purpose                                                     |
| --------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| `GET /v1/steam/applications/{steamAppId}`                                   | Anonymous         | Last-known approved application snapshot                    |
| `PUT /internal/v1/steam/applications/{steamAppId}/snapshot`                 | Ingestion         | One complete snapshot, synchronous persistence outcome      |
| `POST /internal/v1/steam/applications/{steamAppId}/ingestion-authorization` | Ingestion         | Obtain the current publication generation before collection |
| `GET /internal/v1/steam/applications/{steamAppId}/publication`              | Publication admin | Inspect publication control, including uninitialized state  |
| `PUT /internal/v1/steam/applications/{steamAppId}/publication`              | Publication admin | Generation-checked withdrawal or eligibility transition     |

The `/internal` prefix provides no protection by itself. Private routes require
`Authorization: Bearer <credential>`. Use separate, independently rotatable
opaque ingestion and admin credentials supplied through Worker secrets. Neither
role grants the other role's routes. Require HTTPS outside local tests. Missing
required write configuration fails closed; never store credentials in JSON, SQL,
fixtures, logs, or the repository.

Authenticate private requests before parsing their payloads. A syntactically
valid App ID or a successful authorization acquisition is not proof of product
type, field correctness, or source rights.

### Common transport behavior

- All these responses, including errors, use `Cache-Control: no-store`. Do not
  introduce a CDN/application cache, read replicas, or request-path source
  fetches.
- Generate a server-owned request ID and return it as `X-Request-ID` on every
  response. Do not treat a caller-supplied ID as the server's correlation
  identity.
- JSON request bodies are uncompressed UTF-8 `application/json`, with at most 32
  KiB of body bytes. Unsupported content encoding or media type is rejected;
  oversized bodies must be bounded while reading, not merely by trusting
  `Content-Length`.
- Authorization acquisition has no body. Snapshot and publication PUTs require
  JSON objects. Reject unknown JSON fields throughout these objects.
- Successful writes respond only after their atomic database operation commits.
  There is no asynchronous acceptance or delivery-status endpoint.

## Full snapshot payload

App ID belongs only to the route. The required top-level fields are `event_id`,
`metadata`, and `provenance`. All fields shown below are required; nullable
fields must be present with an explicit `null` when unknown.

This is an illustrative synthetic payload, not an upstream record or seed:

```json
{
  "event_id": "synthetic-delivery-1",
  "metadata": {
    "title": "Synthetic Demo",
    "product_type": "demo",
    "base_app_id": 2001,
    "developers": ["Synthetic Developer"],
    "publishers": null,
    "supported_os": ["windows"],
    "release": {
      "status": "upcoming",
      "date": { "kind": "window", "window": "Q4 2030" }
    }
  },
  "provenance": {
    "source_url": "https://catalog.example.invalid/apps/1001",
    "language": "en",
    "observed_at": 100,
    "extractor_version": "synthetic-v1"
  }
}
```

The illustrative observation time is valid only against appropriate synthetic
publication control and clock values. Never fabricate production timestamps from
examples, release dates, scrape-cache timestamps, or relative page ages.

### Metadata and validation

String limits count Unicode code points. Strings must be nonblank and have no
leading/trailing whitespace; reject violations rather than silently trimming.
Preserve internal whitespace, case, Unicode spelling, and source credit order.

| Field                                        | Accepted values and bounds                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `event_id`                                   | Nonblank string, at most 128 characters; delivery identity only                                 |
| `metadata.title`                             | Nonblank string, at most 512 characters                                                         |
| `metadata.product_type`                      | `game`, `demo`, or `dlc`, explicitly source-verified                                            |
| `metadata.base_app_id`                       | Null or a different valid numeric App ID; must be null for `game`                               |
| `metadata.developers`, `metadata.publishers` | Null or at most 32 unique nonblank names, each at most 256 characters                           |
| `metadata.supported_os`                      | Null or a unique subset of `windows`, `macos`, `linux`                                          |
| `metadata.release.status`                    | `upcoming`, `released`, or `unknown`, separately source-verified                                |
| `provenance.source_url`                      | Approved HTTPS source URL, at most 2048 characters; no credentials or secret-bearing components |
| `provenance.language`                        | Exactly `en`; no implicit translation                                                           |
| `provenance.observed_at`                     | Nonnegative integer UTC Unix seconds, no more than 300 seconds ahead of the server clock        |
| `provenance.extractor_version`               | Nonblank string, at most 128 characters                                                         |

Release date is exactly one of these strict tagged objects:

```json
{ "kind": "exact", "date": "2030-04-12" }
```

```json
{ "kind": "window", "window": "Q4 2030" }
```

```json
{ "kind": "unknown" }
```

Exact dates must be real calendar dates in `YYYY-MM-DD` form; no invented time
of day. Windows are nonblank source-supplied text of at most 256 characters;
never manufacture a calendar day from them. Date precision and release status
are independent: an upcoming application may have an exact announced date, and
passing that date does not automatically make it released.

Null means unknown; an empty list means explicitly verified none. Base links
must be source-verified, need not point to a cataloged application, and do not
create canonical Game grouping. A missing relationship does not exclude an
otherwise valid Demo or DLC. Duplicate credit names use exact string equality;
there is no fuzzy company identity resolution.

### Approved-source boundary

A valid ingestion credential does not approve arbitrary source content.
`source_url` and `extractor_version` must match an explicitly configured,
approved source policy. With no matching policy, reject ingestion without
changing the snapshot. Matching a URL is an enforcement mechanism, not legal
approval: each real policy must cover all included fields and their access,
storage, public redistribution, attribution, retention, and deletion
obligations.

Use only reserved synthetic sources and synthetic extractor policies in initial
fixtures. Never fetch a source URL in an HTTP handler. All snapshot fields come
from one approved observation/source/language; no patches, mixed-source values,
raw payload retention, or hidden excluded datasets.

### Equal-time snapshot equality

Compare decoded `metadata` and `provenance`, excluding only `event_id`:

- JSON object-key order and equivalent JSON string escapes do not matter.
- Canonicalize OS arrays into lexicographic code order; their input order does
  not matter. Duplicate OS entries are invalid, not silently deduplicated.
- Developer/publisher ordering matters; duplicate names are invalid.
- Null differs from an empty list. All release fields participate.
- Source URL spelling, extractor version, case, internal whitespace, and Unicode
  spelling participate without fuzzy or text/URL canonicalization.

Consequently a different delivery event ID alone is a no-op, while a different
source URL or extractor version at the same observation time is a conflict.
Preserve the stored event ID on no-op, conflict, stale, or denied ingestion. Do
not require event-ID uniqueness across apps and do not claim a replay ledger or
exactly-once delivery processing.

## Publication authorization and lifecycle

### Durable control

Retain minimal publication control separately from deletable metadata:

- Steam App ID;
- state: `eligible` or `withdrawn`;
- current opaque, server-generated publication generation;
- that generation's server-issued integer UTC Unix-second timestamp.

`uninitialized` is the API representation of no control record, not a stored
third state. Eligible means publication is authorized; it does not mean metadata
exists, source rights are approved, or an application has been released.

Retain no source content or withdrawal reason in this minimal control. There is
no control expiry or forget operation initially. Real publication is blocked
unless the rights/retention policy expressly permits this control retention. If
it does not, deletion alone cannot prevent republishing; an alternative approved
durable authority requires a new design.

### Acquire, then collect, then submit

Authorization POST atomically initializes control as eligible only if absent, or
returns existing eligible control without advancing its generation. It must
never lift withdrawal. Return HTTP 200:

```json
{
  "data": {
    "steam_app_id": 1001,
    "generation": "opaque-server-issued-generation",
    "minimum_observed_at": 90
  }
}
```

The producer acquires authorization **before collecting** a snapshot. Snapshot
PUT requires the returned token unchanged in `X-Publication-Generation`, in
addition to its bearer credential. Generation is an app-specific concurrency
fence, not a replacement credential or freshness measurement.

For eligible matching control, `observed_at` must be at least the generation's
issued timestamp. Missing/invalid generation fields and observations below this
floor receive 422 validation errors; a well-formed nonmatching generation
receives 409. Producer clocks must be synchronized. The floor has second-level
precision and is a guardrail, not proof of collection order: trusted producers
must not attach a newly acquired generation to an old queued snapshot, alter its
timestamp, or pretend it was recollected.

### Administration

Admin GET returns HTTP 200 with
`{data:{steam_app_id, state, generation, generation_issued_at}}`. For missing
control, state is `uninitialized` and both generation fields are null.

Admin PUT requires exactly:

```json
{
  "state": "withdrawn",
  "expected_generation": "opaque-server-issued-generation"
}
```

State may be `withdrawn` or `eligible`; `expected_generation` may be null only
to match absent control. Compare the expectation atomically:

- A transition or initialization issues a fresh generation and server timestamp.
- Withdrawal atomically marks withdrawn, advances generation, and deletes all
  application metadata. It also works for an app not yet ingested.
- Reinstatement marks eligible with a new generation but restores no metadata.
  Public lookup remains 404 until authorized fresh ingestion commits.
- A same-state command with the current generation is unchanged. A mismatched
  expectation is 409, even if its requested state happens to match current
  state.

Return HTTP 200 with the admin GET fields plus
`outcome: "applied" | "unchanged"`. Only the admin credential can inspect or
change this control. After an uncertain response, GET current control and
reconcile; do not blindly replace an old expectation with a new one.

Source omission or upstream delisting is not a publication withdrawal.
Authorization acquisition and ordinary ingestion cannot withdraw or reinstate an
application. A well-formed ingestion/acquisition request for withdrawn control
receives 409 `PUBLICATION_WITHDRAWN` and retains no snapshot.

## Lookup and ingestion outcomes

### Public lookup

Return HTTP 200 with
`{data:{steam_app_id, metadata, provenance:{source_url, language, observed_at}}}`.
Metadata uses the ingestion shape, including explicit nulls and tagged dates. Do
not expose event IDs, extractor versions, generations, publication state,
credentials, or internal withdrawal details.

Lookup returns the last approved snapshot, not live source state. Provide no
stale/current flag, TTL, inferred availability, or real-time freshness promise.
Malformed App IDs receive 400 `INVALID_APP_ID`. Both uncataloged and withdrawn
applications receive the same 404 `NOT_FOUND`.

Use a single primary D1 query that includes publication eligibility; no separate
metadata-read/control-check race. After withdrawal commits, a lookup whose
database read starts afterward must not serve metadata. Responses whose data was
read earlier may already be in flight, and downloaded copies cannot be recalled.
`no-store` does not revoke consumer-held data.

### Snapshot PUT

Once auth, transport, payload, and source-policy validation succeed, make the
publication and snapshot decision atomically. Withdrawn control denies
publication; otherwise the generation must match and its observation floor must
hold before snapshot ordering can permit mutation.

| State at the atomic decision              | HTTP outcome                          | Mutation                                        |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Eligible matching generation, no snapshot | 200 `applied`                         | Insert full snapshot                            |
| Newer observation                         | 200 `applied`                         | Replace full snapshot, including explicit nulls |
| Equal observation, identical snapshot     | 200 `unchanged`                       | None                                            |
| Older observation                         | 200 `ignored_stale`                   | None                                            |
| Equal observation, different snapshot     | 409 `SNAPSHOT_CONFLICT`               | None                                            |
| Withdrawn publication                     | 409 `PUBLICATION_WITHDRAWN`           | None                                            |
| Nonmatching generation                    | 409 `PUBLICATION_GENERATION_MISMATCH` | None                                            |

Successful snapshot PUTs return
`{data:{steam_app_id, outcome, current_observed_at}}`. `applied` intentionally
covers both insertion and replacement. The returned observation time describes
state at the atomic decision, not a guarantee against later concurrent updates.

Correct metadata via a genuinely newer validated observation, not a fabricated
timestamp. On transport or server-failure uncertainty, retry the same snapshot
with the same event ID and generation. State remains safe, but a replay need not
return the original outcome after other requests. If its generation is obsolete,
reacquire authorization and genuinely recollect; do not relabel an old payload.

## Error contract

Use `{error:{code, request_id, issues?}}`; `request_id` matches `X-Request-ID`.
Validation issues contain at most 20 safe field paths and stable codes, never
submitted values. Do not expose SQL, parameters, tokens, source content,
withdrawal reasons, or underlying driver causes.

| Status | Meaning / codes                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| 400    | Malformed JSON (`INVALID_JSON`) or malformed App ID (`INVALID_APP_ID`)                                                 |
| 401    | Missing/invalid bearer credentials (`UNAUTHORIZED`)                                                                    |
| 403    | Known credential with wrong role (`FORBIDDEN`), or no approved source policy (`SOURCE_NOT_APPROVED`)                   |
| 404    | Public missing/withdrawn application (`NOT_FOUND`)                                                                     |
| 409    | `SNAPSHOT_CONFLICT`, `PUBLICATION_WITHDRAWN`, or `PUBLICATION_GENERATION_MISMATCH`                                     |
| 413    | Request body exceeds 32 KiB (`PAYLOAD_TOO_LARGE`)                                                                      |
| 415    | Unsupported media type or encoding (`UNSUPPORTED_MEDIA_TYPE`)                                                          |
| 422    | Invalid fields, missing required fields/headers, unknown JSON keys, or invalid observation floor (`VALIDATION_FAILED`) |
| 500    | Unexpected failure (`INTERNAL_SERVER_ERROR`)                                                                           |
| 503    | Temporary unavailability or missing required private-route configuration (`SERVICE_UNAVAILABLE`)                       |

A request ID is correlation information, not a delivery identity or replay key.

## Atomic persistence requirements

These are behavioral requirements, not generated SQL or an approved physical
schema. Use the existing Effect `Database` boundary and parameterized queries.

1. **One linearizable application decision.** Eligibility, generation,
   observation floor, timestamp/content comparison, and mutation must share one
   atomic database operation. Ordinary ingestion never initializes/changes
   publication control; it must first acquire authorization.
2. **Whole-snapshot replacement.** All accepted metadata/provenance columns and
   the accepted event ID change together. Unknowns clear previous values.
3. **Response classification from atomic state.** Classify applied, unchanged,
   stale, conflict, or denied from the operation's captured state/results, not a
   separate post-write read that may observe another request.
4. **Atomic control transitions.** Acquisition initializes only truly absent
   control; admin expectation checks, generation issuance, state change, and
   withdrawal deletion cannot interleave as separate application operations.
5. **No partial success.** If any SQL statement fails, roll back the entire
   operation. Business-level rejection must be deliberately mutation-free; an
   SQL no-op does not itself cause transaction rollback.
6. **Read eligibility atomically.** Public lookup requires existing eligible
   control and existing metadata in one primary read.
7. **No forbidden retention.** Withdrawal removes the snapshot and its stored
   event/provenance, leaving only approved minimal control. No delivery ledger,
   raw body archive, or metadata-bearing withdrawal log is part of this design.

Ingestion before withdrawal may commit, but the subsequent withdrawal purges it.
Withdrawal before ingestion denies the ingestion. After reinstatement,
old-generation requests are denied regardless of their observation time.
Concurrent stale admin commands cannot undo a later control transition.

### Pinned-driver feasibility and evidence limits

The inspected pinned Drizzle Effect D1 driver supports conditional upserts and
`RETURNING`; the underlying Effect D1 client exposes atomic batch execution via
`db.$client.batch(...)` using Effect SQL statements. Interactive transactions
are unsupported. Consult the pinned implementation rather than older-major
examples; do not substitute `db.transaction(...)`, parallel Effects, or
`Promise.all` for an atomic operation. See [database guidance](database.md) and
[version pins](../package.json).

Cloudflare documents ordered transactional batches that roll back on statement
failure:
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Separate application-level calls can interleave. A batch can capture pre-state
and perform a guarded mutation, then classify its results after commit; it does
not provide a JavaScript callback transaction. A returned mutation row proves
mutation, not necessarily creation; an empty result alone cannot distinguish
stale, unchanged, conflict, or withdrawal. This is why atomic state capture is
required for the specified outcomes.

Queries without Sessions use the primary, including when read replication is
enabled:
[D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).
Sessions/bookmarks provide consistency tools, not atomic read/check/write:
[D1 Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession).
No Sessions integration or replica optimization is selected here.

SQLite documents [UPSERT](https://www.sqlite.org/lang_upsert.html) and
[RETURNING](https://www.sqlite.org/lang_returning.html); conditional upserts may
return no rows, and DML returning is not a PostgreSQL-style writable CTE.
Authorization acquisition's guarded initialization, captured outcome decoding,
rollback, and concurrent behavior now have synthetic local workerd coverage.
Snapshot decisions now also have synthetic workerd evidence for whole
replacement, equality/ordering, generation fences, captured concurrent outcomes,
and rollback. Administrative transitions **remain unimplemented and
unvalidated**; the complete contract is not implemented. Preserve Alchemy
migration ownership; no second migration executor, schema push, or provisioning
is authorized.

## Required synthetic acceptance tests

Prefer the public HTTP boundary for observable contracts and the existing
isolated workerd/D1 fixture for Cloudflare-specific atomic persistence. Node
mocks alone cannot establish D1 concurrency, transaction, or binding behavior.

### HTTP and validation

- Public success, malformed IDs, unknown/withdrawn identical 404s, explicit
  unknowns, and private-field exclusion; all responses have no-store/request
  IDs.
- Missing/invalid credentials, wrong-role access, fail-closed configuration, and
  auth-before-body parsing. Ingestion cannot call admin routes or toggle
  control.
- JSON/media/encoding/body limits, omitted/unknown fields including excluded
  datasets, Unicode/string/list bounds, duplicates, OS codes, calendar dates,
  base-link rules, timestamp units/future tolerance/floor, and language.
- Source/extractor policy matching, denial when policy is missing, reserved
  synthetic sources only, and no request-path network fetch.
- Stable outcomes and error codes; bounded field paths without echoed values,
  SQL, secrets, source content, or driver causes.
- Bodyless authorization acquisition, uninitialized admin GET,
  expected-generation admin PUTs, and reconciliation after an uncertain command
  response.

### Workerd/D1 persistence

- Exact pinned conditional upsert/returning/batch execution and result decoding;
  explicit-null replacement without patch-style retention.
- Creation, newer replacement, stale no-op, equal-content no-op with a different
  event ID, and equal-time conflict across all comparison-relevant fields.
- Equality tests for JSON key/escape representation, OS order, credit order,
  duplicate rejection, Unicode spelling, and null versus empty arrays.
- Competing newer/older deliveries against both absent and existing snapshots
  finish at the greatest accepted observation within one generation. Equal-time
  differing contenders do not overwrite one another silently.
- Atomic response classification remains correct with competing writes; rejected
  and no-op requests preserve all current metadata and event/provenance fields.
- Inject failure in a later SQL step and prove earlier writes rolled back.
- Concurrent authorization acquisition initializes exactly one control
  generation; acquisition cannot remove withdrawal or mutate an existing
  eligible generation.
- Withdrawal of existing and absent apps, repeated current-generation
  withdrawal, ingestion/acquisition raced against withdrawal, and metadata
  deletion with only minimal control retained. Newer timestamps cannot bypass
  withdrawn state.
- Reinstatement restores no metadata, creates a new generation/floor, and
  rejects old queued generations. Fresh matching authorization can publish;
  timestamp floor violations do not mutate. Stale admin commands cannot undo
  transitions.
- Post-withdrawal primary lookups do not serve snapshots; reads started before
  withdrawal may finish afterward, consistent with the stated visibility
  boundary.

### Still gated

Acquisition, inspection, complete snapshot submission, and anonymous lookup have
HTTP/workerd coverage. Lookup eligibility is verified with synthetic
control/snapshot fixture states using one primary joined read. Administrative
transitions and cross-route withdrawal/reinstatement races and visibility tests
above are still required. Synthetic local workerd cannot validate production
routing, global latency, outages, replica behavior, or revocation of
consumer-held copies. Before real publication, approve actual source field and
retention policies, production abuse/rate limits and access budgets, credentials
and rotation procedures, operational monitoring/recovery, and deployment. The
private `gq-crawl` producer must agree to and implement acquire-before-collect,
clock synchronization, source approval, and retry behavior; no private adapter
or collection is authorized by this document.
