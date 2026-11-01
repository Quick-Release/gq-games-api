# Tickrate product ecosystem and public API structure

## Status and scope

**Proposal only — not an ADR, selected infrastructure, or implemented
ecosystem.** Research checked primary GNU, Cloudflare, WHATWG, OWASP, and WIPO
sources on 2026-10-09. License text governs; GNU FAQ entries are FSF
interpretations, not binding legal determinations. This note does not authorize
collection, private integration, provisioning, an Alchemy cloud plan, or
deployment.

The requested direction is **only the API implementation open source**;
marketing, the data-editing dashboard, DAM software, and account/billing/key
management remain private, provided their implementations are genuinely
independent works. Required API Corresponding Source cannot be withheld merely
because it is supporting tooling rather than request-handler code. [AGPL
§1][agpl-1]. The existing [licensing decision](../business-model.md) remains
AGPL-3.0-only, not a new license or mandatory commercial-use fee.

### User-confirmed product requirements

- **Tickrate is the business-facing brand** for non-open-source and paid
  products. This branding does not change the public API's AGPL license or make
  its commercial self-hosting chargeable.
- **`gq-platform` already exists as a documentation and ADR decision-owner hub
  for sites the team builds.** Do not repurpose it as the product codebase. This
  role is user-reported; its contents were not inspected in this research.
- **Customer-authorized media**, not publicly readable R2 objects: approved
  customers obtain delivery access for websites such as `cooldowngaming.com`.
- **Both publication/asset management and editorial corrections**: operators
  should manage approval/withdrawal and make separately attributed corrections
  to catalog fields. The existing API does not implement editorial corrections.

These requirements were confirmed in the research discussion. The architecture
below is still a proposal; they authorize neither infrastructure nor deployment.

### Implemented baseline

- The public API implements synthetic local Steam Application identity and
  Release Metadata lookup, not canonical Game identities. Five catalog routes
  provide anonymous lookup, ingestion authorization/full-snapshot submission,
  and publication-admin inspection/change. Internal admin/ingestion code is part
  of the public server, not a proposed private control plane.
  [Catalog contract](../steam-catalog-contract.md),
  [HTTP implementation](../../src/http/catalog.ts),
  [glossary](../../GLOSSARY.md).
- The pinned foundation is Workers + D1, Alchemy `2.0.0-beta.81`, Effect/Effect
  D1 `4.0.1`, Hono `4.13.13`, Drizzle ORM/Kit `1.0.0-rc.5-ab785fc`, and Vite+
  `1.1.0`. Infrastructure belongs in `alchemy.run.ts`, HTTP in Hono, application
  services in Effect, and migration history under Alchemy.
  [Version pins](../../package.json), [contributor guidance](../../AGENTS.md).
- Only D1 is currently declared/implemented, with synthetic local acceptance. No
  real source-rights approval, deployed managed service, private crawler
  adapter, DAM, customer keys, billing, quotas, or production budgets exists.
  R2, Images, cache, additional Workers, Queues, Workflows, and KV are not
  selected by the existing architecture. [Architecture](architecture.md),
  [backlog](backlog.md), [business model](../business-model.md).

## Recommendation

Keep the existing repositories' roles and add **one private Tickrate product
monorepo**, not one repository per feature. `tickrate` below is a proposed
repository name, not an existing or user-confirmed repository:

1. **`gq-games-api` — existing public AGPL server.** Own catalog behavior,
   self-hostable verification/enforcement, tests, contracts, migrations, and
   required build/install/run source. Do not add private product code to its
   bundle.
2. **`tickrate` — proposed private product monorepo.** Two UI apps, marketing
   and dashboard, plus one backend/control-plane app. Keep accounts, billing,
   API key issuance, DAM, and eventual editorial workflows as modules of that
   backend, not premature independently deployed microservices. Tickrate brands
   the proprietary products and paid managed offering; `gq-games-api` remains
   the separately licensed public implementation.
3. **`gq-crawl` — existing separate private producer.** Leave its code, source
   inventories, and artifacts outside the public repository. HTTP adoption of
   the existing ingestion contract remains future work, not permission to crawl.
4. **`gq-platform` — existing documentation/ADR decision-owner hub.** Preserve
   its current role for the sites the team builds; it is not the proposed
   Tickrate application/backend repository. Link relevant product decisions
   rather than silently relocating existing ADRs or changing their owners.
   Repository visibility and any broader governance scope are not inferred.

**Default direction, reflecting the user's choice:** private management software
and a private R2 bucket for originals, staging, and approved derivatives.
Customers authenticate to obtain asset-scoped, expiring delivery URLs through a
Worker on a Tickrate-operated media origin. Do not enable public bucket access
or `r2.dev`; direct unauthenticated origin access must not bypass authorization.
Until rights approval, deny media delivery. Authentication itself is not rights
clearance. Public derivatives are an alternative only if separately requested
and rights-approved, not the current product direction.

This keeps the public API useful without Tickrate accounts or a mandatory
private backend. It also lets sites such as `cooldowngaming.com` use a media
library without exposing its management implementation. The site is an
illustrative consumer, not an inspected or implemented integration.

## Licensing and source obligations

### Independent HTTP clients are possible, not automatically independent

AGPL section 0 says mere network interaction without transfer of a copy is **not
conveying**. Calling an API does not by itself convey its server code or
relicense an independent client. Transferring copies of covered code is a
different case. [AGPL §0][agpl-0].

Section 5(c), in its modified-source conveying context, covers the **entire work
as a whole**, regardless of packaging. Section 5 also distinguishes qualifying
aggregates of separate, independent works that are not extensions or combined
into a larger program. Its modification/license/legal-notice requirements still
apply where specified. This does not mean everything in a company is one work,
nor that a private folder exempts a server extension. [AGPL §5][agpl-5].

The FSF aggregation FAQ calls the dividing line a legal question ultimately for
judges. It considers communication **mechanism and semantics**: pipes, sockets,
and command-line arguments normally connect separate programs, but intimate
communication exchanging complex internal data structures may indicate a larger
combined program. Container packaging does not change that analysis. [GNU
aggregation FAQ][gnu-aggregate], [container FAQ][gnu-containers].

**Therefore HTTP, a separate repository, domain, Worker, or process is not a
legal safe harbor.** Independently built marketing/dashboard/control-plane/DAM
programs consuming documented HTTP representations are a reasonable design to
review, not a guarantee. Assess copied code, shared implementation libraries,
linking, callbacks/control flow, required private extensions, and unusually
intimate protocols. Folder separation within one bundle is not runtime
separation; separate deployments make independence inspectable but cannot
manufacture it. [AGPL §1][agpl-1], [§5][agpl-5], [GNU aggregation
FAQ][gnu-aggregate].

Proposed guardrails:

- No private source imported into the AGPL Worker bundle. Publish required
  verifier/enforcement implementation in the public API rather than loading a
  proprietary plugin to make it work.
- No importing/copying covered catalog implementations into private apps without
  a licensing review. Reused/generated client code and shared packages also need
  explicit license review; HTTP contracts are not permission to copy server
  code.
- Exchange documented requests/results, not shared D1 tables, internal service
  objects, or cross-process execution internals. Each application owns its state
  and can be built/run independently with substitute peers.
- Review both directions of integration, including the private crawler. Future
  SDKs are not MIT until a separate license is actually added.
  [Existing business model](../business-model.md).

### Offer source for the actual network-served version

Section 13's trigger is **“if you modify the Program”**: a modified version
supporting remote interaction must prominently offer all remotely interacting
users its Corresponding Source from a network server, at no charge, through
standard/customary copying means. Do not summarize this as a new section 13 duty
for every unmodified execution; preserve existing offers and assess the actual
version and other applicable obligations. The FSF identifies programs expressly
designed to accept/respond to network requests as remote-interaction programs.
[AGPL §13][agpl-13], [GNU remote-interaction FAQ][gnu-remote].

Section 1 defines Corresponding Source to include source needed to generate,
install, run, and modify the executable, including controlling scripts and
associated interface definitions. Its required-library/dynamically linked
subprogram example includes intimate data communication/control flow; it does
not declare every remote service to be part of the source. The specified System
Library/general-tool/regenerable-material exclusions are not an exemption for
anything labeled private. [AGPL §1][agpl-1].

**Proposed deployment acceptance:** identify the actual served revision and any
modifications; offer a version-matched source archive/revision with required
build/install/run and migration scripts, dependency pins, interface definitions,
and necessary infrastructure configuration source. A link to an unrelated or
outdated upstream release is insufficient. Make source copying free and the
offer prominent through API documentation and a discoverable API-facing source
surface; a paid platform login must not gate required source access. Verify the
presentation before deployment rather than claiming a particular link/header
already satisfies the license. [AGPL §1][agpl-1], [§13][agpl-13].

Keep credentials, production account access, and private datasets separate from
source. Provide usable non-secret configuration and setup instructions; embedded
secrets are a reason to redesign configuration, not withhold required source.
Infrastructure being outside the Worker bundle does not by itself exclude
required scripts. If required covered source cannot be provided, resolve that
conflict before deployment. Conveying covered binaries also engages section 6;
section 13's GPLv3-combination permission is not a proprietary-plugin exception.
[AGPL §1][agpl-1], [§6][agpl-6], [§13][agpl-13].

### Managed revenue does not require proprietary relicensing

Commercial compliant self-hosting is allowed; AGPL permits running the
unmodified program and charging for copies/support, while section 10 prohibits
additional fees/restrictions on exercising its granted rights. Paid managed
access is not a mandatory fee for commercial use of the code. [AGPL §2][agpl-2],
[§4][agpl-4], [§10][agpl-10], [existing business model](../business-model.md).

Optional alternative proprietary licensing requires sufficient copyright
ownership or separate permissions for all material being relicensed. Repository
ownership and accepting AGPL contributions do not supply those rights. The FSF
specifically says an author must obtain another contributor's permission to
release that contributor's code under another license. Review contributor and
employer rights, and dependencies' separate licenses; do not promise the ability
to relicense third-party dependencies. Agree a suitable contributor-rights
policy if this option matters. Existing AGPL grants remain; no alternative
commercial code license is offered today. [AGPL §5(c)][agpl-5], [GNU
parallel-licensing FAQ][gnu-dual], [contributor FAQ][gnu-contributors],
[business model](../business-model.md).

## Proposed repositories, deployments, and responsibilities

Illustrative private layout; these folders are **not** licensing boundaries:

```text
tickrate/                       private product code, proposed
  apps/marketing/               product site
  apps/dashboard/               customer/operator UI
  apps/backend/                 one control-plane application
    src/accounts/               tenants, memberships, entitlements, billing
    src/keys/                   issuance, rotation, revocation orchestration
    src/dam/                    asset library, rights, uploads, delivery grants
    src/editorial/              future overlay workflow, not snapshot patches
```

| Repository / module           | Proposed deployment boundary                                             | Responsibility / owned state                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public `gq-games-api`         | Independently built catalog Worker                                       | Existing catalog D1; public catalog and internal publication/ingestion implementation; future generic verifier/enforcement. No private imports or direct platform database dependency. |
| Private `tickrate` marketing  | Static-site deployment; choose hosting later                             | Product/pricing presentation. No operator secrets or catalog mutation authority.                                                                                                       |
| Private dashboard             | UI assets, initially alongside the backend if practical                  | Customer keys/accounts; operator publication controls, DAM, eventual editing. UI is not the authorization authority.                                                                   |
| Private backend/control plane | One private Worker application initially                                 | Accounts/billing/key issuance and DAM modules; proposed private D1 for platform metadata; server-held admin credentials for HTTP catalog orchestration.                                |
| Private DAM delivery module   | Initially routes of that backend; split only for measured/security needs | Customer-authorized reads from private R2, using asset-scoped delivery grants. No need for a separate DAM repository or Worker at inception.                                           |
| Existing private `gq-crawl`   | Its separately operated producer runtime; not redesigned here            | Acquire, genuinely collect approved observations, submit complete snapshots over HTTP. Never share the catalog database or pretend to be editorial author.                             |
| External website              | Independent website/backend/browser                                      | Browse permitted assets, select versions, embed permitted delivery URLs, render attribution. Not a storage-admin client.                                                               |

`gq-platform` remains a separate documentation/ADR decision-owner hub, not a
runtime component in this topology. Do not assume all product or public API ADRs
move there: preserve existing ownership and link records where relevant.

Illustrative topology, not a resource declaration:

```text
marketing                 dashboard / external site's backend
                               |
                               | authenticated HTTP
                               v
                    private Tickrate backend
                    accounts | keys | DAM | future editorial
                      |       |             |
                      |       +---------- private platform D1
                      +------------------ private R2 staging/originals
                      |
                      +-- HTTP publication administration --> public API Worker
                                                              catalog D1
private gq-crawl ---- acquire / full snapshot HTTP ---------->     ^
                                                                  |
consumer backend ------- catalog HTTP + generic verification ------+

external site backend -- customer key --> DAM delivery-grant endpoint
external browser -- expiring image URL --> authorization-checking Worker
                                          --> private R2 derivative
                                          (proposed; no resource exists here)
```

Separate builds, runtime authorities, credentials, and state ownership matter
more than counting repositories. Keep shared private UI utilities private; do
not introduce a cross-repository implementation package just to avoid a little
HTTP contract duplication. Later infrastructure remains Alchemy-owned with
reviewed migrations and the pinned stack; vendor Wrangler examples below are
capability references, not adoption instructions.
[Contributor guidance](../../AGENTS.md).

## Public verification, private issuance

**Proposed seam:** a small credential-verifier module in the public API returns
a validated principal and scoped grants, or rejection; public server policy then
enforces the route/action/object rules. Keep accounts, membership UX, payment
processing, key issuance, and plan configuration in the independent private
control plane. OWASP recommends endpoint access control and server-side checks
on every request; UI controls alone are insufficient. [OWASP REST access
control][owasp-rest], [authorization guidance][owasp-authz].

Self-hosters must be able to supply their own verifier data/trust configuration
and manage it without the private `tickrate` product, Tickrate billing, or
Tickrate-issued keys. A proposed starting option is opaque keys with a
verification-only registry owned by the API, populated through an authenticated,
generic management interface. Store only key identifiers/verifiers, grants, and
validity/revocation state there, not customer billing records. The private
issuer synchronizes those records over HTTP; it does not write catalog D1
directly. This registry/interface is **not implemented**. Document ordering,
retry/reconciliation, revocation visibility, and outage behavior before choosing
it.

An alternative is standard signed, short-lived access tokens verified locally
against configurable issuer keys. That needs defined issuer/audience/expiry and
algorithm validation, plus an explicit revocation window; it is not an automatic
choice or an instant-revocation guarantee. The public verification
implementation and any required protocol definitions remain public in either
option. [OWASP JWT guidance][owasp-jwt], [AGPL §1][agpl-1].

Do not rely solely on a private gateway while leaving a protected origin freely
accessible. Protected modes must enforce access in the public server and fail
closed on invalid/missing required configuration. Current consumer lookup is
anonymous; changing that contract or introducing opt-in hosted access policy
requires a separate design and synthetic tests. Preserve distinct ingestion and
publication-admin authority; customer `catalog:read` must never imply either.
[Current HTTP roles/configuration](../../src/http/catalog.ts),
[catalog contract](../steam-catalog-contract.md).

Proposed key/security defaults, not existing features:

- Generate a CSPRNG secret with 256 random bits; show it once on issuance and
  retain a one-way verifier, not recoverable plaintext. Use a non-secret lookup
  identifier plus secret hash and constant-time comparison. This is a proposed
  API-key application of OWASP's random-token storage guidance, not a claim that
  OWASP mandates 256 bits or one-time display for every API key. [OWASP token
  storage][owasp-token-storage].
- Store key owner/tenant, scope, expiry/revocation state, and a safe display
  prefix. Allow explicit rotation overlap and independent revocation; test that
  revoked grants stop working within the documented consistency window.
- Authenticate over HTTPS; keep long-lived site integration keys on the site's
  backend, out of browser bundles, URLs, logs, and fixtures. Separate human
  dashboard sessions from machine keys; privileged operator actions need strong
  human authorization, not just possession of a customer key. [OWASP
  HTTPS/credential handling][owasp-rest], [API-key limits][owasp-api-keys].
- Enforce tenant and object-level authorization for browsing, metadata, uploads,
  approval, signing, key management, and deletion. An asset ID, guessed path, or
  caller-supplied tenant ID is not authorization. Narrow scopes such as
  `media:browse`, `media:upload`, and `media:publish` are illustrative, not a
  selected permission model. [OWASP object access checks][owasp-authz].
- Check scopes, usage entitlements, quotas, upload/storage/download limits, and
  rate limits server-side. Define budget accounting and rejection behavior,
  including `429` for rate limiting; do not assume API keys prevent all abuse.
  No counters, paid quotas, prices, or cost/availability promises are
  implemented. [OWASP API-key guidance][owasp-api-keys], [upload/download
  limits][owasp-upload], [current backlog](backlog.md).

## Private DAM, external media delivery

### Private metadata and rights; R2 blobs

Propose private platform D1 for asset identifiers/versions, tenant ownership,
optional Steam App ID associations, descriptive metadata, dimensions/type/size,
object locators, derivative relationships, rights evidence, attribution, allowed
uses/sites, expiry, approval/publication state, and deletion status. Keep
original/staging/approved derivative bytes in R2, not catalog snapshot fields.
An association to a Steam Application does not establish a canonical Game.
[Current vocabulary/scope](../../GLOSSARY.md),
[metadata-only contract](../steam-catalog-contract.md).

Owning an R2 account or possessing image bytes does **not by itself establish
redistribution permission**. WIPO explains that online publication does not make
works public domain and that authorization is generally required, subject to
licenses and applicable exceptions. Approve actual access, storage, derivative,
commercial use, redistribution/hotlinking, attribution, retention, and takedown
terms before delivery. Restricted access is not a substitute for permission.
[WIPO copyright FAQ][wipo], [existing source-rights gate](backlog.md).

Recommended lifecycle: private upload/staging → technical validation → rights
review → approved derivative/version → permitted delivery → withdrawal/deletion.
Keep enough approved rights evidence and operational audit metadata for the
actual retention policy; do not create an unauthorized archive of upstream
material or a catalog snapshot history. Treat D1 metadata and R2 writes/deletes
as a recoverable multi-step workflow, not an assumed atomic cross-store commit.
Reconcile incomplete publication, orphaned staging objects, and interrupted
removal before reporting success.

### Choose delivery according to rights, not software visibility

| Delivery option                                         | Primary-source facts                                                                                                                                                                                                        | Proposed use / pitfall                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved public derivatives through an R2 custom domain | Buckets are private by default; custom domains expose contents and enable Cloudflare Cache/security features. `r2.dev` is a non-production endpoint, independent of custom-domain exposure. [R2 public buckets][r2-public]. | Alternative only if the customer-authorized requirement changes. Keep originals/unapproved files outside the exposed bucket. Choose a Tickrate-operated media domain; disable alternate exposure paths. Private DAM source need not become public merely because image bytes are public.    |
| Private bucket behind Worker delivery                   | Workers can read R2 bindings; application authorization must protect exposed operations. [R2 Workers access/privacy][r2-workers].                                                                                           | Recommended customer-authorized direction; synthetic content first. Authorize asset/tenant/use before bytes or grants, including HEAD/range paths. Same backend deployment initially; no public bucket URL bypass. Public images may also be served this way if approval checks are needed. |
| S3 presigned GET/PUT                                    | A signature authorizes an operation/object until expiry; the URL is a reusable bearer capability. It works on the R2 S3 API domain, **not custom domains**. [R2 presigning][r2-presigned].                                  | Useful for temporary private previews/downloads or quarantined uploads, not a permanent article URL. Do not replace its hostname with the media custom domain or describe it as single-use.                                                                                                 |

R2 requires the custom-domain zone to be in the same Cloudflare account as the
bucket. Recommend a Tickrate-operated media origin that external sites can
embed, rather than requiring each consumer to attach its own domain to the
bucket. This is separate from permitting that site's use of the images. [R2
custom-domain requirements][r2-public].

For an ordinary `<img src="...">`, HTML provides URL/CORS settings, not a way to
attach an application-chosen `Authorization: Bearer` header. Cookie credential
behavior does not create such a header-setting API. Use public approved URLs,
short-lived image URL capabilities through the Worker, or a site-backend proxy
when authenticated display is required; do not embed a long-lived API key in an
image URL. [WHATWG `img` interface][html-img], [OWASP credential-in-URL
warning][owasp-rest].

CORS is browser cross-origin access policy, **not authentication or a
redistribution/hotlink restriction**. R2 explicitly distinguishes presigned URL
authentication from the separate CORS configuration needed for browser requests.
Non-browser callers are not authorized by an origin allowlist, and ordinary
cross-origin image display is distinct from JavaScript/canvas access. Allow only
needed origins/methods/headers for browser DAM calls/uploads and configure
canvas access deliberately. [R2 CORS][r2-cors], [OWASP CORS
guidance][owasp-rest], [WHATWG `img` CORS purpose][html-img].

### Website integration

Proposed integration, not new catalog routes:

1. The external site's backend authenticates to the private DAM interface and
   searches/browses only assets permitted for its tenant and intended use. DAM
   browsing is separate from the public catalog, which has no listing/discovery
   contract. [Current catalog scope](../steam-catalog-contract.md).
2. Its CMS/media picker selects an asset/version and an allowed named
   derivative. The DAM returns safe display metadata, dimensions,
   attribution/use conditions, and the appropriate delivery URL or temporary
   grant. Rights evidence and R2 credentials remain private.
3. The site stores asset/version references and required attribution, not a
   temporary signature as its permanent identity. Its backend requests
   short-lived, asset/version/variant-scoped delivery URLs when rendering pages
   and refreshes them as necessary. Static articles and cached HTML must not
   retain expired URLs: choose request-time generation, a refresh integration,
   or a customer-operated backend proxy with an explicit caching/removal policy.
   A public site's backend authentication cannot make the displayed bytes
   private to its visitors. Signed URLs are bearer capabilities and can be
   copied/reused while valid; customer authorization controls access to our
   service, not downstream copying or perfect domain confinement. [R2 presigned
   security semantics][r2-presigned].
4. Browser-only pickers use a narrowly scoped short-lived session/capability
   issued by the site/backend and explicit object authorization. Never ship the
   site's long-lived service key or bucket credentials to visitors. [OWASP
   authorization][owasp-authz], [token storage/handling][owasp-token-storage].

### Upload sessions and capability limits

Default to an authenticated **server-mediated, byte-bounded upload** into
private staging. Bind its session to tenant, asset, unique server-chosen staging
key, operation, expiry, content constraints, and budget reservation. Validate
actual bytes, file signature/decoding, dimensions and resource limits; claimed
MIME type and `Content-Length` alone are not validation. Restrict active formats
initially and protect cookie-authenticated uploads against CSRF. Only validated,
approved content may become an immutable delivery version. These are proposed
controls consistent with [OWASP file-upload guidance][owasp-upload].

Direct presigned PUT is a later optimization. Sign only a unique quarantined
object/method with short expiry and required headers; do not grant listing,
arbitrary keys, approved-object overwrite, or general R2 credentials. Cloudflare
documents signed Content-Type constraints, but the client-controlled header does
not prove actual content, and a presigned URL is reusable until expiry. Do not
claim it enforces a session's one-use state, cumulative quota, or byte ceiling
unless that enforcement has been independently designed/tested. Validate before
promotion to a **different immutable delivery key**, so a still-valid upload URL
cannot rewrite published bytes. [R2 presigning][r2-presigned], [OWASP content
validation][owasp-upload].

### Stable versions, variants, and removal

Use stable asset/version references and versioned delivery paths, for example
`https://media.example.invalid/assets/{asset-id}/{version}/card.webp`; hostname,
path, and variant names are illustrative. Under the chosen customer-authorized
model, that unsigned path must not serve bytes: a Worker validates a scoped,
expiring capability before delivery. The reference stays stable while its signed
URL changes. Changing bytes creates a new version; never silently replace
published bytes or store an expiring URL as the permanent CMS identity. Start
media delivery without shared caching; add a reviewed cache policy only when
every delivery, including cache hits, passes authorization first. A later
internal byte-cache key may exclude the signature only behind that check and
must preserve tenant/use isolation. Cloudflare's Cache API exposes explicit
`match`/`put` operations and caches are local to a data center; it does not
implement application authorization or globally replicated invalidation for us.
[Worker Cache API][worker-cache], [R2 authorization][r2-workers].

Start with originals plus a small approved set of derivatives if needed. Options
include pre-generating derivatives into R2, Cloudflare URL transformations, or
Images bindings operating on private R2 bytes. Cloudflare documents both R2
origin transformations and raw-byte Images binding input. **No Images resource,
transformation product, queue, or cache policy is selected here.** Compare
rights, processing limits, transformation costs, formats, authorization, and
deletion behavior first; allowlisted named variants avoid an arbitrary
resize/URL-fetch interface. [Cloudflare R2 image-delivery
architecture][images-r2], [Images binding][images-binding].

Versioned URLs do not solve revocation. Cloudflare says cached custom-domain
objects can remain available after R2 deletion or overwrite, and cached 404s can
also outlast a later upload. Purge delivery caches when removal must take
effect; account for derivative URLs, aliases, redirects, and cache-key
variations, not only the original object. Single-file purge has limitations for
custom keys and purges a redirect rather than its destination. [R2 cache
consistency][r2-consistency], [Cloudflare purge limitations][cache-purge].

Before enabling caching, define maximum delivery/cache lifetimes, how approval
withdrawal blocks subsequent reads, which copies/derivatives/backups must be
removed, who owns purge/reconciliation, and what consumers must do on takedown.
Do not promise recall of downloaded copies or already-served responses. For
rights needing tighter revocation, prefer an authorization-checking Worker with
appropriately bounded/no-store delivery and no shared-cache bypass; public
long-lived cacheability may be incompatible with those terms. The existing
catalog's `no-store` and withdrawal rules remain unchanged; media gets its own
reviewed policy. [Current withdrawal limitations](../steam-catalog-contract.md),
[R2 cache consistency][r2-consistency].

## Data editing conflicts with the current snapshot contract

The requested dashboard can initially **inspect publication control and perform
existing generation-checked withdrawal/eligibility changes** through the admin
HTTP routes. Reinstatement restores no metadata; uncertain changes require GET
and reconciliation. It cannot honestly offer arbitrary catalog field editing
using today's interface. [Current administration](../steam-catalog-contract.md),
[implemented routes](../../src/http/catalog.ts).

Current ingestion requires complete English snapshots from one approved source
observation, not partial updates, mixed-source patches, editorial editions, or
invented observation times. Correcting a source snapshot requires genuinely
newer collection. A human edit must never masquerade as crawler provenance,
modify a source observation in place, or advance `observed_at` to defeat
ordering. [Snapshot/source/order contract](../steam-catalog-contract.md),
[preserved scope](backlog.md).

**Future proposal requiring a separate design and ADR before implementation:** a
private editorial overlay module storing author, edit time, reason, rights,
approval, and its reference to the source observation independently. Decide
precedence, conflicts after new ingestion, public field-level provenance,
publication generations, withdrawal/deletion/retention, and canonical Game
versus Steam Application scope. If the public API serves composed values, its
composition/enforcement code and changed contract belong in the public API;
private UI does not justify a proprietary patch imported into that bundle.
Overlay content still needs separate data rights. A proposed ownership seam is
private drafts, review UX, and operational audit in the platform; an accepted
correction is submitted through a generic authenticated HTTP interface owned by
the public API, which persists the serving correction and applies public
composition/withdrawal rules without reading private platform tables. Required
correction-serving semantics remain open source; editorial content does not
therefore become an open-source dataset. Decide the authoritative stores and
retention limits in that design rather than assuming two independently edited
copies agree. No overlay, schema, patch endpoint, or ADR is created by this
note.

DAM metadata editing may precede catalog editing because it belongs to the new
private asset workflow; it is not permission to expand the catalog's existing
metadata-only scope or retain raw crawler payloads.

## Minimal phased build plan

1. **Resolve gates, not infrastructure:** inventory actual code integration and
   contributor rights; approve initial asset/source retention and redistribution
   terms; specify customer-authorized grants and removal expectations. Keep real
   content blocked. Review the eventual source offer and independent application
   seams.
2. **Private Tickrate product skeleton:** in a separate, explicitly authorized
   task, establish marketing/dashboard/backend with synthetic data. Start with
   human operator auth and existing HTTP publication inspection/change. No
   field-edit promise, billing activation, or public source/data change.
3. **Keys and public enforcement:** design the generic self-hostable verifier,
   managed issuer synchronization/token protocol, scopes, rotation/revocation,
   budget semantics, and anonymous-versus-protected consumer policy. Add
   synthetic tests, including direct-origin bypass, wrong scope/tenant, outage,
   revocation, and retries, before connecting a private issuer.
4. **One DAM vertical slice:** synthetic upload session → validate → rights
   approve → browse/select → site integration → delivery → removal/recovery.
   Propose private D1/R2 only in that task, with separate state ownership and
   reviewed migration/resource design. Test capability reuse/expiry,
   cross-tenant access, staging overwrite, byte limits, and interrupted
   multi-store cleanup.
5. **Editorial correction vertical slice:** separately design and approve the
   overlay contract, then test draft → review → generic correction submission →
   composed lookup → new source observation → conflict/reconciliation →
   withdrawal/deletion. Keep source snapshots immutable and corrections
   attributable; do not route edits through ingestion or fabricate timestamps.
6. **Approve operation separately:** only after explicit deployment approval,
   review environment/secrets/state ownership, source offer for the served API,
   monitoring/recovery, budgets, and media cache/purge behavior. Defer billing,
   service splits and transformation infrastructure until their contracts and
   evidence justify them. Local workerd acceptance is not proof of production
   routing, source legality, costs, or cache revocation.
   [Existing acceptance limits](architecture.md).

## Concrete undecided questions

- Which jurisdiction and actual integrations need combined-work legal review?
  What copyright/contributor permissions exist for any optional relicensing?
- May each image be stored, transformed, commercially displayed, hotlinked,
  downloaded, or redistributed to third-party sites? Who approves rights and
  attribution, and what evidence/retention is permitted?
- Customer-authorized delivery is chosen. Are grants scoped per site, tenant,
  viewer, or use, and what expiry/refresh policy works for cached public pages?
  Is a customer-backend proxy needed for static CMS integrations?
  Browser-visible URLs cannot be treated as secrets or as copy prevention.
- What revocation/removal latency is required, including caches, variants,
  backups, signed grants, in-flight responses, and consumer-held copies? Which
  obligations make long-lived public caching unacceptable?
- Does the first API access model use opaque verifier records or signed tokens?
  Who owns the verification registry, synchronization and reconciliation,
  expiry, revocation window, and failure mode? Does anonymous lookup remain
  available?
- Which usage budgets matter: requests, uploaded/stored bytes, downloads,
  transformations, tenant quotas, or paid credits? What accounting consistency
  and spending ceiling are acceptable? No prices or guarantees exist yet.
- Which operator/editor/customer roles and sites are actually needed first? Is a
  site-backend DAM picker sufficient before a browser-only integration?
- Publication/assets plus editorial corrections are chosen. Which fields are
  editable, who approves them, what precedence/provenance applies, and how do
  new observations and withdrawal affect corrections? Canonical Game curation is
  not implied. The overlay design must explicitly reopen today's
  no-editorial/no-patches scope.
- Which approved environments/domains, operational owners, source-offer
  surfaces, and independently deployable builds will be used? No resource
  ownership or deployment commitment follows from the illustrative topology.

## Official references

Citations above separate existing repository evidence, external documentation,
and recommendations. Vendor examples describe capabilities, not stack changes.

- [GNU AGPLv3][agpl-0] and [GNU GPL FAQ][gnu-aggregate].
- Cloudflare: [R2 public buckets][r2-public], [Workers access][r2-workers],
  [presigned URLs][r2-presigned], [CORS][r2-cors],
  [consistency/caching][r2-consistency], [cache purge][cache-purge], [R2
  image-delivery architecture][images-r2], [Images binding][images-binding].
- [WHATWG HTML `img` specification][html-img].
- OWASP: [REST security][owasp-rest], [authorization][owasp-authz],
  [random-token verifier storage][owasp-token-storage], [file
  uploads][owasp-upload].
- [WIPO copyright FAQ][wipo]; approve actual grants/applicable law, not generic
  internet-content assumptions.

[agpl-0]: https://www.gnu.org/licenses/agpl-3.0.html#section0
[agpl-1]: https://www.gnu.org/licenses/agpl-3.0.html#section1
[agpl-2]: https://www.gnu.org/licenses/agpl-3.0.html#section2
[agpl-4]: https://www.gnu.org/licenses/agpl-3.0.html#section4
[agpl-5]: https://www.gnu.org/licenses/agpl-3.0.html#section5
[agpl-6]: https://www.gnu.org/licenses/agpl-3.0.html#section6
[agpl-10]: https://www.gnu.org/licenses/agpl-3.0.html#section10
[agpl-13]: https://www.gnu.org/licenses/agpl-3.0.html#section13
[gnu-aggregate]: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
[gnu-containers]: https://www.gnu.org/licenses/gpl-faq.html#AggregateContainers
[gnu-remote]:
  https://www.gnu.org/licenses/gpl-faq.html#AGPLv3InteractingRemotely
[gnu-dual]: https://www.gnu.org/licenses/gpl-faq.html#ReleaseUnderGPLAndNF
[gnu-contributors]: https://www.gnu.org/licenses/gpl-faq.html#Consider
[r2-public]: https://developers.cloudflare.com/r2/buckets/public-buckets/
[r2-workers]:
  https://developers.cloudflare.com/r2/api/workers/workers-api-usage/#5-bucket-access-and-privacy
[r2-presigned]: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
[r2-cors]: https://developers.cloudflare.com/r2/buckets/cors/
[r2-consistency]:
  https://developers.cloudflare.com/r2/reference/consistency/#caching
[worker-cache]: https://developers.cloudflare.com/workers/runtime-apis/cache/
[cache-purge]:
  https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/#limitations-and-alternatives
[images-r2]:
  https://developers.cloudflare.com/reference-architecture/diagrams/content-delivery/optimizing-image-delivery-with-cloudflare-image-resizing-and-r2/
[images-binding]: https://developers.cloudflare.com/images/optimization/binding/
[html-img]:
  https://html.spec.whatwg.org/multipage/embedded-content.html#the-img-element
[owasp-rest]:
  https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
[owasp-api-keys]:
  https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html#api-keys
[owasp-jwt]:
  https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html#jwt
[owasp-authz]:
  https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
[owasp-token-storage]:
  https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#server-side-session-token-storage
[owasp-upload]:
  https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
[wipo]:
  https://www.wipo.int/en/web/copyright/faq-copyright#accordion__collapse__21
