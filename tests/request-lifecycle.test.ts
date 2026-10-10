// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'vite-plus/test';
import { createRequestLifecycle } from '../src/http/request-lifecycle';

it('observes a dispatched mutation after abort and extends exactly the same execution promise', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const write = Promise.withResolvers<number>();
  const protectedWork: Promise<unknown>[] = [];
  const events: string[] = [];
  const lifecycle = createRequestLifecycle({
    signal: controller.signal,
    requestId: 'synthetic-id',
    observe: (event) => events.push(`${event.event}:${event.phase}`),
    waitUntil: (promise) => protectedWork.push(promise),
  });
  const pending = lifecycle.run(
    Effect.promise(() =>
      lifecycle.dispatch(() => {
        entered.resolve();
        return write.promise;
      }),
    ).pipe(Effect.map((value) => value + 1)),
    'mutation',
  );
  await entered.promise;
  controller.abort('private cause');
  write.resolve(41);
  const exit = await pending;
  expect(exit).toEqual(Exit.succeed(42));
  expect(protectedWork).toEqual([pending]);
  expect(events).toContain('request_aborted:dispatched');
  expect(events).toContain('write_succeeded:outcome_observed');
  lifecycle.dispose();
});

it('reports a cleanup defect rather than hiding it as expected interruption', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const producer = Promise.withResolvers<void>();
  const outcomes: string[] = [];
  const lifecycle = createRequestLifecycle({
    signal: controller.signal,
    requestId: 'synthetic-id',
    observe: (event) => {
      if (event.outcome) outcomes.push(event.outcome);
    },
  });
  const pending = lifecycle.run(
    Effect.promise(() => {
      entered.resolve();
      return producer.promise;
    }).pipe(Effect.ensuring(Effect.die('synthetic cleanup defect'))),
    'read',
  );
  await entered.promise;
  controller.abort();
  const exit = await pending;
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  expect(outcomes).toEqual(['defect']);
  producer.resolve();
});
