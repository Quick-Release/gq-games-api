# Self-host protected catalog bootstrap

This public-server procedure needs no private issuer or account. It assumes an
already running self-host with an HTTPS endpoint, the reviewed migrations
applied by Alchemy, and permission to publish a synthetic catalog record. It
does not provision or deploy anything. See [development](development.md) for the
pinned local stack and [registry contract](verification-registry.md) for the
complete HTTP contract. The production routes require HTTPS; the workerd fixture
alone allows loopback HTTP through a code-only test factory.

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
configuration. The endpoint must preserve HTTPS in the Worker's request URL; a
generic TLS-to-HTTP proxy in front of `pnpm dev` does not satisfy that check.
The local Alchemy listener is plain HTTP and is not a supported target for these
commands. For a fresh checkout without an existing HTTPS host, use
`pnpm test:integration`: it creates isolated local state and runs the bootstrap
through production routes with the code-only HTTP allowance. This is local
acceptance, not an HTTPS deployment recipe. Keep ingestion and publication-admin
credentials independently generated and distinct from this registry credential.
Blank or shared management credentials fail closed with 503. Do not use this
procedure to deploy; see [ADR 0002](adr/0002-first-hosted-deployment.md) and
[development](development.md) for the encrypted-state deployment path.
Restart/reconfigure the existing process before continuing; exporting variables
does not change an already running process.

Before registration, verify the configured host actually rejects anonymous
reads:

```bash
curl --silent --show-error --write-out '\nHTTP %{http_code}\n' \
  "$BASE_URL/v1/steam/applications/$APP_ID"
```

Expect 401 `UNAUTHORIZED`. Stop if this returns 200 or 404: protected mode has
not been applied. A 403 indicates the Worker saw HTTP; a 503 indicates
unavailable configuration/storage. Do not proceed until the expected 401 is
observed.

For a dedicated synthetic host with no published record, configure
`APPROVED_SNAPSHOT_SOURCES` on its server as follows. Only this reserved source
is used here, and it grants no rights to real content. A host that also serves
real records adds one exact tuple per approved record, and only when a recorded
source-rights policy backs it
([ADR 0003](adr/0003-rights-backed-real-source-tuples.md)); keep the synthetic
tuple alongside them while a synthetic verification record stays published:

```bash
export APPROVED_SNAPSHOT_SOURCES='[{"source_url":"https://catalog.example.invalid/apps/1001","extractor_version":"synthetic-v1"}]'
```

Apply that setting to the existing server together with its independent
ingestion and publication-admin credentials. Supply the matching ingestion
credential to this private shell without putting its value into history:

```bash
read -r -s -p 'Ingestion credential: ' INGESTION_BEARER_TOKEN
printf '\n'
ingestion_request() {
  printf 'header = "Authorization: Bearer %s"\n' "$INGESTION_BEARER_TOKEN" |
    curl --silent --show-error --config - "$@"
}
PERMIT="$(ingestion_request --request POST \
  "$BASE_URL/internal/v1/steam/applications/$APP_ID/ingestion-authorization")"
GENERATION="$(printf '%s' "$PERMIT" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).data.generation))')"
OBSERVED_AT="$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000)))')"
ingestion_request --request PUT --header 'Content-Type: application/json' \
  --header "X-Publication-Generation: $GENERATION" \
  --data-binary "{\"event_id\":\"synthetic-bootstrap\",\"metadata\":{\"title\":\"Synthetic Bootstrap\",\"product_type\":\"game\",\"base_app_id\":null,\"developers\":[],\"publishers\":[],\"supported_os\":[],\"release\":{\"status\":\"unknown\",\"date\":{\"kind\":\"unknown\"}}},\"provenance\":{\"source_url\":\"https://catalog.example.invalid/apps/1001\",\"language\":\"en\",\"observed_at\":$OBSERVED_AT,\"extractor_version\":\"synthetic-v1\"}}" \
  --write-out '\nHTTP %{http_code}\n' \
  "$BASE_URL/internal/v1/steam/applications/$APP_ID/snapshot"
unset INGESTION_BEARER_TOKEN PERMIT GENERATION OBSERVED_AT
unset -f ingestion_request
```

Expect 200 with `applied` (or `unchanged` for an identical retry). Use a
dedicated synthetic host/unused App ID; this is not an instruction to replace
existing content. A withdrawn App ID requires publication-admin reconciliation
rather than bypassing its publication control. Clocks must agree with the
server.

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
protected access. Request cancellation remains supported; registry statements
may still commit after interruption. GET and reconcile uncertain writes,
including after a 408. See
[cancellation semantics](cancellation.md#registry-operations).

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
