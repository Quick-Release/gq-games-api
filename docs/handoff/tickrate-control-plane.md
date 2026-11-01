# Handoff: private Tickrate control plane over the public API

Status: handoff for a separate session on the private `tickrate` repository.
This note is public-safe and describes only the HTTP contract the public API
exposes. It contains no private implementation detail, no credentials, and no
authorization to provision infrastructure or deploy.

## What exists today

The public API is anonymous and authenticates two static environment bearer
tokens for ingestion and publication administration. It has no customers,
tenants, keys, billing, or media.

See [`docs/steam-catalog-contract.md`](../steam-catalog-contract.md) for the
catalog routes and [`docs/cancellation.md`](../cancellation.md) for write
outcome semantics, including the rule that an uncertain mutation is reconciled
by inspection rather than blind retry.

## What the public API will add

Per [ADR 0001](../adr/0001-self-hostable-api-key-verification.md), the public
API will own a Verification Registry and verify opaque API Keys against it. The
private control plane is a **client** of that registry, never a co-owner of the
catalog database.

The contract the private side must implement against:

- **Issue:** generate a 256-bit CSPRNG secret, show it once, and record only the
  Key ID and a SHA-256 verifier on the public side.
- **Upsert:** send the full record (tenant, scopes, expiry, state) for a Key ID.
  The operation is idempotent and last write wins.
- **Revoke:** remove or invalidate a Key ID. Revocation takes effect on the next
  protected request.
- **Reconcile:** read the record back after any uncertain response. There is no
  ordering ledger, no batch endpoint, and no exactly-once delivery promise.
- **Authorize:** use a dedicated management credential, separate from customer
  keys and from the ingestion and publication-admin tokens.

## What the private side must not do

- Write the catalog database directly, or share tables with it.
- Put billing or account records in the registry. It holds key identifiers,
  verifiers, scopes, expiry, and revocation state only.
- Import catalog implementation code into the private bundle, or rely on a
  private verifier to make the public server work.
- Treat a customer key as operator authority. Publication administration keeps
  its own credential and its own human authorization.
- Promise customers that a key prevents copying, revocation of bytes already
  delivered, or durable post-disconnect execution.

## Deferred, not decided here

- Media and DAM scopes (`media:browse`, `media:upload`, `media:publish` were
  illustrative only), asset delivery grants, and private R2 layout.
- Usage budgets, quotas, rate limiting, pricing, and billing activation.
- Editorial corrections, which require their own ADR before any contract exists.
- Signed short-lived tokens as an alternative to opaque keys.
- Any deployment, environment, domain, secret ownership, or source-offer
  surface.

## First private slice, when that repository exists

Synthetic data only: operator authentication, existing publication inspection
and change over HTTP, and a key-issuance module that speaks the registry
contract above. No field editing, no billing, no media, and no real content.
