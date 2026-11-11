# Artwork implementation progress

This is partial implementation evidence for #19 and #20, not completion of
#20–#23. The normative [wire contract](../artwork-api-contract.md) precedes code
and SQL changes. No asset route, asset persistence, lifecycle, pagination,
consumer fixture or race acceptance has been implemented yet.

## Completed prerequisite

Principal, registry HTTP validation and the D1 constraint accept `assets:read`
independently of `catalog:read`. Empty, metadata-only, artwork-only and combined
sets are allowed; scopes are unique and canonically sorted. No existing key is
upgraded automatically. No grant authorizes ingestion or administration.

Drizzle RC generated `20261111120201_artwork_read_scope`. Before local
application, SQL review confirmed the replacement table changes only the scope
constraint and copies key ID, verifier, tenant, scopes, expiry and revocation
unchanged. No new resource or migration executor was added. Alchemy remains the
only migration executor.

## Red and green

- Installed pinned dependencies with `pnpm install --frozen-lockfile` (success).
  An earlier test startup failed because this checkout had no node_modules; that
  startup failure is not behavioral red evidence.
- `pnpm test:integration tests/integration/catalog.test.ts`: meaningful red,
  exit 1, 45.64 seconds. An artwork-only registry PUT returned 422 instead of
  200 at the composed real HTTP/local workerd/D1 boundary.
- After implementation, the same command passed, exit 0, 43.44 seconds.
  Artwork-only keys could not read protected catalog metadata; combined keys
  could. Node doubles were not used for these assertions.
- Extended the final acceptance run to first apply only the four historical
  migrations, create legacy empty and catalog grants, then restart with the new
  migration through Alchemy. It checks public record preservation and successful
  legacy catalog credential verification, in addition to scope combinations in
  both input orders. This is local binding evidence only.

## Checks

- `pnpm format`: passed.
- `pnpm check`: passed, including typechecking.
- `pnpm lint`: passed.
- `pnpm test`: passed, 13 files / 204 tests. These are Node tests.
- `pnpm build`: passed; offline Worker build.
- `pnpm db:check`: passed.
- `pnpm db:generate --name consistency_check`: no schema changes, nothing to
  migrate. No extra migration was created.
- `git diff --check`: passed.

- `pnpm test:integration`: passed, 3 files / 3 tests, 46.06 seconds, including
  the legacy-row migration upgrade and both combined-grant orders. The preceding
  full run failed because the new credential-preservation test expected 200 from
  a nonexistent application (404). Changing that assertion's target to the
  lifecycle fixture's published application 8001 fixed the test; no production
  behavior was changed in response.

## Remaining implementation

#20 still needs protected asset publish/resolve/withdraw routes, independently
approved synthetic sources, strict complete observations and separate
control/content/associations. #21 needs bounded primary-query enumeration and
churn acceptance. #22 needs revision ordering/retry behavior, application link
deletion in the existing atomic withdrawal batch, both-commit-order generation
races and read visibility evidence. #23 needs the composed lifecycle,
discarded-response reconciliation, artwork credential failure coverage and the
consumer fixtures/handoff. Existing catalog regression tests do not establish
these unimplemented artwork guarantees.

No deployment, cloud bootstrap, real asset ingestion, other-repository change,
GitHub comment, issue mutation, push or PR occurred. Actual source rights,
reference/control retention, approved origin operations and deployment remain
rollout blockers. The site owner retains runtime reference-resolution and any
optional AMF compatibility work.
