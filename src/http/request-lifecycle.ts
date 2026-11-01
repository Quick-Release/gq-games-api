// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Cause, Effect, Exit } from 'effect';

export class RequestStopped extends Error {
  constructor(readonly code: 'REQUEST_ABORTED' | 'BODY_READ_TIMEOUT') {
    super(code);
  }
}

export type RequestLifecycleEvent = {
  requestId: string;
  event:
    | 'request_aborted'
    | 'write_dispatched'
    | 'write_succeeded'
    | 'write_failed'
    | 'effect_exit'
    | 'body_reader_acquired'
    | 'body_reader_released'
    | 'cleanup_complete';
  phase: 'before_dispatch' | 'dispatched' | 'outcome_observed';
  outcome?: 'success' | 'failure' | 'interrupted' | 'defect';
};

export const createRequestLifecycle = (options: {
  signal: AbortSignal;
  requestId: string;
  observe?: (event: RequestLifecycleEvent) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}) => {
  let disposed = false;
  let phase: RequestLifecycleEvent['phase'] = 'before_dispatch';
  const interrupt = new AbortController();
  let stopped: RequestStopped | undefined;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const bodyWaiters = new Set<(error: RequestStopped) => void>();
  const stop = (code: RequestStopped['code']) => {
    stopped ??= new RequestStopped(code);
    for (const reject of bodyWaiters) reject(stopped);
  };
  const finishBody = () => {
    if (bodyTimer !== undefined) clearTimeout(bodyTimer);
    bodyTimer = undefined;
  };
  const observe = (
    event: RequestLifecycleEvent['event'],
    outcome?: RequestLifecycleEvent['outcome'],
  ) => {
    const entry: RequestLifecycleEvent = {
      requestId: options.requestId,
      event,
      phase,
      ...(outcome ? { outcome } : {}),
    };
    // Diagnostics never own request execution or expose cancellation reasons.
    try {
      if (options.observe) options.observe(entry);
      else console.info('Catalog request lifecycle', entry);
    } catch {
      /* Diagnostic sinks are best effort. */
    }
  };
  const aborted = () => {
    observe('request_aborted');
    if (phase === 'before_dispatch') {
      stop('REQUEST_ABORTED');
      interrupt.abort();
    }
  };
  if (options.signal.aborted) aborted();
  else options.signal.addEventListener('abort', aborted, { once: true });
  const check = () => {
    if (phase !== 'before_dispatch') return;
    if (stopped) throw stopped;
    if (options.signal.aborted) throw new RequestStopped('REQUEST_ABORTED');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    finishBody();
    options.signal.removeEventListener('abort', aborted);
    observe('cleanup_complete');
  };
  const dispatch = <T>(operation: () => Promise<T>) => {
    check();
    phase = 'dispatched';
    let pending: Promise<T>;
    try {
      // No observer, user callback, or async gap between guard and invocation.
      pending = operation();
    } catch (error) {
      observe('write_dispatched');
      phase = 'outcome_observed';
      observe('write_failed');
      throw error;
    }
    observe('write_dispatched');
    return pending.then(
      (value) => {
        phase = 'outcome_observed';
        observe('write_succeeded');
        return value;
      },
      (error: unknown) => {
        // Observed rejection is not a database rollback acknowledgement.
        phase = 'outcome_observed';
        observe('write_failed');
        throw error;
      },
    );
  };
  return {
    check,
    run: <A, E>(
      effect: Effect.Effect<A, E>,
      policy: 'read' | 'mutation',
      beforeMutation?: Effect.Effect<void>,
      keepAlive = false,
    ) => {
      // Do not evaluate user work before the pinned runner checks its signal.
      // An aborted run still returns an Exit and disposes its owned handles.
      const preAborted = phase === 'before_dispatch' && options.signal.aborted;
      if (!preAborted) check();
      const work =
        policy === 'mutation' && beforeMutation
          ? Effect.andThen(beforeMutation, effect)
          : effect;
      // Attach the runner's abort listener (and host allowance) before user
      // checkpoints can synchronously abort. The actual write guard stays sync.
      const program = preAborted
        ? Effect.interrupt
        : Effect.andThen(Effect.yieldNow, work);
      const promise = Effect.runPromiseExit(program, {
        signal: interrupt.signal,
      })
        .then((exit) => {
          const outcome = Exit.isSuccess(exit)
            ? 'success'
            : Cause.hasDies(exit.cause)
              ? 'defect'
              : Cause.hasInterruptsOnly(exit.cause)
                ? 'interrupted'
                : 'failure';
          observe('effect_exit', outcome);
          return exit;
        })
        .finally(() => {
          if (!keepAlive) dispose();
        });
      if (policy === 'mutation') options.waitUntil?.(promise);
      return promise;
    },
    dispatch,
    readBody: <T>(read: () => Promise<T>) => {
      check();
      bodyTimer ??= setTimeout(() => stop('BODY_READ_TIMEOUT'), 10_000);
      let rejectWait: (error: RequestStopped) => void;
      const promise = new Promise<T>((resolve, reject) => {
        rejectWait = reject;
        bodyWaiters.add(rejectWait);
        try {
          read().then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
      return promise.finally(() => bodyWaiters.delete(rejectWait));
    },
    readerAcquired: () => observe('body_reader_acquired'),
    readerReleased: () => {
      finishBody();
      observe('body_reader_released');
    },
    database: (binding: D1Database) =>
      ({
        prepare: binding.prepare.bind(binding),
        batch: <T = unknown>(statements: D1PreparedStatement[]) =>
          dispatch(() => binding.batch<T>(statements)),
        exec: (query: string) => dispatch(() => binding.exec(query)),
        dump: binding.dump.bind(binding),
        withSession: binding.withSession.bind(binding),
      }) satisfies D1Database,
    dispose,
  };
};
