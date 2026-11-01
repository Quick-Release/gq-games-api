# ADR 0001: Self-hostable API key verification

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** repository maintainer

## Context

The public catalog is anonymous today. It authenticates ingestion and
publication administration with two static environment bearer tokens, and it has
no notion of a customer, a tenant, or a scoped read grant.

A managed offering needs paying customers to reach a protected catalog read
without relicensing the public server. The same server must remain useful to
self-hosters who never buy that offering. The research note
[`docs/research/ecosystem-structure.md`](../research/ecosystem-structure.md)
proposes a private Tickrate control plane that issues credentials, and requires
that the public API's enforcement stay in the AGPL-covered code rather than
loading a proprietary verifier.

Two credential models were considered: opaque keys checked against a registry
the API owns, and signed short-lived tokens verified locally against issuer
keys.

## Decision

The public API verifies **opaque API keys** against a **Verification Registry**
it owns.

- A key is a 256-bit CSPRNG secret, shown once at issuance. The API stores a
  non-secret Key ID, a SHA-256 verifier of the secret, the owning tenant,
  granted scopes, expiry, and revocation state. Comparison is constant time.
- The registry lives in the existing catalog D1 database, migrated through
  Alchemy like every other migration, so a self-hoster gets it by running the
  project they already run.
- Records are written through an authenticated, generic management HTTP
  interface guarded by its own bearer credential. The private issuer
  synchronizes over that interface; it never writes D1 directly, and the
  registry holds no billing or account records.
- Verification happens per request. Revocation therefore takes effect on the
  next request, with a documented zero-window consistency claim.
- The only scope in this decision is `catalog:read`. Media and DAM scopes are
  deferred to the DAM work, and `catalog:read` never implies ingestion or
  publication administration.
- Protected mode is opt-in configuration. Anonymous lookup remains the default
  contract. When protected mode is configured and the registry is unavailable,
  the read route fails closed; anonymous mode is unaffected.
- Usage budgets, quotas, rate limits, and pricing are not part of this decision.

Signed short-lived tokens remain a documented alternative, not an
implementation. They would need defined issuer, audience, expiry, algorithm
validation, and an explicit revocation window.

## Consequences

- Self-hosters can run protected mode with no Tickrate dependency: their own
  management credential, their own records, their own keys.
- Revocation is a row update rather than a wait for token expiry, at the cost of
  a registry read per protected request.
- The public repository must carry the verifier, the management interface, and
  their tests. That is deliberate: required enforcement cannot be withheld as
  private tooling.
- The private control plane inherits a contract rather than a code dependency.
  It must reconcile by reading records back, because the interface offers no
  ordering ledger and last write wins.
- A future decision to add usage accounting reopens this ADR, because budgets
  change what verification must know at request time.
