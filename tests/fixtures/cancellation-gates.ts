// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';

// Shared coordination contains only synthetic flags/counters. Every invocation
// owns its timer I/O, body, statements, results, and pending promises.
const gate = (kind: string) => ({
  kind,
  claims: 0,
  checkpoint: 0,
  release: false,
  respond: false,
  abort: false,
  physicalAborts: 0,
  abortBeforeDispatch: 0,
  abortAfterDispatch: 0,
  observedOutcomes: 0,
  batches: 0,
  reads: 0,
  settled: 0,
  forwarded: 0,
  succeeded: 0,
  failed: 0,
  headers: 0,
  request_aborted: 0,
  write_dispatched: 0,
  write_succeeded: 0,
  write_failed: 0,
  effect_exit: 0,
  body_reader_acquired: 0,
  body_reader_released: 0,
  readerLocked: false,
  readerUnlocked: false,
  cleanup_complete: 0,
  interrupted: 0,
  success: 0,
  failure: 0,
  defect: 0,
  correlated: true,
});

export const createCancellationGates = () => {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const control = (request: Request) => {
    const match =
      /^\/fixture\/gates\/([A-Za-z0-9_-]{1,64})\/(arm|state|release|respond|abort)$/.exec(
        new URL(request.url).pathname,
      );
    if (!match) return;
    const [, key, action] = match;
    if (!key) return new Response(null, { status: 400 });
    if (request.method !== (action === 'state' ? 'GET' : 'POST'))
      return new Response(null, { status: 405 });
    if (action === 'arm') {
      const kind = new URL(request.url).searchParams.get('kind') ?? 'pre';
      if (
        ![
          'pre',
          'batch',
          'read',
          'upload',
          'sql-failure',
          'decode-failure',
        ].includes(kind)
      )
        return new Response(null, { status: 400 });
      if (gates.has(key)) return new Response(null, { status: 409 });
      gates.set(key, gate(kind));
    }
    const controls = gates.get(key);
    if (!controls) return new Response(null, { status: 404 });
    if (action === 'release') controls.release = true;
    if (action === 'respond') controls.respond = true;
    if (action === 'abort') controls.abort = true;
    return Response.json(controls);
  };
  const claim = (request: Request) => {
    const key = request.headers.get('X-Fixture-Gate');
    const controls = key ? gates.get(key) : undefined;
    if (!controls || controls.claims++ !== 0)
      throw new Error('Invalid synthetic gate claim');
    return controls;
  };
  const beforeMutation = (controls: ReturnType<typeof gate>) =>
    Effect.gen(function* () {
      if (controls.kind !== 'pre') return;
      controls.checkpoint++;
      const deadline = Date.now() + 20_000;
      while (!controls.release) {
        if (Date.now() >= deadline)
          return yield* Effect.die('Synthetic checkpoint watchdog');
        yield* Effect.sleep('5 millis');
      }
    });
  return { control, claim, beforeMutation };
};

export const waitForResultRelease = async (
  controls: ReturnType<typeof gate>,
) => {
  const deadline = Date.now() + 20_000;
  while (!controls.respond) {
    if (Date.now() >= deadline) throw new Error('Synthetic result watchdog');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};
