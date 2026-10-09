# Synthetic catalog acceptance

## Scope and evidence status

This is the acceptance map and local verification record for
[parent #1](https://github.com/Quick-Release/gq-games-api/issues/1) and
[lifecycle #6](https://github.com/Quick-Release/gq-games-api/issues/6). The five
catalog routes and local synthetic persistence/lifecycle are implemented and
verified. All seven required quality commands passed; Node reported 136 tests
across eight files, and local workerd reported both integration tests passing.
This establishes only the synthetic capability, not production readiness. The
[fixed normative contract](https://github.com/Quick-Release/gq-games-api/blob/0a560ab47e331b478e2cadc440567dc413459e4b/docs/steam-catalog-contract.md)
remains authoritative; the [current contract](steam-catalog-contract.md)
preserves its requirements while recording implementation status.

Node HTTP tests use the Hono application with service doubles (and selected D1
failure stubs). They establish HTTP behavior, not Cloudflare atomicity or
binding behavior. Workerd tests run the actual Hono/Effect/native D1 stack in an
isolated local Alchemy fixture. Table entries identify the tested sections so
the completed local run is reproducible.

## Parent HTTP categories

All paths below are relative to the repository root. Quoted phrases identify
searchable test titles or section comments; App IDs identify literal fixture
cases when a larger test contains multiple sections.

| Parent acceptance category                                                                                                                                                                              | Node HTTP evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Local workerd evidence                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lookup success, malformed IDs, identical missing/withdrawn 404, nulls, private-field exclusion; no-store/server IDs                                                                                     | `tests/lookup-http.test.ts`: “returns the complete public representation”, “rejects malformed identifier”, “accepts the canonical boundary identifier”, “uses no-store”; transport assertions also appear in all four HTTP suites                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/integration/catalog.test.ts`: `notFoundIds` (absent/orphan/eligible-empty/withdrawn cases), `countedLookup`, `publicCases`, malformed/boundary HTTP IDs; `tests/integration/catalog-lifecycle.ts`: `expectPublic`, unknown 8009 versus withdrawn 8001, per-response `request` checks                                               |
| Every role/route, missing/invalid credentials, wrong role, missing configuration, independent rotation, HTTPS/local distinction, auth before parsing; ingestion cannot administer                       | `tests/catalog-http.test.ts`: parameterized “separates roles”, “rejects missing, unknown, and malformed credentials”, “fails closed”, “requires HTTPS”, “rotates each role”, “authenticates and checks TLS and IDs”; `tests/snapshot-http.test.ts`: “enforces ingestion role”, “remaining malformed credentials”, “rotates snapshot”, “permits local snapshot HTTP”; `tests/publication-http.test.ts`: “checks configuration, credentials, role, TLS”, “rotates admin and ingestion”, “allows insecure local transport”; `tests/lookup-http.test.ts`: “keeps public lookup anonymous across private configuration failures” and “requires HTTPS for anonymous lookup” | `tests/integration/catalog.test.ts`: representative private HTTP requests and “A malformed JSON body makes auth-before-parsing externally observable”; lifecycle acquisition/submission/admin use separate ephemeral roles. Exhaustive security/configuration combinations belong to Node evidence, not a production TLS/rotation rollout |
| Bodyless acquisition, uninitialized admin GET, generation-checked PUT, uncertain admin reconciliation                                                                                                   | `tests/catalog-http.test.ts`: “returns uninitialized publication control”, “rejects even whitespace”, “accepts an empty body”, “cancels after the first nonempty chunk”; `tests/publication-http.test.ts`: command/generation validation and “reconciles a simulated lost successful response”                                                                                                                                                                                                                                                                                                                                                                        | `tests/integration/catalog.test.ts`: initial `inspect(1001)`, absent/populated admin cases and “Simulate a lost success”; lifecycle `withdrawalCommand`, discarded admin response, GET inspection and explicit new reinstatement decision; stale same-target-state commands fail                                                          |
| JSON object/media/encoding/UTF-8, malformed JSON, actual 32 KiB limits with absent/misleading lengths and streams                                                                                       | `tests/snapshot-http.test.ts`: “distinguishes media/encoding”, “bounds actual bytes”, “bounds native byte-stream reads”; `tests/publication-http.test.ts`: “rejects unsupported media”, “distinguishes malformed JSON”, “enforces the actual 32 KiB byte limit”, “stops and cancels oversized default streams”, “bounds native byte reads”; acquisition body-read tests above                                                                                                                                                                                                                                                                                         | `tests/integration/catalog.test.ts`: snapshot/publication transport rejection cases and “Actual streamed HTTP bytes without Content-Length”. Node adversarial stream/length tests supplement, rather than replace, real Worker transport evidence                                                                                         |
| Required/unknown/excluded fields at every nesting, Unicode code points, blank/edge whitespace, list bounds/duplicates/OS, calendar/tag strictness, base links, language, seconds/future tolerance/floor | `tests/snapshot-http.test.ts`: “requires every field and explicit nulls”, “checks Unicode code-point bounds”, “validates product/base identity”, “requires en, integer seconds, exact future tolerance”, “strict fields on every date variant”, “non-object nested containers”, “Unicode edge whitespace”, “list, base-link, language, and timestamp boundary failures”; `tests/publication-http.test.ts`: strict keys/states/opaque-generation bounds                                                                                                                                                                                                                | `tests/integration/catalog.test.ts`: `preserve` rejection cases, scalar Unicode/NUL cases 4201–4209, floor and +300/+301-second cases 1002/1004, public product/date/null variants; lifecycle below-floor invalid candidate and obsolete-generation denial                                                                                |
| Exact approved source/extractor policy, denial without mutation, reserved sources only, no request-path fetch; policy is not rights approval                                                            | `tests/snapshot-http.test.ts`: “denies missing/malformed/unmatched or non-synthetic source policies”, “complete exact policy tuples”, “parser-repaired, lookalike, and secret-bearing URLs”, “approved Unicode source URLs”, “source/extractor code-point limits … without fetching sources”; `tests/lookup-http.test.ts`: “never fetches an upstream”                                                                                                                                                                                                                                                                                                                | `tests/integration/catalog.test.ts`: `preserve` source/extractor denials, exact source spelling 4209 and HTTP source-denial cases; lifecycle uses only `catalog.example.invalid`/`synthetic-v1`, with no collector. These assertions do not approve any real source                                                                       |
| All success outcomes/status codes, bounded safe issues/errors/diagnostics, server correlation not replay identity; no secret/content/SQL/driver disclosure                                              | `tests/snapshot-http.test.ts`: “maps all captured outcomes/failures”, safe-field tests and defect/read-failure sanitization; `tests/publication-http.test.ts`: “sanitizes permanent and unknown native SQL failures”, “maps generation mismatch”, “sanitizes defects”; `tests/catalog-http.test.ts`: “maps typed failures to safe envelopes”, “sanitizes unexpected defects”, “sanitizes errors thrown while reading the request body”; `tests/lookup-http.test.ts`: “maps %s without exposing private causes”, defect/temporary-failure tests; `tests/catalog-database-errors.test.ts`: “maps driver failures consistently across all five routes”                   | `tests/integration/catalog.test.ts`: HTTP outcome/error assertions and credential-free file/diagnostic checks; lifecycle `request`, `failure`, `snapshotOutcome`, discarded response retries and sanitized injected HTTP failure. Unexpected HTTP 500 mappings have Node/stub evidence, not real production outage evidence               |

## Parent local workerd/D1 categories

`tests/integration/catalog.test.ts` has one composed test, “persists
generation-fenced snapshots and publication changes, serves only eligible
applications, and rolls back native D1 batches across workerd restarts”. The
sections below are inside it. `catalog-lifecycle.ts` exports
`verifyHttpLifecycle`, invoked by that test; it is **not** a separately
discovered Vitest test file.

| Parent acceptance category                                                                                                                                         | Actual workerd test/section                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned conditional upsert/RETURNING/batch/result decoding, commit-before-success, full replacement/null clearing, migrations/restart without replay                | `tests/integration/d1.test.ts`: “runs generated migrations and Effect-native Drizzle CRUD in local workerd”; `catalog.test.ts`: first submission, “Full replacement clears ALL formerly known nullable fields”, `windowed` replacement, final audit and “New workerd/Alchemy process … No reseeding”. Node `snapshot-http`/`publication-http` completion-wait tests check HTTP waiting only                           |
| First/newer/stale/equal-identical with different event ID/equal-different; all accepted metadata/event/provenance preserved on no-op/denial                        | `catalog.test.ts`: `initial`, `preserve`, `cleared`, `windowed`; literal persisted-row audits on stale/equal/conflict/generation/floor/source paths. Lifecycle 8001 discards successful snapshot response, retries the same body/event/generation as `unchanged`, accepts a genuinely newer observation, then retries original as `ignored_stale`                                                                     |
| Semantic JSON key/escape and OS-order equality; credit/provenance/Unicode/null-empty significance; duplicates rejected before storage                              | `catalog.test.ts`: “Equivalent decoded strings, reversed object keys, and OS order”, “Every independently mutable equality field”, Unicode/NUL/spelling 4201–4209, `preserve` duplicate rejection; “Real Hono PUT also compares decoded content”. Node strict-validation cases supplement these persistence checks                                                                                                    |
| Competing newer/older against absent/existing snapshots converge to greatest observation; equal-different conflicts                                                | `catalog.test.ts`: “Scrambled unique times” (3101/3102), “Equal differing contenders” (3201/3202); lifecycle “Absent and existing snapshots” (8002/8003), explicit batch release order with both responses held through competing commits                                                                                                                                                                             |
| Captured per-operation classifications rather than post-write reads; no-op/denied preserve full state                                                              | `catalog.test.ts`: contender result assertions, `preserve`, “Both invocations arrive at D1” and “Same-state admin racing withdrawal”; lifecycle held low/high results and withdrawal versus acquire/submit/change loops. Expectations derive from submitted observations and coordinated commit order, not a later lookup used to construct expected classifications                                                  |
| Later-statement failure rolls back earlier mutations; no production fault endpoint; narrow audit only                                                              | `catalog.test.ts`: acquisition `/fixture/fail/4001`, “The binding appends a REAL failing SQL step” (4101 insert/replacement), “Late REAL SQL fault” (7004/7005 control advancement/deletion/absent initialization); lifecycle “A fixture-only later SQL failure” (8004 HTTP snapshot failure, sanitized error, no row/control mutation, same-body retry). Fault hooks live only in `tests/fixtures/catalog-worker.ts` |
| Concurrent acquisition establishes one generation; repeat preserves eligible state/floor, cannot lift withdrawal; submit cannot initialize                         | `catalog.test.ts`: first/repeated/withdrawn acquisition, “Two cold IDs” (3001/3002), absent-control submit 1003; lifecycle “Concurrent first acquisitions” (8002), all real HTTP requests arrive before release and captured responses agree                                                                                                                                                                          |
| Withdrawal existing/absent, repeated current-generation command, acquisition/ingestion races, full purge/minimal control, newer times cannot bypass withdrawal     | `catalog.test.ts`: 7002 absent/7003 populated withdrawal, same-state/mismatch audits, service commit-order races 7100–7121 and cold acquisition/null-expectation withdrawal, final four-control-column/table audit; lifecycle 8001 purge and both commit orders against acquisition/submission/admin (8100–8105), narrow snapshot audits                                                                              |
| Reinstatement restores nothing, new generation/floor, old queued generations denied, floor violation mutation-free, fresh matching publication, stale-admin safety | `catalog.test.ts`: 7003 reinstatement/floor/old-generation checks and representative admin HTTP flows; lifecycle 8001 GET reconciliation, explicit new eligible command, still-404 lookup, unchanged acquisition, old-generation and below-floor denials, genuinely recollected matching submission, stale commands for both target states                                                                            |
| Single primary-query eligibility and post-withdrawal read-start visibility; pre-read/in-flight response may finish                                                 | `catalog.test.ts`: `countedLookup` forwards actual workerd prepare/execution calls and asserts one primary read over synthetic eligibility states; lifecycle “A lookup which already read may finish AFTER withdrawal”, `pre-withdrawal-read`/`post-withdrawal-read`: real read result held through withdrawal is allowed 200, read released after withdrawal is 404                                                  |

## Coordination, clocks, and reproducibility

`tests/fixtures/http-gates.ts` wraps the real fixture D1 binding. Gates signal
arrival, release of a batch/read, completion, and release of its result to the
HTTP caller. The registry stores only ephemeral latched signals and counters,
**not payloads, SQL, parameters, credentials, or results**. Each waiting request
owns its bounded timer I/O: promises created by a completed workerd request
cannot safely coordinate later requests. Polling observes explicit release and
completion signals; elapsed time never releases a database operation or proves
commit order. Results remain on the invocation stack. Used gates are removed; no
production gate or payload-bearing audit/history service exists.

The lifecycle producer constructs synthetic observations **after acquisition**
and stamps actual local UTC Unix seconds. It waits for the local clock to move
past the floor/previous observation when a strictly newer timestamp is needed;
it does not manufacture `floor + 1` timestamps. Older service tests use explicit
synthetic clocks to test exact boundaries, not to establish real collection
order. The intentionally below-floor candidate is invalid-test data only. The
server's second-precision floor cannot prove acquire-before-collect; trusted
producers still need synchronized clocks and genuine recollection.

Successful writes wait for commit. After uncertain snapshot delivery, retry the
same body/event/generation; `unchanged` or later `ignored_stale` need not repeat
the original outcome. Obsolete generations require reacquisition and fresh
collection, never relabeling. After uncertain admin delivery, GET and reconcile;
a new intended decision is not a blind retry with a substituted expectation. A
primary read begun after withdrawal commits cannot serve metadata, but
already-read/in-flight responses and consumer-held copies cannot be revoked.
`/health` remains process-only, not storage/crawler readiness.

Run from the repository root after `pnpm install --frozen-lockfile`:

| Command                 | Purpose                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format`           | Repository formatting for the final integrator. For a documentation-only owner, use `pnpm format -- <owned paths>` to avoid rewriting another agent's files |
| `pnpm check`            | Vite+ formatting/lint/TypeScript checks                                                                                                                     |
| `pnpm lint`             | Vite+ lint and type-aware rules                                                                                                                             |
| `pnpm test`             | Node HTTP validation/security plus `tests/app.test.ts` scaffold/process-health and `tests/database.test.ts`/`tests/tooling.test.ts` regressions             |
| `pnpm test:integration` | Both local workerd/D1 tests, including the composed lifecycle and restart; no cloud credentials                                                             |
| `pnpm db:check`         | Generated migration consistency; does not apply remote SQL                                                                                                  |
| `pnpm build`            | Offline Worker bundle; does not evaluate/deploy the stack                                                                                                   |

The fixture copies reviewed migrations and lets **Alchemy alone** apply them.
Temporary state, storage, migration copies, diagnostics, and home/config are
isolated and cleaned up; credential file/log checks include shutdown output. No
Wrangler, schema push, second migration executor, provisioning, or deployment is
part of acceptance.

### Recorded issue #6 local run

| Command                 | Result                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| `pnpm format`           | Passed                                                                            |
| `pnpm check`            | Passed: formatting, lint, and types                                               |
| `pnpm lint`             | Passed without warnings                                                           |
| `pnpm test`             | Passed: 136 Node tests in eight files                                             |
| `pnpm test:integration` | Passed: both isolated workerd/D1 tests, including lifecycle and migration restart |
| `pnpm db:check`         | Passed: existing generated migrations are consistent; no new migration required   |
| `pnpm build`            | Passed: offline Worker bundle at `dist/index.js`                                  |

Review also confirmed the fixture-only gates/failures stay out of the production
HTTP API. Two seam corrections are covered: anonymous lookup now enforces HTTPS
outside the explicit local-test factory, and all five operations consistently
map documented transient D1 failures to 503 and unexpected/permanent failures to
500 without exposing driver diagnostics.

## Remaining approvals and evidence limits

- Real source-by-field contracts and access/storage/public redistribution,
  attribution, retention, correction/deletion rights, including **express
  permission for durable minimal publication control**. If that control cannot
  be retained, an alternative approved durable authority needs a new design.
- Private `gq-crawl` adoption of acquisition before collection, synchronized
  clocks, exact source policy, same-delivery retries, admin reconciliation, and
  fresh recollection after generation changes. No private adapter/material is
  included or authorized.
- Production abuse/rate limits, access budgets, quotas/CORS decisions,
  independently rotatable credentials/protected state, monitoring/recovery,
  operational ownership, and explicit deployment approval.
- Local workerd does not establish production routing, global latency/outages,
  replication, real-source legality, or recall of held copies. No cache,
  Sessions, replica optimization, freshness promise, replay ledger, mixed-source
  patch, canonical Game grouping, listing, or excluded dataset is introduced.
- Server code remains AGPL-3.0-only; source-data/private-component rights and an
  eventual deployed version's corresponding-source obligations remain separate.
