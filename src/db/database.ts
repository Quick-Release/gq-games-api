// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import * as D1Client from '@effect/sql-d1/D1Client';
import { defineRelations } from 'drizzle-orm';
import * as Drizzle from 'drizzle-orm/effect-d1';
import { Context, Effect, Layer } from 'effect';
import * as schema from './schema';

const makeDatabase = Drizzle.makeWithDefaults({
  relations: defineRelations(schema),
});

// Queries are Effects already: yield* db.select().from(table), without
// promise adapters or infrastructure imports in the Worker runtime.
export class Database extends Context.Service<
  Database,
  Effect.Success<typeof makeDatabase>
>()('gq-games-api/Database') {
  static layer = (binding: D1Database) =>
    Layer.effect(Database, makeDatabase).pipe(
      Layer.provide(D1Client.layer({ db: binding })),
    );
}
