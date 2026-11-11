# Artwork implementation evidence

Issues #20–#23 are implemented locally with synthetic content. The
[normative wire contract](../artwork-api-contract.md) was recorded before
runtime or SQL changes. The [consumer handoff](../artwork-consumer-handoff.md)
and its synthetic fixtures describe the site/producer/delivery owner
responsibilities. Nothing was deployed, provisioned, or ingested from a real
artwork source.

The [Muse review assessment](artwork-muse-review.md) records independently
reproduced follow-up corrections: server-clock validation, edge-whitespace
alignment, additional scope/rollback coverage, intentional origin semantics and
a shared database-error classifier.

## Implemented behavior

- Explicit `assets:read` registry grants, including artwork-only and combined
  grants. Existing metadata keys retain their original data and permissions.
- Separate asset publication control, deletable approved content and application
  associations; generation/floor checks and response classifications share the
  atomic native Effect D1 batch with mutations.
- Protected reference resolution and bounded per-application enumeration with
  primary-query eligibility, no-store, sanitized errors and server request IDs.
- Complete observation replacement, opaque revisions, identical retries,
  stale/equal-time conflicts, strict artwork policy and declared renditions.
- Global content/link purge, application association cleanup in the existing
  publication transaction, shared-asset behavior and no restoration on
  reinstatement. Only minimal asset control survives global withdrawal.

## Migrations and local application

Drizzle generated `20261111120201_artwork_read_scope` to extend only the
registry scope constraint, copying key
ID/verifier/tenant/scopes/expiry/revocation unchanged. The local HTTP upgrade
fixture creates legacy empty and catalog grants under the four historical
migrations and checks them after Alchemy applies both new migrations. Old grants
are never widened.

`20261111120922_artwork_catalog` creates three artwork tables and an application
lookup index. Its reviewed application-publication trigger deletes only the
changed application's associations when its generation changes or its state is
withdrawn. The trigger executes in the existing application transaction and
leaves other links/shared content intact. Generated snapshots describe the
schema; the trigger is reviewed custom SQL in the same Alchemy-owned migration.
No other migration executor or cloud resource was introduced.

## Red and green evidence

- The initial delegate's artwork-only registry PUT returned 422 instead of 200.
  Adding explicit grants and the registry migration made the same real
  HTTP/workerd test pass. This prerequisite alone did not complete any ticket.
- The first asset authorization test returned 404 instead of 200 in
  `tests/integration/artwork-lifecycle.ts`; the targeted catalog integration run
  failed in 37.73 seconds. The implemented route/service/migration made it pass
  in 47.12 seconds.
- The composed consumer flow exposed a cursor encoding defect: the second page
  returned 422. JSON cursor tokens now contain the raw pair; clients encode once
  in the query. The contract and fixtures specify that boundary explicitly.
- The first broader lifecycle run passed in 54.79 seconds. Adding malformed
  policy rejection, grant revocation and discarded-response reconciliation
  justified a final full integration run, which passed in 54.16 seconds.

## Acceptance coverage

The existing catalog fixture starts local Alchemy/workerd with isolated D1 and
no cloud credentials. It invokes `verifyArtworkLifecycle` through HTTP after the
new migrations; existing metadata migration/restart/atomicity checks remain.

| Behavior                              | Artwork lifecycle evidence                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected reads and unchanged grants  | Artwork-only/catalog-only separation; missing credential, expiry, revoked grants and registry read failure                                                                   |
| Strict complete approved observations | Unknown/nested fields, empty renditions, duplicate apps, MIME, source, rights and origin rejection; malformed policy denies all                                              |
| Identity, revisions and retries       | Provider namespace collision isolation, unchanged identity on URL/revision updates, identical/reordered retries, stale/conflicting observations                              |
| Bounded primary enumeration           | Page boundaries, invalid/repeated query values, unknown apps, removals and insertions before cursor                                                                          |
| Atomic lifecycle and rollback         | Real later-statement SQL failure preserves content/control; shared A/B withdrawal and last-link loss; no restoration on reinstatement                                        |
| Concurrent publication                | Explicit HTTP gates drive both commit orders for asset/app withdrawal against updates, acquire against asset withdrawal, and asset/app reinstatement against old submissions |
| Visibility                            | Gates skip the registry check and hold the actual content read before/after withdrawal; captured responses may finish, newly started reads cannot expose content             |
| Reconciliation                        | Successful producer/admin replies deliberately discarded; resolution/inspection and unchanged retry reconcile without blindly substituting a generation                      |

Gate timers only bound waits; elapsed time never releases a database operation.
Both contenders arrive before either batch is released, and responses are held
until both commit so outcomes cannot be fabricated by a later classification
read. Observation timestamps use the actual clock after authorization; explicit
clock waits only establish genuinely newer seconds for revision tests.

## Final checks

- `pnpm format`: passed.
- `pnpm check`: passed, including types.
- `pnpm lint`: passed.
- `pnpm test`: passed, 14 files / 206 Node tests after the Muse review
  corrections.
- `pnpm build`: passed, offline Worker build.
- `pnpm test:integration`: passed, 3 files / 3 tests in local workerd/D1.
- `pnpm db:check`: passed.
- `pnpm db:generate --name consistency_check`: no schema changes; no extra
  migration generated.
- `git diff --check`: passed.

Node tests alone establish no Cloudflare binding guarantees. Local workerd does
not establish production routing, latency, quotas or operational readiness.
These checks validate synthetic source policy enforcement, not actual artwork
rights, origin operations or WPGraphQL/AMF compatibility. Real rollout remains
blocked on source/retention/delivery approval and explicit deployment authority.
