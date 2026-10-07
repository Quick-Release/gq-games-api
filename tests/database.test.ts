// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { Database } from '../src/db/database';
import { ormProbe } from './fixtures/schema';

// A deliberately failing binding tests compilation/laziness/error channels,
// not Cloudflare behavior. Real D1 is covered by test:integration in workerd.
const makeBinding = () =>
  ({
    prepare: vi.fn(() => {
      throw new Error('synthetic D1 failure');
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('sessions are not exercised by this unit fixture');
    },
  }) satisfies D1Database;

describe('Effect-native Drizzle database', () => {
  it('builds a request layer without issuing queries', async () => {
    const binding = makeBinding();
    const client = await Effect.runPromise(
      Database.pipe(Effect.provide(Database.layer(binding))),
    );

    expect(client.select().from(ormProbe).toSQL().sql).toContain('orm_probe');
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('uses placeholders rather than interpolating untrusted values', async () => {
    const binding = makeBinding();
    const value = "synthetic ' OR 1=1 --";
    const query = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        return db
          .select()
          .from(ormProbe)
          .where(eq(ormProbe.value, value))
          .toSQL();
      }).pipe(Effect.provide(Database.layer(binding))),
    );

    expect(query.sql).toContain(' = ?');
    expect(query.sql).not.toContain(value);
    expect(query.params).toEqual([value]);
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('reports D1 failures through the typed Effect error channel', async () => {
    const binding = makeBinding();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* Effect.flip(db.select().from(ormProbe));
      }).pipe(Effect.provide(Database.layer(binding))),
    );

    expect(failure._tag).toBe('EffectDrizzleQueryError');
    expect(binding.prepare).toHaveBeenCalledOnce();
  });
});
