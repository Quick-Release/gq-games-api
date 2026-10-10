// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { setImmediate as nextTurn } from 'node:timers/promises';
import { Effect, Exit } from 'effect';
import { expect, it, vi } from 'vite-plus/test';
import { createRequestLifecycle } from '../src/http/request-lifecycle';

// Node evidence for the shared lifecycle only, not Cloudflare/D1 semantics.
const request = (controller = new AbortController()) =>
  createRequestLifecycle({
    signal: controller.signal,
    requestId: 'synthetic-resource-request',
    observe: () => {},
  });

it('completes release of an acquired reader before returning a successful Exit', async () => {
  const stream = new ReadableStream<Uint8Array>();
  const lifecycle = request();
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => stream.getReader()),
        (reader) => Effect.sync(() => reader.releaseLock()),
      );
      expect(stream.locked).toBe(true);
      return 'synthetic result';
    }),
  );

  try {
    const exit = await lifecycle.run(program, 'read');
    expect(exit).toEqual(Exit.succeed('synthetic result'));
    expect(stream.locked).toBe(false);
  } finally {
    lifecycle.dispose();
  }
});

it.each([
  [
    'typed failure',
    Effect.fail('synthetic failure'),
    Exit.fail('synthetic failure'),
  ],
  ['defect', Effect.die('synthetic defect'), Exit.die('synthetic defect')],
])(
  'completes acquired reader release on %s',
  async (_category, outcome, expected) => {
    const stream = new ReadableStream<Uint8Array>();
    const lifecycle = request();
    const program = Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => stream.getReader()),
        (reader) => Effect.sync(() => reader.releaseLock()),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            expect(stream.locked).toBe(true);
          }),
        ),
        Effect.andThen(outcome),
      ),
    );

    try {
      expect(await lifecycle.run(program, 'read')).toEqual(expected);
      expect(stream.locked).toBe(false);
    } finally {
      lifecycle.dispose();
    }
  },
);

it('releases sequentially in reverse acquisition order, waiting for inner cleanup', async () => {
  const lifecycle = request();
  const outer = new ReadableStream<Uint8Array>();
  const inner = new ReadableStream<Uint8Array>();
  const closingInner = Promise.withResolvers<void>();
  const finishInner = Promise.withResolvers<void>();
  const completed: string[] = [];
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => outer.getReader()),
        (reader) =>
          Effect.sync(() => {
            reader.releaseLock();
            completed.push('outer');
          }),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => inner.getReader()),
        (reader) =>
          Effect.promise(async () => {
            closingInner.resolve();
            await finishInner.promise;
            reader.releaseLock();
            completed.push('inner');
          }),
      );
      return 'both acquired';
    }),
  );

  try {
    const pending = lifecycle.run(program, 'read');
    await closingInner.promise;
    expect(inner.locked).toBe(true);
    expect(outer.locked).toBe(true);
    expect(completed).toEqual([]);
    finishInner.resolve();
    expect(await pending).toEqual(Exit.succeed('both acquired'));
    expect(completed).toEqual(['inner', 'outer']);
    expect(inner.locked).toBe(false);
    expect(outer.locked).toBe(false);
  } finally {
    finishInner.resolve();
    lifecycle.dispose();
  }
});

it('waits for cooperative asynchronous reader cleanup before returning an interrupted Exit', async () => {
  const controller = new AbortController();
  const lifecycle = request(controller);
  const stream = new ReadableStream<Uint8Array>();
  const reading = Promise.withResolvers<void>();
  const producer = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const finishClose = Promise.withResolvers<void>();
  let exitReturned = false;
  const program = Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => stream.getReader()),
      (reader) =>
        Effect.promise(async () => {
          closing.resolve();
          await finishClose.promise;
          reader.releaseLock();
        }),
    ).pipe(
      Effect.andThen(
        Effect.promise(() => {
          reading.resolve();
          return producer.promise;
        }),
      ),
    ),
  );

  try {
    const pending = lifecycle.run(program, 'read').then((exit) => {
      exitReturned = true;
      return exit;
    });
    await reading.promise;
    controller.abort();
    await closing.promise;
    await nextTurn();
    expect(exitReturned).toBe(false);
    expect(stream.locked).toBe(true);
    finishClose.resolve();
    expect(Exit.hasInterrupts(await pending)).toBe(true);
    expect(stream.locked).toBe(false);
    expect(exitReturned).toBe(true);
  } finally {
    finishClose.resolve();
    producer.resolve();
    lifecycle.dispose();
  }
});

it.each([
  ['signal-cooperating', true],
  ['noncooperating', false],
])(
  'interrupts a %s Promise read without late Effect continuation',
  async (_label, cooperative) => {
    const controller = new AbortController();
    const lifecycle = request(controller);
    const entered = Promise.withResolvers<AbortSignal>();
    const producer = Promise.withResolvers<string>();
    const produced: string[] = [];
    const continued: string[] = [];
    const adapter = {
      read(signal: AbortSignal) {
        const stop = () => producer.resolve('producer stopped');
        if (cooperative) signal.addEventListener('abort', stop, { once: true });
        entered.resolve(signal);
        return producer.promise
          .then((value) => {
            produced.push(value);
            return value;
          })
          .finally(() => {
            if (cooperative) signal.removeEventListener('abort', stop);
          });
      },
    };
    const program = Effect.promise((signal) => adapter.read(signal)).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          continued.push(value);
        }),
      ),
    );

    try {
      const pending = lifecycle.run(program, 'read');
      const adapterSignal = await entered.promise;
      expect(adapterSignal.aborted).toBe(false);
      controller.abort();
      expect(Exit.hasInterrupts(await pending)).toBe(true);
      expect(adapterSignal.aborted).toBe(true);
      expect(produced).toEqual(cooperative ? ['producer stopped'] : []);
      expect(continued).toEqual([]);

      // Settle an ignored producer explicitly, rather than inferring its teardown
      // from the fiber Exit. Its own completion cannot revive business work.
      producer.resolve('late synthetic result');
      await nextTurn();
      expect(produced).toEqual(
        cooperative ? ['producer stopped'] : ['late synthetic result'],
      );
      expect(continued).toEqual([]);
    } finally {
      producer.resolve('fixture teardown');
      lifecycle.dispose();
    }
  },
);

it.each([
  'success',
  'typed failure',
  'defect',
  'interruption',
  'acquisition failure',
] as const)(
  'removes its owned abort listener on %s and repeated dispose is harmless',
  async (category) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const lifecycle = request(controller);
    const entered = Promise.withResolvers<void>();
    const producer = Promise.withResolvers<void>();
    const programs = {
      success: Effect.void,
      'typed failure': Effect.fail('synthetic failure'),
      defect: Effect.die('synthetic defect'),
      interruption: Effect.promise(() => {
        entered.resolve();
        return producer.promise;
      }),
      'acquisition failure': Effect.scoped(
        Effect.acquireRelease(
          Effect.fail('synthetic acquisition failure'),
          () => Effect.void,
        ),
      ),
    };

    try {
      const added = add.mock.calls.filter(([type]) => type === 'abort');
      expect(added).toHaveLength(1);
      const ownedListener = added[0]?.[1];
      const pending = lifecycle.run(programs[category], 'read');
      if (category === 'interruption') {
        await entered.promise;
        controller.abort();
      }
      const exit = await pending;
      if (category === 'success') expect(Exit.isSuccess(exit)).toBe(true);
      else if (category === 'interruption')
        expect(Exit.hasInterrupts(exit)).toBe(true);
      else if (category === 'defect') expect(Exit.hasDies(exit)).toBe(true);
      else expect(Exit.hasFails(exit)).toBe(true);

      const ownedRemovals = () =>
        remove.mock.calls.filter(
          ([type, listener]) => type === 'abort' && listener === ownedListener,
        );
      expect(ownedRemovals()).toHaveLength(1);
      lifecycle.dispose();
      lifecycle.dispose();
      expect(ownedRemovals()).toHaveLength(1);
    } finally {
      producer.resolve();
      lifecycle.dispose();
      add.mockRestore();
      remove.mockRestore();
    }
  },
);

it.each(
  (['dispatch', 'database exec', 'database batch'] as const).flatMap(
    (boundary) => [
      { boundary, abortAtCheckpoint: true },
      { boundary, abortAtCheckpoint: false },
    ],
  ),
)(
  'beforeMutation gates $boundary (abort=$abortAtCheckpoint), including late producer completion',
  async ({ boundary, abortAtCheckpoint }) => {
    const controller = new AbortController();
    const lifecycle = request(controller);
    const entered = Promise.withResolvers<AbortSignal>();
    const resume = Promise.withResolvers<void>();
    const producerCompleted = Promise.withResolvers<void>();
    const calls = { exec: 0, batch: 0 };
    const binding = {
      prepare() {
        throw new Error('unused synthetic prepare');
      },
      exec() {
        calls.exec += 1;
        return Promise.resolve({ count: 1, duration: 0 });
      },
      batch() {
        calls.batch += 1;
        return Promise.resolve([]);
      },
      dump() {
        throw new Error('unused synthetic dump');
      },
      withSession() {
        throw new Error('unused synthetic session');
      },
    } satisfies D1Database;
    const database = lifecycle.database(binding);
    const mutation = Effect.promise(async () => {
      if (boundary === 'dispatch')
        await lifecycle.dispatch(() => binding.exec());
      else if (boundary === 'database exec')
        await database.exec('synthetic mutation');
      else await database.batch([]);
    });
    const checkpoint = Effect.promise(async (signal) => {
      entered.resolve(signal);
      await resume.promise;
      producerCompleted.resolve();
    });

    try {
      const pending = lifecycle.run(mutation, 'mutation', checkpoint);
      const checkpointSignal = await entered.promise;
      expect(calls).toEqual({ exec: 0, batch: 0 });
      if (abortAtCheckpoint) {
        controller.abort();
        expect(Exit.hasInterrupts(await pending)).toBe(true);
        expect(checkpointSignal.aborted).toBe(true);
        expect(calls).toEqual({ exec: 0, batch: 0 });
      }

      resume.resolve();
      await producerCompleted.promise;
      const exit = await pending;
      await nextTurn();
      if (abortAtCheckpoint) {
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(calls).toEqual({ exec: 0, batch: 0 });
      } else {
        expect(exit).toEqual(Exit.succeed(undefined));
        expect(calls).toEqual(
          boundary === 'database batch'
            ? { exec: 0, batch: 1 }
            : { exec: 1, batch: 0 },
        );
      }
    } finally {
      resume.resolve();
      lifecycle.dispose();
    }
  },
);

it.each(['read', 'mutation'] as const)(
  'already-aborted %s returns an interrupted Exit without synchronous checkpoint or operation work',
  async (policy) => {
    const controller = new AbortController();
    controller.abort();
    const lifecycle = request(controller);
    const work: string[] = [];
    const checkpoint = Effect.sync(() => {
      work.push('checkpoint');
    });
    const program = Effect.sync(() => {
      work.push('operation');
      return 'should not run';
    });

    try {
      const pending = lifecycle.run(program, policy, checkpoint);
      expect(work).toEqual([]);
      expect(Exit.hasInterrupts(await pending)).toBe(true);
      expect(work).toEqual([]);
    } finally {
      lifecycle.dispose();
      expect(work).toEqual([]);
    }
  },
);

it('does not release a reader when acquisition fails', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([7]));
    },
  });
  const owner = stream.getReader();
  const lifecycle = request();
  const program = Effect.scoped(
    Effect.acquireRelease(
      Effect.try({
        try: () => stream.getReader(),
        catch: () => 'reader already borrowed',
      }),
      (reader) => Effect.sync(() => reader.releaseLock()),
    ),
  );

  try {
    expect(await lifecycle.run(program, 'read')).toEqual(
      Exit.fail('reader already borrowed'),
    );
    expect(stream.locked).toBe(true);
    expect(await owner.read()).toEqual({
      done: false,
      value: new Uint8Array([7]),
    });
  } finally {
    owner.releaseLock();
    lifecycle.dispose();
  }
});

it('completes acquired reader release on cooperative request interruption', async () => {
  const controller = new AbortController();
  const lifecycle = request(controller);
  const stream = new ReadableStream<Uint8Array>();
  const entered = Promise.withResolvers<void>();
  const producer = Promise.withResolvers<void>();
  const program = Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => stream.getReader()),
      (reader) => Effect.sync(() => reader.releaseLock()),
    ).pipe(
      Effect.andThen(
        Effect.promise(() => {
          entered.resolve();
          return producer.promise;
        }),
      ),
    ),
  );

  try {
    const pending = lifecycle.run(program, 'read');
    await entered.promise;
    expect(stream.locked).toBe(true);
    controller.abort();
    const exit = await pending;
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(stream.locked).toBe(false);
  } finally {
    producer.resolve();
    lifecycle.dispose();
  }
});
