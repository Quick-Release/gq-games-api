// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { eq } from 'drizzle-orm';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { Database } from '../db/database';
import { publicationControl } from '../db/schema';

import { CatalogFailure } from './catalog-failure';
import { validateSnapshot } from './snapshot';

export { CatalogFailure } from './catalog-failure';

const authorizationRow = Schema.Struct({
  steam_app_id: Schema.Number,
  outcome: Schema.Literals(['authorized', 'withdrawn']),
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});

const snapshotDecisionRow = Schema.Struct({
  steam_app_id: Schema.Number,
  outcome: Schema.Literals([
    'applied',
    'unchanged',
    'ignored_stale',
    'PUBLICATION_WITHDRAWN',
    'PUBLICATION_GENERATION_MISMATCH',
    'BELOW_PUBLICATION_FLOOR',
    'SNAPSHOT_CONFLICT',
  ]),
  current_observed_at: Schema.NullOr(Schema.Number),
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

  const submitSnapshot = Effect.fn('Catalog.submitSnapshot')(function* (
    steamAppId: number,
    generation: unknown,
    input: unknown,
    approvedSources: unknown,
  ) {
    const snapshot = yield* validateSnapshot(
      steamAppId,
      generation,
      input,
      approvedSources,
    );
    // Validation owns the generation syntax. This invariant check narrows the
    // untrusted argument for SQL without an assertion or another policy parser.
    if (typeof generation !== 'string') {
      return yield* Effect.fail(
        new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
      );
    }
    const { metadata, provenance } = snapshot;
    // Encode scalar spelling before D1's UTF-8 parameter boundary, just like
    // arrays: JSON escapes lone UTF-16 surrogates without normalizing them.
    const eventId = JSON.stringify(snapshot.event_id);
    const title = JSON.stringify(metadata.title);
    const sourceUrl = JSON.stringify(provenance.source_url);
    const extractorVersion = JSON.stringify(provenance.extractor_version);
    const developers =
      metadata.developers === null ? null : JSON.stringify(metadata.developers);
    const publishers =
      metadata.publishers === null ? null : JSON.stringify(metadata.publishers);
    const supportedOs =
      metadata.supported_os === null
        ? null
        : JSON.stringify([...metadata.supported_os].sort());
    const releaseDate =
      metadata.release.date.kind === 'exact'
        ? metadata.release.date.date
        : null;
    const releaseWindow =
      metadata.release.date.kind === 'window'
        ? JSON.stringify(metadata.release.date.window)
        : null;

    // Capture PRE-state and mutate in the SAME ordered, atomic primary batch.
    // The seed guarantees one classification even when control is absent.
    // Withdrawal precedes generation/floor; those precede snapshot ordering.
    // Equality uses canonical columns with null-safe IS, never delivery identity.
    const [captured] = yield* sql
      .batch([
        sql`select steam_app_id, outcome,
            case when outcome = 'applied' then ${provenance.observed_at}
              else prior_observed_at end as current_observed_at
            from (
              select requested.steam_app_id, s.observed_at as prior_observed_at,
                case
                  when p.state = 'withdrawn' then 'PUBLICATION_WITHDRAWN'
                  when p.steam_app_id is null or p.generation <> ${generation}
                    then 'PUBLICATION_GENERATION_MISMATCH'
                  when ${provenance.observed_at} < p.generation_issued_at
                    then 'BELOW_PUBLICATION_FLOOR'
                  when s.steam_app_id is null or ${provenance.observed_at} > s.observed_at
                    then 'applied'
                  when ${provenance.observed_at} < s.observed_at then 'ignored_stale'
                  when s.title is ${title}
                    and s.product_type is ${metadata.product_type}
                    and s.base_app_id is ${metadata.base_app_id}
                    and s.developers is ${developers}
                    and s.publishers is ${publishers}
                    and s.supported_os is ${supportedOs}
                    and s.release_status is ${metadata.release.status}
                    and s.release_date_kind is ${metadata.release.date.kind}
                    and s.release_date is ${releaseDate}
                    and s.release_window is ${releaseWindow}
                    and s.source_url is ${sourceUrl}
                    and s.language is ${provenance.language}
                    and s.observed_at is ${provenance.observed_at}
                    and s.extractor_version is ${extractorVersion}
                    then 'unchanged'
                  else 'SNAPSHOT_CONFLICT'
                end as outcome
              from (select ${steamAppId} as steam_app_id) requested
              left join steam_application_publication p on p.steam_app_id = requested.steam_app_id
              left join steam_application_snapshot s on s.steam_app_id = requested.steam_app_id
            ) decision`,
        sql`insert into steam_application_snapshot
            (steam_app_id, event_id, title, product_type, base_app_id,
             developers, publishers, supported_os, release_status,
             release_date_kind, release_date, release_window, source_url,
             language, observed_at, extractor_version)
            select ${steamAppId}, ${eventId}, ${title},
              ${metadata.product_type}, ${metadata.base_app_id}, ${developers},
              ${publishers}, ${supportedOs}, ${metadata.release.status},
              ${metadata.release.date.kind}, ${releaseDate}, ${releaseWindow},
              ${sourceUrl}, ${provenance.language},
              ${provenance.observed_at}, ${extractorVersion}
            from steam_application_publication p
            left join steam_application_snapshot s on s.steam_app_id = p.steam_app_id
            where p.steam_app_id = ${steamAppId} and p.state = 'eligible'
              and p.generation = ${generation}
              and ${provenance.observed_at} >= p.generation_issued_at
              and (s.steam_app_id is null or ${provenance.observed_at} > s.observed_at)
            on conflict (steam_app_id) do update set
              event_id = excluded.event_id,
              title = excluded.title,
              product_type = excluded.product_type,
              base_app_id = excluded.base_app_id,
              developers = excluded.developers,
              publishers = excluded.publishers,
              supported_os = excluded.supported_os,
              release_status = excluded.release_status,
              release_date_kind = excluded.release_date_kind,
              release_date = excluded.release_date,
              release_window = excluded.release_window,
              source_url = excluded.source_url,
              language = excluded.language,
              observed_at = excluded.observed_at,
              extractor_version = excluded.extractor_version
            where excluded.observed_at > steam_application_snapshot.observed_at`,
      ])
      .pipe(
        Effect.mapError(
          () => new CatalogFailure({ code: 'SERVICE_UNAVAILABLE' }),
        ),
      );

    const row = yield* Schema.decodeUnknownEffect(snapshotDecisionRow)(
      captured.length === 1 ? captured[0] : undefined,
    ).pipe(
      Effect.mapError(
        () => new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
      ),
    );
    switch (row.outcome) {
      case 'PUBLICATION_WITHDRAWN':
      case 'PUBLICATION_GENERATION_MISMATCH':
      case 'SNAPSHOT_CONFLICT':
        return yield* Effect.fail(new CatalogFailure({ code: row.outcome }));
      case 'BELOW_PUBLICATION_FLOOR':
        return yield* Effect.fail(
          new CatalogFailure({
            code: 'VALIDATION_FAILED',
            issues: [
              {
                path: 'provenance.observed_at',
                code: 'BELOW_PUBLICATION_FLOOR',
              },
            ],
          }),
        );
      default:
        if (row.current_observed_at === null) {
          return yield* Effect.fail(
            new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
          );
        }
        return {
          steam_app_id: row.steam_app_id,
          outcome: row.outcome,
          current_observed_at: row.current_observed_at,
        };
    }
  });

  return { acquireAuthorization, inspectPublication, submitSnapshot };
});

// A cohesive application boundary, not query choreography exposed to callers.
// Supply Database per request/execution; never capture a Worker's first binding.
export class Catalog extends Context.Service<
  Catalog,
  Effect.Success<typeof makeCatalog>
>()('gq-games-api/Catalog') {
  static layer = Layer.effect(Catalog, makeCatalog);
}
