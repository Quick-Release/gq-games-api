# Artwork API ticket breakdown

**Approved and published on 2026-11-11.** The maintainer approved the test
boundaries, ticket granularity and dependencies. These are GitHub child issues
of [specification #19](https://github.com/Quick-Release/gq-games-api/issues/19),
with native sub-issue and blocking relationships. All slices stay in the games
API repository and use synthetic data.

| Slice                                       | Published issue                                                | Blocked by |
| ------------------------------------------- | -------------------------------------------------------------- | ---------- |
| Protected publish/resolve/withdraw          | [#20](https://github.com/Quick-Release/gq-games-api/issues/20) | None       |
| Per-application browsing                    | [#21](https://github.com/Quick-Release/gq-games-api/issues/21) | #20        |
| Shared-asset updates and withdrawal races   | [#22](https://github.com/Quick-Release/gq-games-api/issues/22) | #20        |
| Lifecycle verification and consumer handoff | [#23](https://github.com/Quick-Release/gq-games-api/issues/23) | #21, #22   |

## 1. Publish and resolve a protected synthetic artwork reference

**Blocked by:** None.

**What it delivers:** A producer can publish one authorized synthetic asset for
one Steam Application, and a consumer with an explicit artwork grant can resolve
its reference. A publication administrator can withdraw it; subsequent reads
fail. This is a complete secure path through migrations, registry management,
write authorization, HTTP services and local workerd acceptance.

- Record strict bounded wire contracts and review generated migrations before
  application; preserve existing catalog snapshots, responses and grants.
- Support metadata-only, artwork-only and combined grants through registry HTTP.
- Separate asset control/content and generation-fenced application associations.
- Include explicit renditions, provenance, rights evidence and required credit;
  reject unapproved observations and empty rendition sets without mutation.
- Prove protected reads, stable identity, global withdrawal and no-store with
  synthetic workerd/D1 behavior. No source/image network fetches or cloud
  changes.

## 2. Browse permitted artwork for a selected Steam Application

**Blocked by:** 1.

**What it delivers:** An editor adapter can enumerate a bounded page of
permitted assets for an already selected App ID and resolve a chosen reference,
without requiring global search or attachment creation.

- Define bounded page ordering/cursors and invalid-input behavior in the wire
  contract; document behavior when membership changes between requests.
- Filter each page by current asset/application authorization, using the primary
  database and existing request/credential/error conventions.
- Prove pagination boundaries, namespace isolation, empty/unavailable results,
  credit/rendition consistency and catalog-only-key rejection through HTTP/D1.

## 3. Preserve shared artwork through updates and withdrawal races

**Blocked by:** 1. This slice does not depend on the enumeration implementation.

**What it delivers:** The same reference can serve approved revisions and link
to multiple eligible applications. Withdrawing A preserves access through B;
global withdrawal or loss of the last association blocks direct resolution.

- Add revision updates, safe identical retries and stale/conflicting-write
  rejection without changing asset identity or retaining a content history.
- Prove application and global withdrawal against shared associations, including
  both commit orders against concurrent submission/update/reinstatement.
- Prove new-read visibility and that reinstatement cannot revive former
  observations/links; retain only permitted minimal control.
- Audit atomic application withdrawal and all existing metadata regressions.

## 4. Verify the composed artwork lifecycle and publish the consumer handoff

**Blocked by:** 2 and 3.

**What it delivers:** A consumer owner receives a tested synthetic lifecycle and
precise integration contract covering enumeration, selection, update, failure,
withdrawal and fresh resolution, with ownership and real-rollout blockers clear.

- Run a composed HTTP/workerd flow through actual writes, enumeration,
  resolution, revision updates, discarded-response reconciliation and
  withdrawal/reinstatement.
- Cover pagination concurrent with lifecycle changes and fail-closed credential
  revocation/unavailability without stale provider-response fallback.
- Publish synthetic request/response fixtures and a reference-only consumer
  handoff, with site acceptance for runtime/static/saved-content behavior and
  optional AMF compatibility explicitly owned outside this repository.
- Run required repository and integration checks; record evidence limits.
- Keep artwork rights, retention approval, origin operations and production
  approval as explicit real-rollout gates. This issue does not deploy or ingest.

## External owner dependencies

Site runtime/GraphQL work and any private producer adapter are separate owner
handoffs, not child implementation tickets assigned to this checkout. Their
owners can work from the reviewed contract and synthetic fixtures. Real-asset
rollout remains blocked until source-specific rights/retention and permitted
delivery are recorded and all owners accept their responsibilities.
