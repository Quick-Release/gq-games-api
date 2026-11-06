# ADR 0002: First hosted deployment for the anonymous consumer read

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** repository maintainer (service and API access owner)

## Context

`gq-poirot`, a read-only Discord consumer, needs a deployed HTTPS origin serving
`GET /v1/steam/applications/{steamAppId}` with at least one published snapshot
before its rollout can proceed. Until now the stack refused every non-dev run
that carried publication secrets: pinned Alchemy (2.0.0-beta.81) writes even
`Redacted` values to its plaintext local JSON state, and no protected state
store had been approved. Without ingestion and publication-admin secrets, a
deployment can publish nothing, so every lookup would be 404.

Snapshot policy admits only reserved synthetic `example.invalid` sources. Real
source-backed records need source-rights approval and producer work in
`gq-crawl`, outside this repository.

The README also required rate limiting to be settled before exposing a public
endpoint. `docs/business-model.md` required an AGPL-3.0 section 13 source offer
for the actual served revision to ship with the first deployment.

## Decision

1. **Anonymous consumer read.** The deployed catalog lookup runs with
   `CATALOG_ACCESS_MODE` unset (anonymous) and no registry credential, so the
   key-management routes fail closed with 503. Ingestion and publication-admin
   routes keep their own distinct bearer secrets. Protected mode remains
   available to self-hosters and would need its own rollout decision here.
2. **Encrypted deployment state.** Every non-dev stage uses Alchemy's
   `Cloudflare.state()` store. It is a state Worker and Durable Object in the
   same account, with AES-encrypted state whose key lives in Secrets Store.
   Local dev and preview keep the credential-free plaintext adapter, which no
   non-dev stage ever uses. The secret guard therefore no longer applies to
   deployed stages, because their secrets never reach plaintext state.
3. **One custom hostname, no workers.dev.** Deployed stages require `API_DOMAIN`
   (a hostname on a zone the account already holds) and set `workersDev: false`.
   The hostname and every account identifier are supplied at deploy time and
   never committed.
4. **Source offer.** `GET /` returns the licence, repository, and exact commit
   (`SOURCE_REVISION`, a 40-character lowercase SHA). Deployed stages refuse to
   run without a well-formed revision. Self-hosters can set `SOURCE_REPOSITORY`
   for their fork. Deploying from a clean checkout of that commit is an operator
   obligation; the stack cannot prove it.
5. **Rate limit.** The anonymous lookup uses a Workers rate-limit binding of 100
   requests per 60 seconds per `CF-Connecting-IP`. Over the limit it returns a
   sanitized `429 RATE_LIMITED` with `no-store` and a request ID. The check runs
   after the HTTPS requirement and before any credential or database work.
   Cloudflare counts per location with eventual consistency, so this is abuse
   control, not a guarantee. A limiter failure lets the request through.
6. **Synthetic verification record.** The maintainer publishes one clearly
   synthetic record once, through the existing ingestion route, following
   [the self-host bootstrap](../self-host-bootstrap.md). It uses only the
   reserved `catalog.example.invalid` source with `synthetic-v1`. This is a
   service-owner verification action, not a new write path: consumers still only
   read, and `gq-crawl` remains the only ongoing producer.
7. **Operators hold the secrets.** The maintainer generates and stores the
   ingestion and publication-admin secrets outside this repository and runs the
   deploy and seed steps. Secrets never enter the repository, CI, or agent
   sessions. CI still never deploys.

## Amendment (2026-11-06): agent-run deployment

Decision 7 changed before the first deployment. The maintainer had an agent
session run the deployment instead of running it personally:

- The ingestion and publication-admin secrets were generated in process and
  stored only in a dedicated Sigillo project (GQ Games API, `production`). They
  were never printed, committed, or written to a file.
- Cloudflare access used the existing shared Sigillo token manager. Each step
  minted one account-owned token that expired after at most one hour and was
  revoked when the step ended. The deploy token held Workers Scripts, D1 and
  Secrets Store write plus Account Settings read on the account, and Zone read,
  Workers Routes write and DNS write on the API's zone only. A read-only
  preflight token confirmed the zone and plan.
- The account already had an Alchemy Cloudflare state store. The stack reuses
  it, so no new state store resources were created.
- The account's Workers plan could not be confirmed through the API. This
  deployment runs within Workers Free limits if needed. Consumers that budget on
  Workers Paid must confirm the plan separately.

CI still never deploys, and later deployments follow the same minted-credential
pattern or an operator-run equivalent.

## Consequences

- A deployed consumer GET can return a published snapshot, but only synthetic
  data until real-source approval exists. Consumers must not present it as real
  game information.
- Bootstrapping the state store adds an extra Worker, Durable Object, and
  Secrets Store entry to the account. Its access token lives in the operator's
  local Alchemy profile credentials. Losing it, or the account's Secrets Store
  key, needs the Alchemy state-store recovery procedure rather than a fresh
  local checkout.
- Existing plaintext local state is never used for deployed stages, and the
  deployment does not migrate it.
- The public contract gains one error row (429). Consumers that treat any
  non-200, non-404 as a failure handle it unchanged.
- Production quotas, CORS, and a customer-facing service level remain undecided.
  No paid service exists.
