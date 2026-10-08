// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { eq } from 'drizzle-orm';
import { Clock, Context, Data, Effect, Layer, Schema } from 'effect';
import { Database } from '../db/database';
import { publicationControl } from '../db/schema';

// Never carry driver errors, SQL, parameters, or submitted values through the
// application failure channel. HTTP can map these stable codes without causes.
export class CatalogFailure extends Data.TaggedError('CatalogFailure')<{
  code:
    | 'PUBLICATION_WITHDRAWN'
    | 'SERVICE_UNAVAILABLE'
    | 'INTERNAL_SERVER_ERROR';
}> {}

const authorizationRow = Schema.Struct({
  steam_app_id: Schema.Number,
  outcome: Schema.Literals(['authorized', 'withdrawn']),
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});

const makeCatalog = Effect.gen(function* () {
  const db = yield* Database;
  const sql = db.$client;

  const acquireAuthorization = Effect.fn('Catalog.acquireAuthorization')(
    function* (steamAppId: number) {
      const generation = yield* Effect.sync(() => crypto.randomUUID());
      const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);

      // D1 executes this ordered batch transactionally on the primary. The
      // conflict path never updates existing control (including withdrawal).
      // Outcome and response state are captured INSIDE that same operation;
      // there is no independent post-commit read/classification query.
      const [, captured] = yield* sql
        .batch([
          sql`insert into steam_application_publication
              (steam_app_id, state, generation, generation_issued_at)
              values (${steamAppId}, 'eligible', ${generation}, ${issuedAt})
              on conflict (steam_app_id) do nothing`,
          sql`select steam_app_id,
              case state when 'eligible' then 'authorized' else 'withdrawn' end as outcome,
              generation, generation_issued_at as minimum_observed_at
              from steam_application_publication where steam_app_id = ${steamAppId}`,
        ])
        .pipe(
          Effect.mapError(
            () => new CatalogFailure({ code: 'SERVICE_UNAVAILABLE' }),
          ),
        );

      const row = yield* Schema.decodeUnknownEffect(authorizationRow)(
        captured.length === 1 ? captured[0] : undefined,
      ).pipe(
        Effect.mapError(
          () => new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
        ),
      );
      if (row.outcome === 'withdrawn') {
        return yield* Effect.fail(
          new CatalogFailure({ code: 'PUBLICATION_WITHDRAWN' }),
        );
      }
      return {
        steam_app_id: row.steam_app_id,
        generation: row.generation,
        minimum_observed_at: row.minimum_observed_at,
      };
    },
  );

  const inspectPublication = Effect.fn('Catalog.inspectPublication')(function* (
    steamAppId: number,
  ) {
    const rows = yield* db
      .select()
      .from(publicationControl)
      .where(eq(publicationControl.steamAppId, steamAppId))
      .pipe(
        Effect.mapError(
          () => new CatalogFailure({ code: 'SERVICE_UNAVAILABLE' }),
        ),
      );
    const row = rows[0];
    return {
      steam_app_id: steamAppId,
      state: row?.state ?? ('uninitialized' as const),
      generation: row?.generation ?? null,
      generation_issued_at: row?.generationIssuedAt ?? null,
    };
  });

  return { acquireAuthorization, inspectPublication };
});

// A cohesive application boundary, not query choreography exposed to callers.
// Supply Database per request/execution; never capture a Worker's first binding.
export class Catalog extends Context.Service<
  Catalog,
  Effect.Success<typeof makeCatalog>
>()('gq-games-api/Catalog') {
  static layer = Layer.effect(Catalog, makeCatalog);
}
