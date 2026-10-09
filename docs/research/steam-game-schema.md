# First Steam game schema research

Research date: 2026-10-07. Recheck upstream documentation and access terms
before any real-source collection; this is a point-in-time investigation.

## Status and recommendation

**Point-in-time upstream research; synthetic local catalog implemented.** The
five catalog routes, reviewed control/snapshot schema, and local acceptance
fixtures implement the agreed metadata-only design, including verified composed
lifecycle/recovery behavior under issue #6. See the
[acceptance matrix](../catalog-acceptance.md) for the completed local quality
run. No real source, private producer integration, provisioning, or deployment
is approved. The initial consumer contract is **Steam App ID lookup for
application identity and release metadata**, including verified Game, Demo, and
DLC product types. Use one application catalog record per App ID; do not
introduce canonical Game identities, editorial edition labels, or cross-release
grouping initially. These design choices were confirmed in the design interview;
they do not approve an upstream source or authorize implementation. Do not
persist player counts or peaks, player histories, reviews or ratings, followers,
rankings, prices or price histories, or ownership estimates. These are excluded,
not deferred or optional tables. The upstream findings below remain research
evidence, not storage requirements.

The repository has D1, Drizzle's native Effect D1 service, Alchemy-owned
migrations, and separate minimal publication-control/complete-snapshot tables.
The pinned versions are Alchemy `2.0.0-beta.81`, Drizzle ORM/Kit
`1.0.0-rc.5-ab785fc`, and Effect/D1 SQL client `4.0.1`. This note does not
change that foundation or authorize real-source collection, further migration
generation, or deployment. Sources: [database](../database.md),
[schema](../../src/db/schema.ts), [package versions](../../package.json),
[contributor guidance](../../AGENTS.md).

The implemented synthetic architecture keeps collection off the request path and
serves complete validated observations with provenance. Real source rights and
the private producer's contract adoption remain prerequisites, not implemented
integration. Canonical Game reconciliation is outside the initial contract.
Sources: [architecture](architecture.md), [backlog](backlog.md). The design
interview recorded the domain vocabulary in the root
[glossary](../../GLOSSARY.md). See the
[domain documentation convention](../agents/domain.md).

## Evidence boundaries

- **Observed page facts:** the retrieved Firecrawl scrape of the
  [SteamDB charts seed](https://steamdb.info/app/3240220/charts/) was inspected
  through its end, including its player, monthly-breakdown, and review sections.
  Only short attributed observations appear here; no raw scrape or assets are
  committed.
- **Partially observed official store:** scraping the
  [Steam app page](https://store.steampowered.com/app/3240220/) returned an age
  gate. Its public metadata names Grand Theft Auto V Enhanced and describes an
  upgraded offering containing Grand Theft Auto V and Grand Theft Auto Online.
  The full store body was not verified. No birth date was supplied, cookies
  changed, or alternate route used to get past the gate.
- **Verified documentation and one narrow API observation:** Valve's linked
  Steamworks pages and terms were read. A single unauthenticated request to the
  [public current-player endpoint for this app](https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=3240220)
  returned HTTP 200 and JSON containing `response.player_count` and
  `response.result`. No count is reproduced here. Catalog, review, and price
  APIs were not live-tested; this one success does not establish ongoing access,
  freshness, redistribution rights, or a production integration.
- **Publisher corroboration:** Rockstar's
  [PC upgrade announcement](https://www.rockstargames.com/newswire/article/akk98a4o755825/free-upgrade-for-grand-theft-auto-v-on-pc-coming-march-4)
  was read for the relationship between the original and upgraded PC versions,
  not for Steam-specific field contracts.
- **Design direction:** the application-only boundary, metadata scope, snapshot
  semantics, and publication lifecycle below were agreed during the design
  interview and subsequently implemented locally with synthetic fixtures.
  Historical logical field names below are not the physical schema; consult
  `src/db/schema.ts` and reviewed migrations for implementation. Neither the
  contract nor its implementation verifies upstream field contracts or rights.
  The earlier canonical Game grouping is not adopted.

Some Firecrawl responses were cached. A retrieved page is evidence of returned
content, not proof of a simultaneous live upstream measurement. Exact volatile
values are deliberately omitted; source update timestamps are not substituted
for collection timestamps.

## What the charts seed actually exposed

Each observation in this table is attributed to the returned
[SteamDB app charts page](https://steamdb.info/app/3240220/charts/), not to a
live-tested Valve API. SteamDB is primary for what its own page displays, but
Valve is the primary source for Steam field definitions.

| Area              | Observed in the returned page                                                                                             | Boundary for a first schema                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Identity          | App ID `3240220`, title Grand Theft Auto V Enhanced, App Type Game                                                        | Source-specific product identity; not a universal game ID                                       |
| Catalog metadata  | Rockstar North as developer, Rockstar Games as publisher, Grand Theft Auto franchise, Windows support, release fields     | Candidate release metadata, subject to direct-source verification and rights approval           |
| Discovery/support | Tags, store genres, categories, language capabilities, controller support, Deck compatibility, account/anti-cheat notices | Not needed for the first lookup contract; do not collapse these into one genre or platform flag |
| Current players   | In-game badge and a Steam charts section with players right now                                                           | A time-sensitive app-scoped observation, not sales, owners, or daily unique users               |
| Player summaries  | Explicit 24-hour peak and all-time peak, with a date for the latter                                                       | SteamDB historical summaries; not supplied by the documented current-player method              |
| Player history    | Chart-initialization placeholder and a sign-in-limited-data notice                                                        | No timestamped graph series was exposed by this scrape                                          |
| Monthly players   | Headers for Month, Peak, Gain, % Gain, Average, and Avg % Gain; no populated rows; averages require sign-in               | Column labels do not establish available monthly values, sampling, or averaging semantics       |
| Store activity    | Ranks for daily active users, top sellers, and wishlist activity; follower and review counts                              | Ranks are not counts; do not infer DAU or sales quantities                                      |
| Reviews           | SteamDB rating, positive/negative counts and percentages, summary label, review count                                     | Distinct calculated and raw aggregates; the review-history graph requires sign-in               |
| Prices            | Current regional prices/discounts, converted prices, lowest-recorded prices, promotion timing, and an unavailable entry   | Regional offer observations, not a globally applicable game price                               |
| Price history     | Initialization placeholder and sign-in-limited history notice                                                             | No actual historical price series extracted                                                     |
| Other histories   | Followers graph placeholder/sign-in limitation; older app-change history limited by sign-in                               | No history backfill demonstrated                                                                |
| Estimates/assets  | Named third-party owner estimates, asset URLs, technologies, packages, bundles, depots/build data                         | Owner estimates are excluded from storage; asset URLs are not reuse permission                  |

The body and page metadata also repeat player summaries. Treat these as repeated
representations from one page, not independent corroboration. Absence of graph
points in the extraction does **not** prove that the website lacks those points;
it limits this research's coverage. Source:
[SteamDB charts seed](https://steamdb.info/app/3240220/charts/).

## Identity: game versus release, edition, and offer

Valve defines an application as the main representation of a product on Steam,
identified by a unique App ID. Its application types include games, software,
DLC, and demos; DLC and demos can have separate IDs linked to a base app.
Therefore an App ID must not automatically mean a standalone canonical game.
Source:
[Valve applications](https://partner.steamgames.com/doc/store/application).

Valve separately defines a package as a collection of applications and depots,
comparable to a SKU/license; purchasing or activating it grants access to its
contents. Packages are not interchangeable with game or application IDs. Source:
[Valve packages](https://partner.steamgames.com/doc/store/application/packages).

**Agreed identity boundary:**

- **Steam Application:** the stored product identity, identified by its Steam
  App ID. Initially admit only verified Game, Demo, and DLC product types;
  software, other types, and unknown types are not admitted. Valve's Game type
  is a product classification, not a canonical Game identity.
- **Game:** a curated, source-independent identity for the underlying work. This
  remains a distinct domain concept, but no Game record, local Game ID,
  association, or grouping lookup is part of the initial design.
- **Base Application:** the Steam Application explicitly identified by the
  approved source as a demo's or DLC's base product. Preserve an optional
  verified base App ID even when its target is not in this catalog. An absent
  relationship is unknown, not grounds to invent one or reject the application.
- **Release metadata:** belongs to the Steam Application, not the underlying
  work's original release. Steam is the distribution platform; Windows is an
  operating system. Do not create one application record per OS.
- **Edition and offer/package/bundle:** outside the first catalog design.
  Preserve source titles, but do not extract an editorial edition taxonomy or
  model purchasable groupings.

For the seed, the conceptual record is a Steam Application titled **Grand Theft
Auto V Enhanced**, App ID `3240220`, subject to approved-source verification of
its Game product type. **Enhanced** stays in the title, not an editorial edition
field. The observed store metadata supports an upgraded GTA V/GTA Online
offering, but does not establish a canonical Game identity. The earlier proposal
to group it under Grand Theft Auto V is not adopted. Sources:
[official store metadata](https://store.steampowered.com/app/3240220/),
[SteamDB page identity](https://steamdb.info/app/3240220/charts/). Rockstar
describes the upgraded PC version and continued support for the previous
version, with separate GTA Online instances whose players cannot share sessions
across versions. This supports distinguishing versions instead of treating the
upgrade as just a title change. Source:
[Rockstar PC upgrade announcement, PC Support](https://www.rockstargames.com/newswire/article/akk98a4o755825/free-upgrade-for-grand-theft-auto-v-on-pc-coming-march-4).
Do not create or merge Legacy, console, standalone Online, or other related
records from names alone; their specific Steam identifiers and cross-platform
identity mappings were not verified here. Matching titles do not establish
identity, and a base-application link does not establish canonical Game
grouping. The current-player API measures the whole app; no Story Mode versus
GTA Online split is established by its contract. Source:
[Valve current-player method](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers).

## Verified Valve API contracts and remaining gaps

### Current Steam players

`ISteamUserStats/GetNumberOfCurrentPlayers/v1` takes a `uint32` App ID and
returns the total players currently active in that app on Steam, excluding
players not connected to Steam. This is concurrent Steam-connected activity, not
all-platform population or unique daily players. The documentation does not
provide historical peaks or chart series through this method. Source:
[Valve current-player method](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers).

Valve's method page prints the partner host, but its API overview distinguishes
the public `api.steampowered.com` host from the publisher-only partner host,
which requires a publisher key even for normally keyless methods. The proposed
public host was successfully tested once without credentials for this app; do
not copy the partner URL and assume anonymous access there. The returned JSON
had an integer `player_count` and a `result` field, but no measurement
timestamp. Our retrieval time must not be presented as a Valve-provided
measurement time. Source:
[observed public API response](https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=3240220).
Host/authentication sources:
[method reference](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers),
[Web API overview](https://partner.steamgames.com/doc/webapi_overview).

SteamDB says its concurrent counts come from Valve's API, and describes
sampling/caching that limits update frequency. Its tracked all-time maximum is
therefore a SteamDB summary, not a guarantee that this project could reconstruct
an exact continuous-time peak. Source:
[SteamDB player-count explanation](https://steamdb.info/faq/#why-steamdb-s-player-count-peaks-are-higher-than-other-sites).
**Scope decision:** current players, peaks, and histories are excluded from the
database. The API findings are retained only as research evidence; no player
collector, observation table, or polling policy is proposed.

### Catalog metadata

Valve documents `IStoreService/GetAppList/v1` as a paginated list of store apps,
with game/type filters, a language-description filter, a modified-since filter,
and a required Web API key. This page does not establish a complete
release-detail response containing every field displayed on SteamDB. Source:
[Valve store service](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList).
That contract also describes `last_modified` as a Unix timestamp for information
or price changes and `price_change_number` as a change marker indicating that a
price may have changed. Neither is an actual price or historical-price series,
and neither should be confused with SteamDB's globally incrementing PICS
changenumber. Sources:
[Valve store change fields](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList),
[SteamDB changenumber definition](https://steamdb.info/faq/#changenumber).

`GetSchemaForGame` documents stats and achievements, not a full store catalog
schema. Source:
[Valve stats schema method](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetSchemaForGame).
No official contract for the frequently cited store `appdetails` endpoint was
verified in this research, and it was not live-tested. Do not label anticipated
`appdetails` fields, their units, or their stability as documented guarantees.
The permitted source for developer/publisher names, OS support, and release date
must still be selected and verified before making those fields required.

### Reviews and calculated ratings

The retrieved legacy review-list documentation marks the store `appreviews`
endpoint deprecated and points to `IUserReviewsService/GetAppReviews/v1`. The
current documentation describes public review pages, optional app-associated
publisher authentication, language/purchase/off-topic filters, anonymous
caching, and rate limiting. Aggregate score fields in `query_summary` are
returned only on the first page with the all-review-type filter. Sources:
[legacy notice](https://partner.steamgames.com/doc/store/getreviews),
[current review service](https://partner.steamgames.com/doc/webapi/IUserReviewsService#GetAppReviews).

Relevant documented aggregates include `total_positive`, `total_negative`,
`total_reviews`, `review_score`, and `review_score_desc`. `num_reviews` is the
number on the current page, not the total. The language defaults and
purchase-type/off-topic filters affect interpretation; an unspecified “review
count” or “rating” would conceal scope. Source:
[Valve review response and filters](https://partner.steamgames.com/doc/webapi/IUserReviewsService#GetAppReviews).

Valve describes store scores for the past 30 days and the product's lifetime,
counting purchases made by the reviewing account rather than key activations.
This verifies the Steam-side purchase distinction independently of SteamDB; it
does not make every API filter combination equal to the displayed store score.
Source: [Valve user reviews](https://partner.steamgames.com/doc/store/reviews).
The current API separately documents Unix-second review timestamps and playtime
in minutes; those are review/author properties, not player concurrency or a
historical aggregate-count archive. Source:
[Valve review field units](https://partner.steamgames.com/doc/webapi/IUserReviewsService#GetAppReviews).

SteamDB documents an adjusted rating biased toward the neutral midpoint using
positive/negative totals; it says its rating uses all purchase types, unlike the
Steam store rating. A published calculation is not permission to crawl or
redistribute its underlying dataset. Source:
[SteamDB rating explanation](https://steamdb.info/blog/steamdb-rating/). **Scope
decision:** exclude reviews entirely, including aggregate counts, ratings, text,
authors, and Steam IDs. No review storage or ingestion is proposed.

### Prices and availability

The observed SteamDB table distinguishes regional/current/converted/lowest
prices and contains an unavailable entry. SteamDB also explains that several
regional groups use USD pricing, so currency alone cannot identify a market.
Sources: [seed price table](https://steamdb.info/app/3240220/charts/),
[SteamDB regional pricing explanation](https://steamdb.info/faq/#what-is-cis-sasia-latam-and-mena).
Valve's package model reinforces that a purchasable license is separate from an
app. Source:
[Valve packages](https://partner.steamgames.com/doc/store/application/packages).

**Scope decision:** exclude prices and price histories, including regional
prices, discounts, converted prices, and lowest-recorded prices. No offer table
or price ingestion is proposed. The following unit findings are research only.
Valve's supported-currency documentation specifies reporting units, including
USD cents, JPY sen, and KWD hundredths of a dinar, plus currency-specific charge
increments. Do not substitute ISO currency minor-unit exponents: that would not
match these documented Steam units for JPY or KWD. Valve also documents distinct
regional USD pricing groups, independently confirming that currency is not a
market identifier. Source:
[Valve supported currencies and regions](https://partner.steamgames.com/doc/store/pricing/currencies).
These pricing-tool units do not verify the scale of an untested store endpoint.
SteamDB's formatted table displays currency amounts, not an integer API field
contract. Source: [seed price table](https://steamdb.info/app/3240220/charts/).
These price observations do not justify any fields in the metadata-only schema.

## Agreed catalog design and historical logical representation

The table below records the interview's logical field recommendations, **not
SQL, Drizzle code, or a migration**. Its proposed name `steam_applications` is
not the implemented table name: the reviewed physical schema uses
`steam_application_snapshot` and `steam_application_publication`. See
[database guidance](../database.md). No `games` or `steam_releases` table is
needed for App ID lookup. Publication withdrawal uses separate durable control
with generation fencing, not a flag inside deletable metadata. The agreed HTTP,
payload, and atomic-persistence requirements are recorded in the
[catalog contract](../steam-catalog-contract.md). The reviewed synthetic
physical schema/migrations exist; actual source rights and permitted control
retention remain unapproved. This research note is not a migration.

Do not add a generic entity/attribute store or a raw-upstream JSON blob;
excluded data must not be retained indirectly inside metadata JSON, stored
ingestion payloads, or history tables. Continue using synthetic records until
source access, storage, and public-redistribution rights are approved.

### Historical `steam_applications` proposal: one English snapshot per App ID

| Field                                | Proposed storage and meaning                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `steam_app_id`                       | Integer primary key; positive and within the documented `uint32` App ID range    |
| `product_type`                       | Required verified Game, Demo, or DLC classification; not canonical Game identity |
| `title`                              | Required nonblank English-snapshot title; neither unique nor an identifier       |
| `base_app_id`                        | Nullable verified base App ID for a demo or DLC; target need not be cataloged    |
| `release_date_kind`                  | Exact date, non-exact window, or unknown                                         |
| `release_date`                       | Date-only `YYYY-MM-DD` value when exact; otherwise null                          |
| `release_window`                     | Source-supplied non-exact window such as Q4 2027; otherwise null                 |
| `release_status`                     | Verified upcoming, released, or unknown; independent of date precision           |
| `developers_json`, `publishers_json` | Nullable bounded arrays of names, not normalized company identities              |
| `supported_os_json`                  | Nullable bounded array of verified OS codes; unknown is not an empty list        |
| `metadata_source_url`                | Required permitted source URL, not merely a documentation link                   |
| `metadata_language`                  | Required explicit English source-snapshot language; no inferred translation      |
| `metadata_observed_at`               | Required integer UTC Unix seconds for collection/observation                     |
| `extractor_version`                  | Required nonblank identifier of the normalization/extraction contract            |
| `ingestion_event_id`                 | Required nonblank delivery identity for traceability, not update authority       |

The integer choice follows the documented App ID input type, not an observed API
response payload. Source:
[Valve App ID parameter](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers).
The complete approved field contract, including product types and base links,
still needs verification; this table does not claim a live-tested detail API.

### Snapshot and validation boundary

- Each update is a complete replacement from one approved source, observation,
  and English language snapshot. Optional unknown fields are explicit nulls;
  omitted contract fields are invalid, not patches. Previously known metadata
  becomes unknown if the new valid snapshot explicitly says it is unknown.
- Do not silently mix sources under one URL/timestamp or claim translation.
  Multiple languages, patch semantics, and mixed-source field provenance would
  require a subsequent design.
- Require nonblank title/provenance identifiers, allowed product types, valid
  App ID ranges, and nonnegative integer observation times. Base links must be
  verified rather than title-derived; do not require a local foreign-key target.
- Apply the [catalog contract](../steam-catalog-contract.md)'s strict snake_case
  JSON shape, 32 KiB body limit, string/list bounds, English language, and OS
  codes. Null and empty lists are distinct; unknown fields and duplicates are
  invalid, not silently corrected.
- Enforce consistency between date kind and its value: exact date only, source
  window only, or neither for unknown. Validate real calendar dates rather than
  string shape alone. Never turn a quarter/year into an invented calendar day.
- Upcoming/released status is separately source-verified. An announced exact
  date does not establish that release occurred; clock passage does not change
  stored status. These fields describe the Steam application, not an original
  all-platform release.
- App ID supports the only initial lookup. No Game, title, base-app reverse
  lookup, OS, or freshness index is justified by the agreed consumer contract.

### Latest-state ordering, not a replay ledger

For an admitted, publishable application:

- A newer `metadata_observed_at` replaces the snapshot.
- An older observation cannot overwrite current state.
- Equal-time identical snapshot content is a no-op; equal-time differing
  snapshot content is rejected as a conflict. Delivery event IDs do not make
  otherwise identical metadata different or break ordering ties. Equality
  includes metadata and provenance: JSON object order/escaping and OS order do
  not matter; credit order, Unicode spelling, URL spelling, and extractor
  version do. See the [catalog contract](../steam-catalog-contract.md).
- Each HTTP ingestion request carries exactly one application snapshot and
  returns a synchronous outcome. Event IDs identify deliveries, not freshness or
  editorial authority; do not require global uniqueness across application rows.
  There is no stored ingestion history, cross-app atomicity, or exactly-once
  delivery-processing guarantee.
- A correction requires a genuinely newly observed, validated snapshot, not an
  invented observation timestamp. The contract requires separate ingestion/admin
  bearer roles, source-policy matching, publication-generation fencing, an
  observation floor and five-minute future tolerance, versioned routes, and
  atomic outcome classification. These server behaviors have synthetic Node and
  workerd acceptance coverage and a completed local quality run. Actual private
  producer adoption and clock synchronization remain gates.
- After transport/server uncertainty, retry the same body/event/generation; lost
  successful responses can return `unchanged`, or `ignored_stale` after a newer
  accepted observation. This is not replay-ledger/exactly-once behavior.
  Obsolete generations require reacquisition and genuine recollection. The
  second-precision floor is a guardrail, not proof of collection order.

The composed workerd lifecycle constructs observations after acquisition and
stamps actual local Unix seconds, waiting for genuinely newer observations
rather than inventing floor-relative timestamps. Fixture-only gates order real
HTTP batches/reads and delay captured results through competing commits;
rollback and restart remain synthetic local acceptance. Interactive transactions
are unsupported; the implementation uses ordered native D1 batches and
Alchemy-owned migrations. Sources: [database boundary](../database.md),
[acceptance matrix](../catalog-acceptance.md).

### Last-known serving and publication withdrawal

Lookup serves the last approved snapshot and its observation time. No real-time
freshness promise, TTL, or stale/current flag is part of the initial contract.
Do not infer release status from the clock or fetch upstream on the request
path. The [catalog contract](../steam-catalog-contract.md) defines anonymous
versioned lookup, private role-separated writes, response shapes, and no-store
primary reads. All five catalog routes are implemented locally with synthetic
policies; production abuse limits, operations, credentials, and access budgets
remain gates. `/health` reports process health only, not catalog/crawler
readiness.

An upstream omission or delisting does not automatically delete or withdraw a
record. Publication withdrawal is an explicit privileged action independent of
snapshot ingestion. It atomically advances publication generation, marks
withdrawn, and deletes metadata. Separate durable control retains only App ID,
eligible/withdrawn state, generation, and generation-issued timestamp, subject
to express retention approval. Admin transitions compare an expected generation;
ordinary ingestion cannot change control. After an uncertain admin response, GET
and reconcile; do not blindly substitute a newer expected generation.
Reinstatement authorizes a new generation without restoring metadata, and
requires fresh authorized collection. Old queued generations cannot republish.
There is no control expiry/forget operation initially. Real publication is
blocked if minimal-control retention is not permitted.

Lookups whose primary database read starts after withdrawal commits must not
serve metadata; previously read/in-flight responses and consumer-held copies
cannot be recalled. No CDN/application cache or replica optimization is
selected.

## Mapping the seed without inserting data

| Candidate                                           | Evidence and proposed treatment                                                                                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steam App ID `3240220`                              | Observed on the [SteamDB page](https://steamdb.info/app/3240220/charts/); identifies the Steam Application; no canonical Game ID is introduced                                                                                                |
| Release title Grand Theft Auto V Enhanced           | SteamDB body and [official store age-gate metadata](https://store.steampowered.com/app/3240220/) agree on the name                                                                                                                            |
| Canonical Game grouping / edition Enhanced          | Not adopted; preserve Grand Theft Auto V Enhanced as the application title without a Game association or editorial edition field                                                                                                              |
| Developer Rockstar North / publisher Rockstar Games | Observed on [SteamDB](https://steamdb.info/app/3240220/charts/); leave unpopulated until verified through an approved direct source                                                                                                           |
| Supported OS Windows                                | Observed on [SteamDB](https://steamdb.info/app/3240220/charts/); direct-source verification still required                                                                                                                                    |
| Steam release date 2025-03-04                       | SteamDB release fields agree on the day but show different times; retain day precision only after approved-source verification; not the original game's release date. Source: [seed release fields](https://steamdb.info/app/3240220/charts/) |
| Players, peaks, reviews, prices                     | Excluded from database storage by the confirmed metadata-only scope                                                                                                                                                                           |
| Product type / base App ID / release status/window  | Populate only after approved-source contract verification; no base link or release status is fabricated from title or date                                                                                                                    |
| Provenance timestamps/event identifiers             | Generated by future approved ingestion; none fabricated from scrape metadata or relative page ages                                                                                                                                            |

This is a conceptual mapping, not a seed dataset. The implemented local catalog
continues using synthetic fixtures while rights and private producer adoption
are reviewed, as required by [contributor guidance](../../AGENTS.md) and the
[research backlog](backlog.md).

## Access, rights, and redistribution gate

SteamDB explicitly disallows automatic scraping/crawling and directs readers to
Steam itself; its academic exception requires permission and is not a commercial
data license. Its API FAQ points to partnership contact, not a public API
contract available for this project. Sources:
[SteamDB scraping policy](https://steamdb.info/faq/#can-i-use-auto-refreshing-plugins-or-automatically-scrape-crawl-steamdb),
[academic policy](https://steamdb.info/faq/#can-i-scrape-steamdb-for-academic-purposes),
[API FAQ](https://steamdb.info/faq/#does-steamdb-have-an-api). The initial
FAQ/rating requests were made together; after learning the policy, no further
SteamDB requests were made. The retrieved seed scrape is research evidence, not
permission for ingestion, refreshing badges, or chart backfill.

Valve's Web API terms license distribution to end users for personal use via the
specified application, with restrictions including confidential keys,
non-affiliation, required disclaimers, call limits, and termination rights. They
reserve rights not expressly granted. This is not a general open-data license or
automatic approval for a commercial bulk/API redistribution service. Review the
intended managed-service and API-consumer uses before collection or publication.
Source:
[Valve Web API terms, sections 1–3 and 9–11](https://steamcommunity.com/dev/apiterms).
Those terms also require compliance with the Subscriber Agreement. Its content
license/reproduction restrictions and Automation section must be assessed
alongside any explicit API permission; do not infer that documented API access
licenses arbitrary store scraping or commercial republication. This note is not
a legal determination. Sources:
[Valve API terms, section 2](https://steamcommunity.com/dev/apiterms),
[Steam Subscriber Agreement, sections 2 and 4](https://store.steampowered.com/subscriber_agreement/).

**Proposed gate:** approve a source-by-field policy covering access, storage,
attribution, permitted public redistribution, retention, corrections/deletion,
and suspension. Treat publisher descriptions, screenshots, trailers, user review
text, and trademarks separately from short factual metadata; their visibility is
not evidence of a redistribution grant. Do not download or proxy assets in this
experiment. Keep data rights separate from the repository's server-code license,
as required by [contributor guidance](../../AGENTS.md) and the
[business model](../business-model.md).

Stop on age/login gates, HTTP access blocks, anti-bot challenges, or rate
limits; do not switch proxies, identities, cookies, or endpoints to circumvent
them. No chart AJAX probing, sign-in, token dumping, raw HTTP fetching, or
browser challenge bypass was used in this research.

## Source coverage and obstacles

| Primary source                                                                                                                                                                                                                                                            | Coverage/result                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SteamDB seed charts](https://steamdb.info/app/3240220/charts/)                                                                                                                                                                                                           | Retrieved scrape inspected in full; static metadata and player/review/price summaries observed; graphs not extracted; monthly rows empty and histories sign-in-limited |
| [Official Steam app](https://store.steampowered.com/app/3240220/)                                                                                                                                                                                                         | Scrape stopped at age gate; title/description metadata observed; full catalog details not verified                                                                     |
| [SteamDB FAQ](https://steamdb.info/faq/)                                                                                                                                                                                                                                  | Access rules, source attribution, player-count explanation, regional-price semantics; policy prevents treating SteamDB as an automated source                          |
| [SteamDB rating article](https://steamdb.info/blog/steamdb-rating/)                                                                                                                                                                                                       | Rating calculation and purchase-type distinction verified as SteamDB's own claims; no calculation reproduced                                                           |
| [Valve applications](https://partner.steamgames.com/doc/store/application) and [packages](https://partner.steamgames.com/doc/store/application/packages)                                                                                                                  | Product/App ID versus SKU/license distinction                                                                                                                          |
| [Valve user stats](https://partner.steamgames.com/doc/webapi/ISteamUserStats), [API overview](https://partner.steamgames.com/doc/webapi_overview), and [public player endpoint](https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=3240220) | Current-player scope, stats-schema boundary, public/partner-host distinction; one successful unauthenticated player request, no histories                              |
| [Valve store service](https://partner.steamgames.com/doc/webapi/IStoreService)                                                                                                                                                                                            | Catalog-list contract, not full store-detail coverage                                                                                                                  |
| [Valve legacy reviews](https://partner.steamgames.com/doc/store/getreviews) and [current review service](https://partner.steamgames.com/doc/webapi/IUserReviewsService)                                                                                                   | Deprecation and replacement, scoped aggregate/filter semantics; no live API test                                                                                       |
| [Valve user reviews](https://partner.steamgames.com/doc/store/reviews) and [currencies](https://partner.steamgames.com/doc/store/pricing/currencies)                                                                                                                      | Steam score windows/purchase scope; reporting-unit and regional-price definitions, not a tested price endpoint                                                         |
| [Rockstar PC upgrade announcement](https://www.rockstargames.com/newswire/article/akk98a4o755825/free-upgrade-for-grand-theft-auto-v-on-pc-coming-march-4)                                                                                                                | Publisher corroboration of previous/upgraded PC versions and separate Online sessions; no other Steam IDs verified                                                     |
| [Valve API terms](https://steamcommunity.com/dev/apiterms) and [Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)                                                                                                                               | Conditional access/distribution terms and content/automation restrictions; commercial API suitability still requires review                                            |

**Implementation status:** the identity boundary and the
[catalog contract](../steam-catalog-contract.md)'s HTTP/payload, equality,
ordering, atomicity, and generation-fenced lifecycle requirements are
implemented as a synthetic local capability under parent #1. Reviewed SQL and
schema remain under the existing [database process](../database.md); the
[acceptance matrix](../catalog-acceptance.md) separates Node HTTP coverage from
workerd/D1 behavior and completed local command results. This note independently
authorizes no collection, migration, provisioning, or deployment. **Before real
publication:** select a permitted metadata source, verify its actual field
contracts, resolve redistribution and minimal-control retention rights, agree
the private producer's integration behavior, and approve production
security/operational limits and deployment. Player observations, histories,
reviews, followers, rankings, prices, and ownership estimates remain outside
scope; do not generate tables, columns, or collectors for them.
