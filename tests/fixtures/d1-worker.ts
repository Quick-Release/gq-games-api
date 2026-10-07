// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { Database } from '../../src/db/database';
import type { WorkerEnv } from '../../src/env';
import { ormProbe } from './schema';

// This entrypoint is only bundled by the isolated integration-test stack.
export default {
  async fetch(request: Request, env: WorkerEnv) {
    if (new URL(request.url).pathname === '/ready') {
      return new Response('ready');
    }
    const program = Effect.gen(function* () {
      const db = yield* Database;
      const value = "synthetic '); DROP TABLE orm_probe; --";
      yield* db.insert(ormProbe).values({ id: 1, value });
      const inserted = yield* db.select().from(ormProbe);
      yield* db
        .update(ormProbe)
        .set({ value: 'updated' })
        .where(eq(ormProbe.id, 1));
      const updated = yield* db.select().from(ormProbe);
      yield* db.delete(ormProbe).where(eq(ormProbe.id, 1));
      const remaining = yield* db.select().from(ormProbe);
      const history = yield* db.all<{ count: number }>(
        sql`select count(*) as count from __alchemy_migrations`,
      );
      const failure = yield* Effect.flip(
        db.all(sql`select * from deliberately_missing_table`),
      );
      return { inserted, updated, remaining, history, error: failure._tag };
    });
    return Response.json(
      await Effect.runPromise(
        program.pipe(Effect.provide(Database.layer(env.DB))),
      ),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
