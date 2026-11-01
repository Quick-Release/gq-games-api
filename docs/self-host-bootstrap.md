# Self-host protected catalog bootstrap

This public-server procedure needs no private issuer or account. It assumes an
already running self-host with an HTTPS endpoint, the reviewed migrations
applied by Alchemy, and a published synthetic catalog record. It does not
provision or deploy anything. See [development](development.md) for the pinned
local stack and [registry contract](verification-registry.md) for the complete
HTTP contract. The production routes require HTTPS; the workerd fixture alone
allows loopback HTTP through a code-only test factory.

Use Bash, Node, and curl. Disable shell tracing and keep this shell private.
Generate credentials in memory; do not paste them into source, shell history,
committed environment files, or logs. Set the base URL and an existing published
synthetic App ID for your host:

```bash
set +x
BASE_URL='https://your-self-host.example'
APP_ID=1001
export REGISTRY_BEARER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export CATALOG_ACCESS_MODE=protected
```

Supply these environment values to the server process using your host's secret
configuration. For an existing local Alchemy development environment, start
`pnpm dev` from this shell so it inherits them. The local listener still needs
an HTTPS ingress for these production requests. Keep ingestion and
publication-admin credentials independently generated and distinct from this
registry credential. Blank or shared management credentials fail closed
with 503. Do not use this procedure to deploy: secret-bearing cloud deployment
is currently blocked pending an approved protected state store.
Restart/reconfigure the existing process before continuing; exporting variables
does not change an already running process.

Generate a fresh 256-bit secret and hash the exact UTF-8 hex string (not its
decoded bytes). Only the verifier goes in the management body. The API never
issues or returns the secret; the issuer is responsible for delivering it once
securely. These commands keep bearer secrets out of terminal output and curl
arguments:

```bash
KEY_ID="selfhost-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export KEY_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
VERIFIER="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.KEY_SECRET, "utf8").digest("hex"))')"
registry_request() {
  printf 'header = "Authorization: Bearer %s"\n' "$REGISTRY_BEARER_TOKEN" |
    curl --silent --show-error --config - "$@"
}
catalog_request() {
  printf 'header = "Authorization: Bearer %s.%s"\n' "$KEY_ID" "$KEY_SECRET" |
    curl --silent --show-error --config - "$@"
}
registry_request --request PUT --header 'Content-Type: application/json' \
  --data-binary "{\"verifier\":\"$VERIFIER\",\"tenant_id\":\"selfhost\",\"scopes\":[\"catalog:read\"],\"expires_at\":null,\"revoked\":false}" \
  --write-out '\nHTTP %{http_code}\n' "$BASE_URL/v1/keys/$KEY_ID"
registry_request --write-out '\nHTTP %{http_code}\n' "$BASE_URL/v1/keys/$KEY_ID"
catalog_request --write-out '\nHTTP %{http_code}\n' "$BASE_URL/v1/steam/applications/$APP_ID"
registry_request --request DELETE --write-out '\nHTTP %{http_code}\n' "$BASE_URL/v1/keys/$KEY_ID"
catalog_request --write-out '\nHTTP %{http_code}\n' "$BASE_URL/v1/steam/applications/$APP_ID"
unset KEY_SECRET VERIFIER REGISTRY_BEARER_TOKEN
unset -f registry_request catalog_request
```

Expect 200 for registration, read-back, populated catalog read, and revocation;
the next catalog request returns 401 with `UNAUTHORIZED` and a request ID. A
valid key for an absent App ID returns 404 instead.
Registration/read-back/revocation responses omit the verifier and secret. Do not
enable curl tracing or verbose request logging. The digest travels in a process
argument during registration; run on a trusted host. One-way storage does not
promise credential confidentiality on compromised clients, hosts, transport
termination, or issuance systems.

## Access model and limits

Omitted access mode defaults to anonymous. Explicit `anonymous` also ignores the
registry entirely, including when a caller supplies an Authorization header.
Protected mode requires `catalog:read`; that scope grants no ingestion,
publication-admin, or registry-management authority. Missing, malformed,
unknown, incorrect, expired, revoked, and wrong-scope keys receive uniform
sanitized 401s. Registry read failures return sanitized 503s and never open
protected access. Request cancellation remains supported; it does not undo
completed writes.

Zero-window revocation means no application verification cache or deliberate
grace period: the next request consults its registry read. Local sequential
tests prove rejection after a completed DELETE in local workerd/D1. They
establish no hosted D1 consistency, replication timing, production durability,
or guarantee for requests already in flight. PUT replaces the full record and
can reinstate a revoked key; reconcile uncertain writes with GET before further
changes. Expiry is exclusive at the configured Unix second. Rotation uses two
distinct Key IDs with an operator-managed overlap, then revokes the old one.

There are no rate limits, quotas, abuse prevention, copy prevention, or recall
of already delivered bytes. Signed short-lived tokens are an alternative design,
not implemented. See the [acceptance record](protected-access-acceptance.md).
