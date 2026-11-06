# Verification Registry

The API owns API Key records in its catalog D1 database. Alchemy applies the
reviewed registry migration alongside existing migrations. There are no account
or billing records, and catalog reads remain anonymous by default.

Configure `REGISTRY_BEARER_TOKEN` as a separate secret from
`INGESTION_BEARER_TOKEN` and `PUBLICATION_ADMIN_BEARER_TOKEN`. Blank or shared
management credentials disable registry access with 503. All registry operations
require HTTPS and `Authorization: Bearer <registry credential>`; incorrect or
missing authorization returns 401 before reading the body or accessing D1. Local
integration fixtures permit HTTP only through a code-only test option. Deployed
stages keep secrets in Alchemy's encrypted state store
([ADR 0002](adr/0002-first-hosted-deployment.md)). The first hosted deployment
runs anonymous and configures no registry credential, so these routes return 503
there.

- `PUT /v1/keys/:keyId` replaces the complete record, idempotently. The last
  committed write wins, including its revocation state. A later PUT can
  therefore reinstate a revoked record; issuers must reconcile by reading back.
- `GET /v1/keys/:keyId` reads the record, or returns 404 when absent.
- `DELETE /v1/keys/:keyId` sets `revoked` to true; repeats are idempotent. An
  absent record returns 404.

PUT requires exactly `verifier`, `tenant_id`, `scopes`, `expires_at`, and
`revoked`. Key IDs and tenant IDs contain 1–128 ASCII letters, digits,
underscores or hyphens. The verifier is a lowercase 64-character hexadecimal
SHA-256 digest of an issuer-generated 256-bit CSPRNG secret. Submit only the
digest, never the API Key secret. Scopes are either `[]` or `["catalog:read"]`.
Expiry is a nonnegative safe integer Unix timestamp in seconds, or null for no
expiry. Revoked is a boolean. Invalid records return 422; malformed JSON
returns 400. Bodies are limited to 32 KiB and require application/json. Unknown
fields, including a secret field, are rejected.

Successful operations return 200 with a `data` object containing `key_id`,
`tenant_id`, `scopes`, `expires_at`, and `revoked`. The verifier is never
returned. Responses use `Cache-Control: no-store` and a request ID. Database
failures return 503 without driver causes, SQL or submitted values. Registry
management does not issue secrets.

## Protected catalog reads

Set `CATALOG_ACCESS_MODE=protected` to require a customer key on
`GET /v1/steam/applications/:steamAppId`. Omitted configuration defaults to
`anonymous`; explicit `anonymous` has the same behavior and never reads the
registry, even when an Authorization header is present. Unknown mode values fail
closed with 503 on the consumer route.

Send `Authorization: Bearer <keyId>.<secret>`, where the secret is an
issuer-generated 256-bit CSPRNG value encoded as 64 hexadecimal characters. Hash
the exact UTF-8 secret string with SHA-256 when populating the registry. The Key
ID uses the existing registry identifier rules. The bearer scheme is case
insensitive; the secret is opaque and case sensitive.

Verification reads the registry per request, compares the digest in constant
time, and returns a Principal with tenant and scopes. No Principal data appears
in catalog responses. Missing, malformed, unknown, incorrect, expired, and
revoked credentials all return the same sanitized 401 envelope. Expiry is
exclusive: a key expires when the current Unix second is at least `expires_at`.
A verified key without `catalog:read` returns the same 401. Corrupt verifier
values also receive that rejection. Registry failures return 503; no protected
catalog read runs after verification failure. Responses retain request
correlation and `Cache-Control: no-store`.

There is no application cache or deliberate revocation grace period: each next
request checks its registry read. This does not establish hosted D1 consistency
or edge replication guarantees. Catalog representations and unknown-App-ID 404
semantics remain unchanged after authorization. Ingestion, publication, and
registry management retain their separate credentials and grant no authority to
customer keys.

Node tests cover HTTP policy; local workerd/D1 tests cover the pinned runtime
and per-request updates with synthetic records. Neither establishes hosted D1 or
edge semantics. No deployment or issuance service is included.

For copyable registration, read, and revocation commands, follow the
[self-host bootstrap](self-host-bootstrap.md). The
[acceptance record](protected-access-acceptance.md) separates Node HTTP evidence
from local workerd/D1 evidence and documents the access-control limits.
