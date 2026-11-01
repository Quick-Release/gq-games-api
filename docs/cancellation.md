# Catalog request cancellation and cleanup

This implements the phase-aware policy specified in
[issue #7](https://github.com/Quick-Release/gq-games-api/issues/7). The
[research note](research/cancellation-resource-cleanup.md) remains a historical
source audit, not an acceptance result for this implementation.

## Scope and request ownership

The five catalog routes share one request-local lifecycle. Root and process-only
health responses remain unchanged. The Worker enables `enable_request_signal`;
it does not enable outgoing signal passthrough. Hono owns HTTP mapping, Effect
owns application execution/scopes, and the lifecycle borrows rather than closes
the native D1 binding.

Body reads occur before Effect execution. An acquired reader has an absolute
**10-second reading deadline**, not an inactivity timeout; sending another chunk
does not reset it. Existing 32 KiB limits, bounded BYOB reads, media/UTF-8/JSON
checks, authentication, and publication contracts remain in force. Early
rejection need not acquire or drain a reader.

A request abort before write dispatch stops pending body reads and cooperatively
interrupts Effect. There is an explicit preflight check because the pinned
Effect runner can evaluate synchronous work before inspecting an already-aborted
signal. No mechanism preempts synchronous JavaScript.

## Write cutoff and uncertain outcomes

The production binding adapter checks cancellation synchronously immediately
before invoking native `batch`/`exec`, without an asynchronous gap. Fixture
arrival is not dispatch. After this cutoff, client cancellation is diagnostic:
it does not deliberately interrupt the mutation's remaining Effect execution,
decoding, or scope closure.

The handler awaits the mutation execution and registers **the same execution
promise** with `waitUntil`; there is no second execution or asynchronous
acceptance response. Registration occurs when the mutation runner starts, so the
lifetime opportunity already exists when dispatch occurs. Success still follows
successful operation resolution and decoding, never mere dispatch.

`waitUntil` offers up to the platform's bounded post-response/disconnect
allowance, not durable completion. There is no new D1 deadline, cancellation
argument, interactive transaction, rollback finalizer, retry ledger, or
exactly-once guarantee.

| Observation                         | Meaning                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aborted before dispatch             | The actual write binding call can be prevented if abort was observed in time.                                                                       |
| Dispatched, no observed outcome     | Mutation outcome is uncertain. Disconnect, interruption, timeout, or absence of a terminal log proves no rollback.                                  |
| Binding fulfilled                   | The binding settled successfully; decoding, finalization, and response delivery remain distinct. Diagnostics are not an independent database audit. |
| Known committed state               | A lost response or later processing/cleanup failure does not undo commit.                                                                           |
| Statement failure in a native batch | The documented D1 batch rollback guarantee applies; this is not a disconnect guarantee.                                                             |

After uncertain snapshot delivery, retry the original body/event/Publication
Generation. `unchanged` and `ignored_stale` remain possible; do not invent
timestamps or rebase obsolete authorization. After an uncertain publication
change, inspect and reconcile rather than blindly substitute a new expected
generation. Publication Withdrawal and Publication Reinstatement semantics are
unchanged.

A generic 500 after dispatch does not imply that repeating a mutation is safe.

## Reads, responses, and cleanup

Observed abort interrupts a pending read's Effect continuation; it does not
cancel an already-submitted D1 SELECT. Completed reads and delivered bytes
cannot be revoked.

A connected reading deadline returns **408 `BODY_READ_TIMEOUT`**. An observed
pre-dispatch/read abort with a receiver has fallback **408 `REQUEST_ABORTED`**.
No response is promised to a disconnected client. Catalog correlation headers
and sanitized envelopes are preserved; expected abort is not a generic
unhandled-error diagnostic.

Before dispatch, the first observed terminal condition wins. An abort caused by
advisory producer cancellation cannot replace an already-selected validation
response. After dispatch, abort does not replace the observed mutation outcome.

On cooperative exits, acquired reader locks and owned listeners/timers are
released. Reader cancellation is initiated without awaiting a rejecting or
indefinitely pending producer promise. Lock release is not proof that native
producer teardown completed. Effect finalization only applies while the host can
execute; no cleanup guarantee survives isolate/process termination or exhausted
host limits. No new asynchronous production resource or generic
finalizer-timeout framework is introduced.

Lifecycle diagnostics contain only a server request ID and bounded
phase/event/outcome values, not cancellation reasons, credentials, payloads, SQL
parameters, or driver causes. They distinguish observed abort, dispatch,
successful/failed binding settlement, Effect exit, reader ownership, and
lifecycle disposal. `cleanup_complete` describes disposal of lifecycle-owned
handles; reader and Effect release observations remain separate. Terminal
diagnostics are best effort, not a commit ledger.

## Testing and evidence limits

- Node HTTP tests use the existing Catalog-layer override and the real lifecycle
  implementation. They cover preflight, interrupted read continuation, upload
  deadlines/abort, error ordering, and nonblocking reader cancellation.
- Shared-lifecycle tests use synthetic Effect resources and operations to
  exercise acquisition/release, completed finalization, listener removal,
  dispatch guards, and same-promise lifetime registration.
- Local workerd tests use a separately bundled fixture, actual loopback sockets,
  real native D1 batches, interruptible Effect checkpoints before dispatch,
  withheld results after dispatch, and narrow independent persisted-state
  inspection. Shared coordination retains synthetic latched flags/counters only;
  each invocation owns its I/O. No fault endpoint is in production.
- Existing local catalog acceptance continues to cover statement-failure
  rollback, captured classifications, lost-response snapshot retries,
  publication reconciliation, and persisted restart state.

Physical-reset acceptance connects to the owned native workerd HTTP listener,
not Alchemy's development relay: relay closure did not provide server abort
evidence in this pin. Listener discovery requires POSIX `ps` and `lsof` and is
restricted to descendants of the isolated fixture process. This test does not
prove disconnect propagation through the development relay or hosted proxies.

A rejected client fetch is not server abort evidence. A fixture settlement
marker is not commit evidence, and a withheld result is not a pause inside SQL.
Local Alchemy D1 executes its statement sequence synchronously; these tests do
not establish hosted D1's internal cancellation points or production edge
timing. Host teardown and missing finalization must be distinguished from an
observed interrupted Exit.

Future routes and real asynchronous resources must explicitly adopt this
lifecycle interface and define their own ownership/release behavior. Deployment,
production experiments, and private crawler integration are out of scope.
