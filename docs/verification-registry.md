# Verification Registry

The API owns API Key records in its catalog D1 database. Alchemy applies the
reviewed registry migration alongside existing migrations. There are no account
or billing records, and catalog reads remain anonymous in this implementation.

Configure `REGISTRY_BEARER_TOKEN` as a separate secret from
`INGESTION_BEARER_TOKEN` and `PUBLICATION_ADMIN_BEARER_TOKEN`. Blank or shared
management credentials disable registry access with 503. All registry operations
require HTTPS and `Authorization: Bearer <registry credential>`; incorrect or
missing authorization returns 401 before reading the body or accessing D1. Local
integration fixtures permit HTTP only through a code-only test option.
Secret-bearing cloud deployment remains blocked pending an approved protected
state store, including when only the registry credential is configured.

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
management does not issue secrets or verify customer credentials on catalog
reads; that enforcement is subsequent work under ADR 0001.
