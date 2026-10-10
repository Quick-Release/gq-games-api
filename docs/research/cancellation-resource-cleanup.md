# Request cancellation and resource cleanup

## Scope and findings

Source audit on 2026-10-10, against repository revision
`b18270dd03dd63cb2b41ef9cab4af3326e6f1b15`. This is research, not a cancellation
implementation or new acceptance result. Installed release sources were
preferred for version-specific behavior; official documentation and pinned
upstream source were consulted read-only. No application requests, workerd
experiments, cloud operations, or migrations were run for this note. Proposed
experiments below need only loopback requests and isolated synthetic local
storage.

The important boundaries are:

- **Implemented:** Hono awaits an Effect program with request-provided layers,
  then builds a buffered JSON response. Neither the catalog runner nor health
  connects the incoming request signal to Effect. There is no application
  `waitUntil`, cancellation listener, timeout, detached fiber, or
  resource-release Effect in the production request path. See
  [entry/application][R-app], [HTTP runner][R-run], and [services][R-catalog].
- **Pinned capability, not enabled behavior:** incoming disconnect notification
  requires `enable_request_signal`, which has no default enable date in the
  pinned workerd source. Neither the repository configuration nor Alchemy's
  added defaults enables it. Hono's Workers entry point does not supply an
  Effect cancellation bridge. See [configuration][R-config], [Alchemy
  defaults][A-flags], [workerd flags][W-flags], and [Hono dispatch][H-source].
- **Implemented cleanup is narrower:** HTTP body readers are canceled
  advisory-style and their locks released in JavaScript `finally`; layer
  provisioning has an Effect scope. These are different mechanisms. A scope
  closing does not close the D1 binding, cancel its submitted batch, or undo a
  commit. See [HTTP readers][R-body], [Effect provisioning][E-layer], and [D1
  adapter][E-d1].
- **Unknown outcome remains possible:** an interrupted fiber or missing response
  is not evidence of rollback. D1 batch statement failure has a documented
  transaction rollback guarantee; client disconnect and Effect interruption do
  not have that guarantee in the inspected APIs. Current snapshot replay/admin
  reconciliation rules remain relevant. See [D1 batch contract][C-d1], [mutation
  implementation][R-catalog], and [existing contract][R-contract].

## Pinned version and compatibility context

| Component                       | Repository pin/resolution                                                           | Evidence                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Effect and native D1 SQL client | `effect@4.0.1`, `@effect/sql-d1@4.0.1`                                              | [package manifest][R-package], [lock importer][R-lock]           |
| Hono                            | `4.13.13`                                                                           | [manifest][R-package], [lock][R-lock]                            |
| Drizzle ORM and Kit             | Both `1.0.0-rc.5-ab785fc`                                                           | [manifest][R-package], [lock][R-lock]                            |
| Infrastructure/local runtime    | `alchemy@2.0.0-beta.81`; transitive `@alchemy.run/cloudflare-runtime@2.0.0-beta.81` | [manifest][R-package], [runtime resolution][R-runtime-lock]      |
| Local engine                    | Override and resolved runtime dependency `workerd@1.20261006.1`                     | [lock override][R-lock], [runtime resolution][R-runtime-lock]    |
| Worker type declarations        | `@cloudflare/workers-types@5.20261007.1`                                            | [manifest][R-package]; declarations are not the local executable |
| Worker compatibility            | Date `2026-10-07`, explicitly supplied `nodejs_compat`                              | [Alchemy configuration][R-config]                                |

The installed runtime dependency was resolved from Alchemy's package context to
`workerd@1.20261006.1`, not inferred from the newest directory under `.pnpm`. An
older `workerd@1.20260918.1` directory also exists locally; its presence is not
this lockfile's selected runtime. The local binary is version-pinned; the hosted
Workers service is not pinned by an npm executable. The configured compatibility
date selects API behavior, not a hosted runtime build.
[R-runtime-lock][R-runtime-lock] [Cloudflare compatibility dates][C-dates]

Alchemy treats a Worker declared with props and no inline implementation as an
external/plain entry. It bundles that entry rather than injecting its
Effect-native Worker bridge. Its compatibility processing adds
`new_module_registry` for this bundled JavaScript entry; thus the explicit list
in `alchemy.run.ts` is not the whole effective list. It does **not** add
`enable_request_signal` or `request_signal_passthrough`. These conclusions
follow from installed `alchemy/src/Platform.ts:318-345`,
`alchemy/src/Cloudflare/Workers/Source.ts:388-395`,
`alchemy/src/Cloudflare/Workers/Compatibility.ts:46-74`, and runtime
`src/core/internal/constants.ts:13-53`. Local startup passes the resulting date
and flags in `LocalWorkerProvider.ts:809-810`. The offline build also explicitly
selects `isExternal: true`. [A-platform][A-platform] [A-source][A-source]
[A-compat][A-compat] [A-flags][A-flags] [A-local][A-local] [R-build][R-build]

### Cancellation-related compatibility flags

- `enable_request_signal` / `disable_request_signal`: pinned workerd
  `enableRequestSignal @90` has **no** `compatEnableDate`; its comment
  explicitly says there is no default enable date. The late repository date and
  Node compatibility do not opt into incoming disconnect notification. Without a
  supplied signal, `Request::getThisSignal()` constructs a `NEVER_ABORTS`
  signal; signal-property availability alone is not evidence of cancellation
  support. [W-flags][W-flags] [W-http][W-http] [Cloudflare Request
  docs][C-request]
- `request_signal_passthrough` / `no_request_signal_passthrough`: also no
  default enable date in this pin. Official docs describe forwarding the
  incoming signal to fetch subrequests when enabled. The pinned entry point
  chooses `NONE` when enabled and `IGNORE_FOR_SUBREQUESTS` otherwise. **Source
  discrepancy:** the adjacent Cap'n Proto comment says the opposite; rely on the
  executable branch and official docs, not that comment. Neither flag forwards a
  signal into Effect automatically or adds an abort argument to D1.
  [W-flags][W-flags] [W-entry][W-entry] [W-http][W-http] [Cloudflare
  flags][C-flags]
- `handle_cross_request_promise_resolution` is date-enabled since `2024-10-14`
  in pinned workerd. Its documented source behavior routes continuations to the
  correct request I/O context, or drops them with a warning if that context is
  gone. It does not make request-created pending promises valid forever.
  Existing fixture gates deliberately store flags/counters and let each waiting
  request own its timer I/O. [W-flags][W-flags] [fixture gates][R-gates]

No flag changes are proposed for the production configuration in this note.

## Actual request lifecycle

```text
Cloudflare/workerd invocation: Request + env + ExecutionContext
  -> default export createApp() (Hono)
  -> Hono.fetch / dispatch: Context holds raw Request, env and executionCtx
  -> catalog transport: server request ID + no-store; await next()
  -> HTTPS/auth/path checks
  -> for writes: bounded body reads in ordinary JavaScript promises
  -> runCatalog: construct request-specific Catalog <- Database <- D1 layers
  -> Effect.runPromiseExit(operation provided with those layers), NO signal
     -> layer scope/build -> validation / clock / parameterized SQL
     -> D1 Promise(s) via pinned Effect adapter
     -> result decoding/business outcome -> scope closes -> Exit
  -> HTTP projection/error mapping -> c.json (buffered Response)
  -> runtime delivers response bytes; disconnect may prevent delivery
```

Each arrow has a specific owner:

1. **Worker/Hono entry:** `src/index.ts:6-7` exports the Hono instance. Hono's
   installed `dist/hono-base.js:262-308` constructs a context from the same raw
   request, runs the route/composed middleware, and returns its response; it has
   no signal listener in that dispatch path. `dist/request.js` stores the raw
   request. There is no separate Node/Hono adapter or Effect HTTP server adapter
   here. Official Hono Workers docs use the same module export shape.
   [R-entry][R-entry] [R-app][R-app] [H-source][H-source]
   [H-request-source][H-request-source] [H-workers][H-workers]
2. **Early exits and uploads:** transport middleware sets headers and awaits
   downstream handlers (`src/http/catalog.ts:256-269`). Authentication, HTTPS,
   and App ID checks run before body parsing or D1. Acquisition rejects a body;
   snapshot/admin PUT collect at most 32 KiB plus one overflow-probe byte on the
   BYOB path, release the reader, then decode UTF-8/JSON. Reads are awaited
   ordinary promises **outside** Effect. A rejected `reader.read()` propagates
   through its `finally` to Hono's generic error handler; it is not an Effect
   interruption. There is no upload deadline or abort check. Authentication,
   invalid media/encoding, and acquisition's oversized Content-Length early
   return can occur without acquiring a reader, so the reader-finally path is
   not a universal body-drain policy. [R-body][R-body] [R-routes][R-routes]
   [R-app][R-app]
3. **Effect entry/layers:** `runCatalog` checks the DB binding, constructs
   layers with the current `c.env.DB`, and awaits `runPromiseExit` with **one
   argument** (`src/http/catalog.ts:211-226`). Node test overrides bypass D1.
   `Database` uses `Drizzle.makeWithDefaults` and `D1Client.layer`; `Catalog`
   obtains that database and closes over it for this execution. Neither service
   is a global first-binding singleton. Layer provision creates/closes a scope;
   it does not install a request-abort listener. [R-run][R-run] [R-db][R-db]
   [R-catalog][R-catalog] [E-layer][E-layer]
4. **Operation:** lookup is one joined eligibility/snapshot SELECT; inspection
   is one control SELECT. Acquisition is one ordered native batch (insert if
   absent, capture control); snapshot submission validates then batches
   classification + guarded upsert; admin change validates then batches
   classification + guarded deletion + control advancement. No application
   retries, interactive transaction, source fetch, or background write is
   involved. Validation uses ordinary bounded parsing/Effect failures and, for
   snapshot freshness validation, the Effect clock, not a cancellation policy.
   [R-catalog][R-catalog] [R-validation][R-validation]
   [R-publication-validation][R-publication-validation]
5. **Driver:** Drizzle sets `$client` to `D1Client`; queries use
   `client.unsafe(...).values`/`withoutTransform`/`raw`. Native batches call the
   binding directly, outside generic SqlClient transactions. `all()`/`raw()` and
   `db.batch()` are wrapped with zero-argument `tryPromise` thunks: no
   `AbortSignal` is consumed or passed to D1. [D-driver][D-driver]
   [D-session][D-session] [E-d1][E-d1]
6. **Completion:** success/failure exits leave the layer scope before the runner
   returns. Success is projected into JSON; recognized `CatalogFailure`s map to
   status/code, other causes become a generic 500. There is no dedicated
   interruption classification (nor an implemented 499 response). If a future
   interruption reached this mapping without a typed CatalogFailure, it would
   take the generic path; a disconnected client could not rely on receiving that
   response. `/health` separately runs a synchronous Effect with `runPromise`,
   no DB/layers/signal. `/` uses no Effect. [R-run][R-run] [R-app][R-app]
   [health service][R-health] [E-final][E-final]

**Synchronous success is not guaranteed receipt.** Catalog only reports success
following batch resolution/decoding, but commit can precede decoding, JSON
construction, network delivery, and client acknowledgement. An error after
commit cannot retroactively undo the SQL operation. [R-catalog][R-catalog]
[R-run][R-run] [C-d1][C-d1]

## Events that must not be conflated

| Event                                        | What it means                                                              | Current propagation / cleanup                                                                                                    | What it does not prove                                                                                   | Evidence                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Client aborts its fetch or closes its socket | Caller stops waiting/transport closes; server detection has its own timing | Runtime may cancel request-associated tasks. No app signal-to-fiber bridge                                                       | That the operation never began, or that a D1 write rolled back                                           | [C-limits], [W-entry], [R-run]           |
| Incoming `Request.signal` abort              | Workerd exposes a notification when the opt-in path detects cancellation   | Not enabled here; Hono exposes `c.req.raw`, but does not connect it to Effect                                                    | Interruption of every async operation, or notification for every post-handler response-body cancellation | [W-flags], [W-entry], [H-source]         |
| `reader.cancel()` / reader lock release      | Stop consumption of this input stream / relinquish reader ownership        | HTTP `finally` calls cancel without awaiting, suppresses cancel rejection, releases lock                                         | Incoming signal abort, Effect interruption, completed producer teardown, or SQL rollback                 | [R-body], [R-body-tests]                 |
| Effect fiber interruption                    | Effect receives an interrupt cause and stops at interruptible boundaries   | No request-triggered interruption is wired. Pinned run options accept a signal; explicit fiber interruption is another mechanism | Forced termination of arbitrary JS promises or remote side effects                                       | [E-run], [E-promise], [E-async], [R-run] |
| Scope close / `ensuring` / release finalizer | Effect runs registered cleanup on exit while its runtime can execute       | Layer provision closes its scope. No application D1 rollback/close finalizer exists                                              | Cleanup on isolate/process death, durable delivery, or undoing a commit                                  | [E-layer], [E-final], [E-d1], [R-db]     |
| Runtime cancels I/O / invocation ends        | Host no longer guarantees request-associated work will progress            | Not an Effect protocol; no promise that JS finally/finalizers receive an Exit                                                    | Graceful Effect interruption or completion of async cleanup                                              | [C-limits], [W-context], [W-global]      |
| D1 statement fails inside batch              | Database-side transaction error                                            | Entire batch aborts/rolls back per contract; adapter maps the error                                                              | That disconnect, timeout, or interrupted waiting is a statement failure                                  | [C-d1], [E-d1], [R-rollback]             |
| D1 commits but response is lost              | Durable mutation and caller knowledge diverge                              | Snapshot retries use unchanged body/generation; admin GET reconciles                                                             | Exactly-once delivery or permission to issue a new observation/expectation blindly                       | [R-contract], [R-discard], [R-catalog]   |

## Effect 4 finalizers and resource lifetimes

### What the exact release supplies

`Effect.runPromiseExit` calls `runForkWith` and resolves from a fiber observer.
Its run options can carry `signal`; the runtime listens for abort, calls
`fiber.interruptUnsafe()`, and removes the listener when the fiber exits.
**Subtle ordering:** in this pin `runForkWith` first calls `fiber.evaluate`,
then checks/attaches the signal if the fiber has not already completed. Passing
an already-aborted signal alone is not a preflight guarantee that no synchronous
work/driver dispatch occurs. A proposed boundary must check abort before
starting side effects as well as connect later aborts, and test the race
explicitly. Installed `effect/src/internal/effect.ts:5669-5697,5751-5787` and
public `effect/src/Effect.ts:17798-17817`. [E-run][E-run] [E-api][E-api]

Effect 4 `tryPromise` adapts promise rejection into the typed error channel. Its
abort support only helps an operation that observes the passed signal. The
installed implementation uses thunk arity (`f.length !== 0`) to decide whether
an AbortController is needed. On interruption, the async primitive prevents late
resumption and aborts that controller when one exists; it does not erase or
cancel an arbitrary promise. The D1 adapter's zero-argument thunks do not
request this controller or install an on-cancel operation. This is a release
source conclusion, not an Effect 3 `@effect/platform` assumption.
`effect/src/internal/effect.ts:1094-1126,1136-1203`;
`@effect/sql-d1/src/D1Client.ts:179-190,241-254,279-310`. [E-promise][E-promise]
[E-async][E-async] [E-d1][E-d1]

`Effect.provide(layer)` uses `scopedWith`; scope close runs on exit. In the
normal sequential strategy finalizers run in reverse registration order.
`ensuring` delegates to `onExit`; finalization is uninterruptible by default.
`acquireRelease` masks acquisition/registration by default (with an explicit
interruptible-acquisition option) and registers release only after successful
acquisition. Cleanup can therefore delay the runner's Exit, and an indefinitely
pending finalizer can prevent it from completing. Finalizer failure/defect can
also change a successful result into failure or combine with an existing failure
cause; it is not merely a logging callback. This matters if SQL already
committed before a later cleanup failure. These guarantees apply while Effect
can progress, not after workerd destroys its I/O context or terminates
execution. `effect/src/internal/layer.ts:8-22`;
`effect/src/internal/effect.ts:3937-4000,4099-4150,4168-4204,4238-4253`.
[E-layer][E-layer] [E-final][E-final] [C-limits][C-limits]
[W-context][W-context]

Effect 4's `forkChild` attaches a child to the parent lifetime; `forkIn`/scoped
forks attach to a scope, while `forkDetach` is deliberately different. None is a
Cloudflare lifetime extension. Production Catalog currently forks none; do not
import an Effect-native Alchemy Worker bridge's lifetime model into this plain
Hono Worker. Detached fibers cannot safely be assumed to retain request I/O
after response/disconnect. `effect/src/Effect.ts:17478-17541,17665-17713`.
[E-forks][E-forks] [R-catalog][R-catalog] [A-platform][A-platform]
[C-limits][C-limits]

### What is actually owned here

| Resource                         | Owner and end of useful lifetime                     | Actual release behavior                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Body reader and chunk references | JS upload handler, before Effect starts              | Reader cleanup in `finally` if acquired. Cancellation promise is intentionally not awaited; locks release immediately. Bounded chunks are ordinary memory, not a scoped resource. Early returns before reader acquisition differ. [R-body]                                                                                                             |
| Catalog/Database/Drizzle values  | Per provided execution/layer graph                   | Scope is closed before normal Exit, not at response-body consumption. Do not lend a scoped service to post-response work. [R-run], [R-db], [E-layer]                                                                                                                                                                                                   |
| D1 prepared-statement cache      | D1 client's connection closure for this construction | Default capacity 200, TTL 10 minutes, created anew with the request client. TTL is not a request deadline or shared connection lifetime. No D1 statement-finalize/database-close/cancel hook is registered by `D1Client.make`; scope closure is not explicit cache destruction. Ordinary reachability/GC is distinct from release finalization. [E-d1] |
| D1 binding / persistent database | Worker environment / Alchemy-owned D1 identity       | Service wrapping borrows the binding; it does not acquire an owned SQL socket/pool or close/delete the database. `acquirer = Effect.succeed(connection)`; interactive `transactionAcquirer` dies as unsupported. [R-config], [R-db], [E-d1]                                                                                                            |
| Reactivity service               | D1 layer dependency                                  | Default is an in-memory registration map. Reactive query subscriptions register finalizers only when used; current Catalog uses no reactive query stream/subscription. [E-reactivity], [R-catalog]                                                                                                                                                     |
| JSON response                    | Hono/runtime after Effect completion                 | Buffered representation, not an Effect stream holding the service scope. Returning Response is not proof of delivery. [R-run], [H-source], [W-global]                                                                                                                                                                                                  |

There is **no installed rollback finalizer for these batches**. Generic
SqlClient transaction machinery is not used: the adapter's batch explicitly
bypasses it, and its transaction acquisition is unsupported. A speculative
`ensuring(rollback)` would neither obtain a supported interactive transaction
nor identify/undo a batch that may already have committed. [E-d1][E-d1]

### Cloudflare lifetime is a separate constraint

Cloudflare documents that request-associated tasks **may** be canceled on
response completion or disconnect. An HTTP invocation has no hard duration limit
while the client remains connected (including streamed responses), but that does
not remove CPU/memory limits. `ctx.waitUntil(promise)` can extend work for **up
to 30 seconds** after response/disconnect; it is not a durable job, transaction
guarantee, or replacement for awaiting a response-dependent write. Current
production handlers call it nowhere. [C-limits][C-limits] [C-context][C-context]
[R-run][R-run] [R-app][R-app]

Pinned workerd provides useful detail without guaranteeing all edge behavior:
`WorkerEntrypoint::requestImpl` creates the controller only under the flag,
triggers abort in its cancellation cleanup under specific guards (no completed
proxy task, no already-logged exception), then drains the request. The
controller reference is released there; **do not treat incoming signal as an
unconditional notification of every later response-stream cancellation**. The
global request handler separately tracks a canceled response reference because a
JavaScript promise is not automatically canceled, and neuters the native request
body. `IoContext::IncomingRequest::drain` waits for waitUntil task emptiness,
timeout, or context abort; its non-actor timeout is typically 30 seconds.
Runtime cancellation is not an implicit call to Effect's interrupt API.
[W-entry][W-entry] [W-global][W-global] [W-context][W-context]

Consequently, a bounded cleanup proposal must arrange both **Effect ownership**
and **host time to execute**, without claiming finalizers survive process death,
isolate termination, CPU/memory exhaustion, or the waitUntil deadline. Source
inspection does not establish how often any of those failures occurs locally or
in production. [E-final][E-final] [C-limits][C-limits] [W-context][W-context]

## D1 writes already in flight: commit and rollback limits

The public binding API accepts statements for `batch()` and no cancellation
signal; prepared statement execution similarly has no abort argument. The pinned
workerd binding wrapper sends a new internal request containing SQL and
parameters (or the flagged RPC alternative); it does not forward the HTTP
request's signal. Even opt-in incoming fetch signal passthrough does not supply
an Effect signal to this separately constructed D1 operation. [C-d1][C-d1]
[C-prepared][C-prepared] [W-d1][W-d1] [E-d1][E-d1]

| Point in the operation                         | Defensible conclusion                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the binding call                        | A future interruption/abort check can prevent a not-yet-started call if observed in time. Current HTTP runner has no such policy. The early evaluation ordering above must be considered. [R-run], [E-run]                                                                                                            |
| Binding promise outstanding                    | Fiber interruption can abandon waiting/continuations, but no inspected API gives the application a cancel-and-rollback acknowledgement. The host may cancel I/O; whether D1 had accepted/executed the write is not established by that fact. Treat commit outcome as uncertain. [E-async], [E-d1], [W-d1], [C-limits] |
| Statement error inside the transaction         | D1's documented batch guarantee rolls back the sequence. Later-statement-failure fixtures exercise this locally. This is database failure, not transport/fiber cancellation. [C-d1], [R-rollback]                                                                                                                     |
| Batch resolved successfully, response not sent | Mutation has succeeded under the D1 contract; result decoding/finalization/response construction may still fail. The caller may see no success. [R-catalog], [R-run], [C-d1]                                                                                                                                          |
| Response headers arrived, body discarded       | Current buffered catalog handlers have already completed their synchronous program. Canceling response consumption cannot roll back that earlier mutation. This is what existing lost-response tests simulate. [R-discard], [R-run]                                                                                   |

Atomicity does not imply exactly-once delivery. Current snapshot equality
ignores delivery event identity and permits an identical replay to be
`unchanged`, or `ignored_stale` after a newer observation. Keep the same
original body/event and generation on an uncertain retry; do not manufacture a
timestamp to get a new write. Admin changes use expected generations; after an
uncertain response, GET and reconcile rather than blindly replace the
expectation. Acquisition preserves existing control. These rules manage
uncertain knowledge, not cancellation of the original D1 operation.
[R-catalog][R-catalog] [R-contract][R-contract] [R-discard][R-discard]

**Unsupported claims:** “disconnect always commits,” “disconnect always rolls
back,” “Effect interruption cancels D1,” “uninterruptible makes D1 durable,” and
“a successful finalizer proves rollback” are not supported. The official batch
contract says what happens on statement failure, not on cancellation at each
transport stage. Local Alchemy D1 uses Durable Object SQLite and a synchronous
`transactionSync(() => queries.map(...))`; there is no await/interruption point
between local SQL statements. A gate before `binding.batch()` or after its
promise settles cannot demonstrate cancellation in the middle of database
execution. Local observations cannot specify the hosted D1 implementation.
[C-d1][C-d1] [A-d1][A-d1] [R-gates][R-gates]

## Existing evidence, risks, and gaps

These are inspected tests, **not newly executed test results**:

- Node body tests verify bounded input consumption, one cancellation call,
  unlocked body streams, and preserving 413 despite rejecting or never-settling
  cancellation promises. They do not exercise real TCP disconnect notification
  or Cloudflare native body-stream teardown. [R-body-tests][R-body-tests]
- Node database tests establish layer laziness, parameterization, and typed
  Drizzle error wrapping. Cross-route database-error tests use a deliberately
  throwing binding; they do not establish outage/cancellation semantics or
  transaction outcomes. [R-db-tests][R-db-tests] [R-error-tests][R-error-tests]
- Local integration fixtures exercise native batches, later SQL failure,
  persistence over restarts, bounded streamed uploads, and held earlier reads.
  The lost-response helper **awaits headers and then cancels the body**; it does
  not abort a pending handler or interrupt a fiber. Existing read/batch gates
  order dispatch and hold results, not D1's internal execution. The gate named
  `committed` also fires for rejection/rollback: it means operation completion,
  not unconditional successful commit. [R-discard][R-discard]
  [R-rollback][R-rollback] [R-gates][R-gates] [R-integration][R-integration]
- Test-client `AbortSignal.timeout` bounds harness waits only. It is not an
  application timeout or proof of incoming-signal/fiber propagation. Normal
  restart persistence is not proof that interrupted finalizers ran.
  [R-discard][R-discard] [R-integration][R-integration]

Priority gaps and proposed decisions (none implemented):

1. **Transport-to-fiber seam:** decide whether to enable incoming signal and
   pass it to the actual Effect runner. Enabling the flag alone does nothing to
   the existing one-argument runner. Need pre-aborted handling, listener
   cleanup, interruption-aware safe diagnostics, and tests that distinguish a
   lost client from a database failure. [R-run][R-run] [E-run][E-run]
   [W-flags][W-flags]
2. **Upload lifetime:** byte bounds do not bound time waiting for the next
   chunk. Decide a connected slow-upload deadline and an early-rejection body
   policy. Do not wire only the catalog Effect and assume earlier JavaScript
   reads are covered. [R-body][R-body] [C-limits][C-limits]
3. **Mutation policy:** decide whether an accepted mutation should deliberately
   finish after client disconnect or be interrupted opportunistically before
   dispatch. Either choice retains uncertain commit outcomes after dispatch; no
   new rollback or exactly-once claim follows. Continue awaiting mutation
   success before returning a success response. Do not move writes into
   waitUntil merely to claim durability. [R-catalog][R-catalog] [E-d1][E-d1]
   [C-context][C-context]
4. **Cleanup budget:** choose a short, bounded best-effort cleanup path if real
   acquired resources are added later. Avoid unbounded uninterruptible
   finalizers, scope-escaping response streams, and background use of request
   services. Whether to register the already-started runner/cleanup promise with
   `executionCtx.waitUntil` requires an explicit design; it must not rerun the
   operation and is still time-limited. [E-final][E-final] [E-layer][E-layer]
   [C-context][C-context]
5. **Measurement gap:** no existing test demonstrates physical disconnect ->
   incoming abort -> fiber interruption -> observed finalizer in this stack. Nor
   does it prove an in-flight D1 cancellation point or hosted edge timing. Test
   the seams separately before promising cleanup. [R-gates][R-gates]
   [R-discard][R-discard] [A-d1][A-d1]

## Proposed controlled synthetic local workerd experiments

**Proposal only; not run here.** Reuse the existing isolated Alchemy/workerd
fixture pattern: temporary cwd/HOME/config/storage, empty Cloudflare
credentials, local-only dev guard, loopback port, synthetic tokens/rows, bounded
harness waits, process-tree teardown and temp-directory removal. Keep migrations
generated and reviewed through Drizzle and **applied/history-owned by Alchemy**.
No Wrangler, schema push, second executor, bootstrap, deployment, or remote
endpoint is needed. New fault/gate/inspection endpoints must exist only in a
fixture bundle, not production. [R-fixture-stack][R-fixture-stack]
[R-integration][R-integration] [R-fixture-worker][R-fixture-worker]

Before attributing abort behavior to Hono/Effect, verify the local transport.
Pinned Alchemy's WorkerProxy is a raw TCP byte relay, not a buffering HTTP fetch
proxy: its client-close race closes both sockets through Effect finalizers.
Still record the actual upstream disconnect/abort event, rather than treating a
client-side rejected fetch as server evidence. Use a dedicated loopback HTTP/1.1
connection/raw socket reset when precise disconnect timing matters; a pooled
fetch may only cancel response consumption. See installed runtime
`src/core/proxy/WorkerProxy.ts:16-43,251-303`. [A-proxy][A-proxy]

Record only synthetic phase counters/sequence numbers: handler entered, body
reader acquired/released, request abort observed, fiber Exit kind, finalizer
started/finished, binding call dispatched/settled, and narrowly inspected probe
row. Never retain request objects, pending request-created promises, SQL,
parameters, tokens, input bodies, driver causes, or results in a shared map.
Each invocation owns its waits/I/O; independent observer/control requests read
latched flags. Gates establish order; watchdog timeouts fail tests, never
release gates or imply commit. These follow the existing coordination
discipline. [R-gates][R-gates]

| Experiment and controls                                                                                                                                                                                                                                                                                                                                                                                       | Expected observation / hypothesis                                                                                                                                                                                                                                                                                                                                                 | What it cannot prove                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Flag and Hono propagation.** Four isolated fixture variants: existing flags vs added `enable_request_signal`, each with runner disconnected vs `{ signal: c.req.raw.signal }`. Hold an interruptible synthetic Effect before D1; confirm entry, then close the client socket. Also include a connected/no-abort control.                                                                                 | Without opt-in, no incoming abort notification expected. With opt-in, expect notification while handler pending. Unbridged Effect has no automatic interrupt cause; bridged Effect should interrupt and run a short synchronous marker finalizer if the host permits progression. Record missing Exit separately from interrupted Exit. [W-entry], [H-source], [E-run], [E-final] | Absence of a marker could be host teardown, not failed Effect semantics. Does not prove production edge timing or D1 cancellation.                                                                               |
| **2. Pure Effect interruption control.** While the HTTP client stays connected, use a fixture-owned AbortController/explicit fiber interrupt on a gated program. Compare no finalizer, `ensuring`, scoped `acquireRelease`, and an interruptible child. Include success, typed failure, defect, and acquisition failure.                                                                                      | Expect release on success/failure/defect/interruption after successful acquisition, reverse sequential order, and child termination with its parent. No release for failed acquisition. Runner completion follows finalizer completion. [E-final], [E-forks], [E-run]                                                                                                             | Establishes Effect in workerd, not disconnect propagation or survival of host termination.                                                                                                                       |
| **3. Pre-aborted signal and dispatch boundary.** Call the pinned runner with an already-aborted fixture signal and a synthetic synchronous counter before its first suspension. Compare explicit preflight guard with run-option-only control. Then gate an interruptible step before the real batch and interrupt before releasing it.                                                                       | Option-only can execute synchronous work before interruption, matching source ordering. An observed pre-dispatch interrupt/guard should keep binding count zero when no call was started. [E-run], [R-catalog]                                                                                                                                                                    | Cannot eliminate all races after the guard or prove a submitted call is cancelable. Do not label a gate inside a zero-argument Promise thunk as an Effect-owned pre-dispatch checkpoint.                         |
| **4. Promise cooperation.** Compare a zero-argument `tryPromise` with a signal-consuming thunk that performs a fetch to a synthetic loopback/service fixture. Hold its completion, explicitly interrupt the fiber while client connected, then permit completion.                                                                                                                                             | Effect Exit/finalizer can precede the zero-argument producer's completion; late producer settlement must not resume business logic. Cooperative thunk should observe its signal abort. Use runtime-held loopback I/O only in the owning invocation. [E-promise], [E-async]                                                                                                        | Canceling cooperative fetch is not rollback of the remote fixture action; does not give D1 an abort API.                                                                                                         |
| **5. Input-stream disconnect and early reject.** Stream below-limit bytes without EOF; await reader-acquired marker, then reset the socket. Separately send media/auth/Content-Length rejects and a slow connected upload; compare proposed deadline handling in fixture only.                                                                                                                                | If native read rejects and JS continues, expect reader-finally/lock-release marker, not an Effect interruption (catalog never started). Early rejects may have no reader marker. Without a deadline, byte limits alone do not end the connected wait. Measure actual cancellation/body behavior rather than importing Node producer assertions. [R-body], [W-global], [C-limits]  | Does not prove hostile producer teardown always finishes or that all platform body streams behave like Node tests.                                                                                               |
| **6. D1 commit with withheld result.** Gate before dispatch; release and let a real synthetic batch succeed, narrowly inspect committed row from a separate request, but keep its result withheld. Explicitly interrupt Effect with the client still connected, then release the result; separately reset the client socket at this same phase. Pair with later-statement-error and before-dispatch controls. | The known committed row remains despite Effect interruption; business continuation after the interrupted wait should not run. A statement-error batch leaves no partial write. Socket-reset variant may produce no observable fiber Exit; report it, do not infer rollback. [E-d1], [E-async], [C-d1], [R-gates]                                                                  | Withholding after settlement is **not** cancellation during SQL. Pre-dispatch gates are not internal database gates. Local synchronous SQLite cannot demonstrate hosted D1's in-flight commit/rollback behavior. |
| **7. Finalizer budget / waitUntil.** In a separate synthetic fixture, compare short sync and bounded async finalizers with/without registering the same runner promise using `ctx.waitUntil`. Abort during the pending handler; also return a response before a short background marker. Use conservative timers; characterize effective local drain limits separately.                                       | waitUntil should give asynchronous work an execution opportunity beyond response/disconnect; awaited finalization delays Effect Exit. Unregistered work may disappear. Record a local timeout observation, not a universal 30-second measured guarantee. [C-context], [C-limits], [W-context], [E-final]                                                                          | waitUntil does not make the work durable, survive process kill, cancel D1, or permit cleanup beyond the host budget. Registering a second runner would execute the mutation twice and is invalid.                |
| **8. Completion versus teardown.** Compare socket cancellation while handler pending, canceling a streamed fixture response after headers, and stopping the isolated process with a pending synthetic task; restart and inspect only committed probe state.                                                                                                                                                   | Handler abort and stream/proxy cancellation need not have the same notification path. Process death can lose volatile/finalizer markers while earlier committed rows persist. Preserve unknown outcomes explicitly. [W-entry], [W-global], [A-d1]                                                                                                                                 | Process termination is not graceful fiber interruption; restart persistence does not prove finalizer execution, durability of unfinished work, or hosted D1 recovery.                                            |

Do not use long SQL to manufacture a supposed deterministic “mid-write abort.”
The local D1 simulator executes the statement sequence synchronously; a
post-dispatch signal marker cannot establish when SQL accepted, committed, or
rolled back internally. Experiment 6 is a controlled proof of **commit versus
response knowledge**, not a platform cancellation guarantee. [A-d1][A-d1]

## Primary source index and audit anchors

Repository links below refer to the inspected revision; line numbers may move
with later edits. Installed packages are ignored/uncommitted artifacts, so the
upstream links preserve the release identity where possible. `A-*` runtime
sources were read from the Alchemy-resolved installation at
`node_modules/.pnpm/@alchemy.run+cloudflare-runtime@2.0.0-beta.81_@distilled.cloud+cloudflare@1.0.0-rc.13_e_698da669cf1e62d2b59ad020a0f517b5/node_modules/@alchemy.run/cloudflare-runtime/`.
This is Alchemy's local simulator, **not** a separately configured Miniflare or
Wrangler test executor.

- **Repository:** manifest/lock/config/build; `src/index.ts`, `src/app.ts`,
  `src/http/catalog.ts`, `src/db/database.ts`, Catalog/validation/health
  services; Node body/database/error tests; local stack/worker/gates,
  integration D1 and catalog lifecycle/rollback tests; existing
  architecture/backlog/database and catalog contract notes.
- **Effect 4.0.1:** installed `src/internal/effect.ts`, `src/internal/layer.ts`,
  public `src/Effect.ts`, `src/reactivity/Reactivity.ts`, and
  `src/sql/SqlClient.ts`; native D1 `src/D1Client.ts` in `@effect/sql-d1@4.0.1`.
  API/source citations below use the `effect@4.0.1` upstream tag, not Effect 3
  website examples.
- **Hono 4.13.13:** installed `dist/hono-base.js:262-324` and `dist/request.js`,
  plus official Workers docs. Drizzle pinned artifacts:
  `effect-d1/driver.js:41-60`, `effect-d1/session.js:14-38`. The [upstream
  session source at `ab785fc`][D-upstream] corroborates dispatch; its type-only
  Effect import paths differ from the installed compiled artifact, so installed
  release code remains authoritative for this stack.
- **Cloudflare:** official Request, compatibility flags/dates, Context, limits,
  D1 database/prepared-statement docs; workerd `v1.20261006.1`
  `compatibility-date.capnp`, `worker-entrypoint.c++`, `global-scope.c++`,
  `http.c++`, `io-context.c++`, and `cloudflare/internal/d1-api.ts`.
- **Alchemy beta.81:** installed plain-entry selection/compatibility forwarding,
  runtime defaults, raw TCP proxy, and local D1 `D1.worker.ts:142-240`. These
  explain local test transport/storage, not production platform guarantees.

Limitations: source audit and read-only documentation retrieval only; no new
cancellation measurements, no guarantee that current official docs describe
every detail of the pinned local binary, and no hosted D1/Workers verification.
The pinned passthrough comment discrepancy is called out above. The parent
independently audited the local HTTP runner, D1 adapter, layer provisioning, and
Effect interruption/finalization sources. Repository quality checks are separate
from cancellation evidence; neither Node tests nor an offline build validate
Cloudflare disconnect behavior. The proposed experiments and local integration
suite were not run for this research.

[R-package]: ../../package.json#L10-L43
[R-lock]: ../../pnpm-lock.yaml#L7-L44
[R-runtime-lock]: ../../pnpm-lock.yaml#L2552-L2568
[R-config]: ../../alchemy.run.ts#L17-L50
[R-build]: ../../scripts/build-worker.ts#L16-L34
[R-entry]: ../../src/index.ts#L6-L7
[R-app]: ../../src/app.ts#L15-L43
[R-run]: ../../src/http/catalog.ts#L211-L250
[R-body]: ../../src/http/catalog.ts#L106-L209
[R-routes]: ../../src/http/catalog.ts#L253-L409
[R-db]: ../../src/db/database.ts#L6-L25
[R-catalog]: ../../src/services/catalog.ts#L49-L508
[R-validation]: ../../src/services/snapshot.ts#L383-L410
[R-publication-validation]: ../../src/services/publication.ts#L10-L87
[R-health]: ../../src/services/health.ts#L6-L12
[R-contract]: ../steam-catalog-contract.md
[R-gates]: ../../tests/fixtures/http-gates.ts#L17-L175
[R-body-tests]: ../../tests/snapshot-http.test.ts#L467-L599
[R-db-tests]: ../../tests/database.test.ts#L11-L69
[R-error-tests]: ../../tests/catalog-database-errors.test.ts#L11-L133
[R-discard]: ../../tests/integration/catalog-lifecycle.ts#L263-L287
[R-rollback]: ../../tests/integration/catalog-lifecycle.ts#L656-L695
[R-integration]: ../../tests/integration/d1.test.ts#L32-L170
[R-fixture-stack]: ../../tests/fixtures/d1-stack.ts#L15-L37
[R-fixture-worker]: ../../tests/fixtures/catalog-worker.ts#L14-L17
[E-run]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/internal/effect.ts#L5669-L5787
[E-api]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/Effect.ts#L17798-L17817
[E-promise]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/Effect.ts#L1335-L1363
[E-async]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/internal/effect.ts#L1094-L1203
[E-layer]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/internal/layer.ts#L8-L22
[E-final]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/internal/effect.ts#L3937-L4253
[E-forks]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/Effect.ts#L17478-L17713
[E-d1]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/sql/d1/src/D1Client.ts#L141-L437
[E-reactivity]:
  https://github.com/Effect-TS/effect/blob/effect%404.0.1/packages/effect/src/reactivity/Reactivity.ts#L96-L201
[H-source]: https://github.com/honojs/hono/blob/v4.13.13/src/hono-base.ts
[H-request-source]: https://github.com/honojs/hono/blob/v4.13.13/src/request.ts
[H-workers]: https://hono.dev/docs/getting-started/cloudflare-workers
[D-driver]: ../../node_modules/drizzle-orm/effect-d1/driver.js#L41-L60
[D-session]: ../../node_modules/drizzle-orm/effect-d1/session.js#L14-L38
[D-upstream]:
  https://github.com/drizzle-team/drizzle-orm/blob/ab785fc/drizzle-orm/src/effect-d1/session.ts
[A-platform]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/alchemy/src/Platform.ts#L318-L345
[A-source]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/alchemy/src/Cloudflare/Workers/Source.ts#L388-L395
[A-compat]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/alchemy/src/Cloudflare/Workers/Compatibility.ts#L46-L74
[A-local]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/alchemy/src/Cloudflare/Workers/LocalWorkerProvider.ts#L809-L810
[A-flags]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/cloudflare-runtime/src/core/internal/constants.ts#L13-L53
[A-proxy]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/cloudflare-runtime/src/core/proxy/WorkerProxy.ts#L16-L303
[A-d1]:
  https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.81/packages/cloudflare-runtime/src/core/bindings/d1/D1.worker.ts#L142-L240
[W-flags]:
  https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/workerd/io/compatibility-date.capnp
[W-entry]:
  https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/workerd/io/worker-entrypoint.c++
[W-global]:
  https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/workerd/api/global-scope.c++
[W-http]:
  https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/workerd/api/http.c++
[W-context]:
  https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/workerd/io/io-context.c++
[W-d1]:
  https://github.com/cloudflare/workerd/blob/v1.20261006.1/src/cloudflare/internal/d1-api.ts
[C-request]:
  https://developers.cloudflare.com/workers/runtime-apis/request/#properties
[C-flags]:
  https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests
[C-dates]:
  https://developers.cloudflare.com/workers/configuration/compatibility-dates/
[C-context]:
  https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil
[C-limits]: https://developers.cloudflare.com/workers/platform/limits/#duration
[C-d1]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
[C-prepared]:
  https://developers.cloudflare.com/d1/worker-api/prepared-statements/
