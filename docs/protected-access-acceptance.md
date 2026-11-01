# Protected catalog acceptance

Scope: issues #10–#12 under #9. All records/content are synthetic. No
deployment, cloud provisioning, private control plane, or real content is part
of this record.

## Evidence boundaries

| Runtime                                                        | Evidence                                                                                                                                                                                                                                                                   | Limits                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Node HTTP tests (`pnpm test`)                                  | Production Hono routes and Effect lifecycle: uniform credential/scope rejection, sanitized registry failures, configuration failures, separate credentials, correlation, and cancellation                                                                                  | Does not validate Cloudflare bindings or hosted storage                                   |
| Local workerd/D1 (`pnpm test:integration`)                     | Pinned Alchemy-owned migrations, real D1 registry operations, protected production-route reads, expiry/scope/outage rejection, and credential isolation                                                                                                                    | Local runtime only; no hosted D1 consistency, edge timing, or production durability claim |
| Local bootstrap sequence (`tests/integration/catalog.test.ts`) | Generate a random 256-bit secret in memory, hash its exact hex string, register through PUT, serve a populated synthetic catalog through the production route, DELETE, then reject the very next protected request                                                         | Sequential completed requests; no claim about in-flight responses                         |
| Local anonymous trap (`tests/fixtures/catalog-worker.ts`)      | Forward explicit and omitted-mode anonymous requests with and without a revoked credential through the production route; registry SQL preparation throws and is counted; bulk batch/exec access is also forbidden; successful catalog responses assert zero registry reads | Test-only binding instrumentation; absent from production bundle                          |

The bootstrap runs inside the existing isolated catalog acceptance test. A
separate restart sets the actual Alchemy `CATALOG_ACCESS_MODE` binding to
`protected`, creates a previously absent Key ID, and exercises direct `/v1/...`
paths with a pre-registration anonymous 401 control. The populated synthetic
catalog is retained from the preceding local setup. Fixture paths select
configuration and forward into production routes; they implement no parallel
authentication logic. Generated secrets join response, child-output, and
temporary-file leak checks. Alchemy alone applies copied reviewed migrations.
Shutdown diagnostics are checked and temporary state is removed.

Follow the [copyable self-host procedure](self-host-bootstrap.md). Access
limits, revocation semantics, credential handling, and the separate internal
authorities are documented there and in the
[registry contract](verification-registry.md). No access-control claim includes
rate limits, quotas, copy prevention, abuse prevention, recall of bytes, or
confidentiality beyond one-way verifier storage.

## Validation

Run `pnpm format`, `pnpm check`, `pnpm lint`, `pnpm test`,
`pnpm test:integration`, and `pnpm build` from the repository root. Recorded on
2026-11-01: all six commands passed. Node: 195 tests in 13 files. Local
workerd/D1: three tests in three files, including the extended bootstrap and
anonymous registry trap. Offline build produced `dist/index.js`. The copyable
Bash blocks also passed `bash -n`.

Registry-management regression checks also cover malformed D1 bindings for GET,
PUT, and DELETE. Before the fix, binding construction escaped the Effect failure
boundary and returned 500. All three operations now return the correlated,
no-store, sanitized 503 envelope. This is Node failure-boundary evidence, not a
claim about Cloudflare binding validity.

Gated Node tests abort while verification, registry GET, PUT, and DELETE are
pending. Each returns correlated 408 and executes no subsequent catalog query.
This does not establish native statement cancellation: registry PUT/DELETE use
interruptible prepared statements outside the catalog batch/exec cutoff. Their
storage outcome after interruption remains uncertain; GET and reconcile. See
[cancellation](cancellation.md#registry-operations).
