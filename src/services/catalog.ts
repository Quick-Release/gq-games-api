// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { and, eq } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlError } from 'effect/sql/SqlError';
import { Database } from '../db/database';
import { applicationSnapshot, publicationControl } from '../db/schema';

import { CatalogFailure } from './catalog-failure';
import { validatePublicationCommand } from './publication';
import { validateSnapshot } from './snapshot';

export { CatalogFailure } from './catalog-failure';

const authorizationRow = Schema.Struct({
  steam_app_id: Schema.Number,
  outcome: Schema.Literals(['authorized', 'withdrawn']),
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});

const publicationDecisionRow = Schema.Struct({
  steam_app_id: Schema.Number,
  state: Schema.Literals(['eligible', 'withdrawn']),
  generation: Schema.NullOr(Schema.String),
  generation_issued_at: Schema.NullOr(Schema.Number),
  outcome: Schema.Literals([
    'applied',
    'unchanged',
    'PUBLICATION_GENERATION_MISMATCH',
  ]),
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

// The pinned D1 client wraps every driver failure in SqlError/UnknownError.
// Recognize only documented transient D1 messages; unknown/permanent failures
// are 500, never mistaken for retryable unavailability. Inspect but do not retain
// or log any driver text. No application retry or second query is introduced.
// https://developers.cloudflare.com/d1/observability/debug-d1/#list-of-d1_errors
const temporaryDatabaseFailures = new Set([
  'Network connection lost.',
  'D1 DB reset because its code was updated.',
  'Internal error while starting up D1 DB storage caused object to be reset.',
  'Internal error in D1 DB storage caused object to be reset.',
  'Cannot resolve D1 DB due to transient issue on remote node.',
  "Can't read from request stream because client disconnected.",
  'D1 DB storage operation exceeded timeout which caused object to be reset.',
  'D1 DB is overloaded. Requests queued for too long.',
  'D1 DB is overloaded. Too many requests queued.',
  "D1 DB's isolate exceeded its memory limit and was reset.",
  'D1 DB exceeded its CPU time limit and was reset.',
]);
const databaseFailure = (cause: unknown) => {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : '';
  const temporary = temporaryDatabaseFailures.has(
    message.replace(/^D1_ERROR: /, ''),
  );
  return new CatalogFailure({
    code: temporary ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_SERVER_ERROR',
  });
};
const lookupQueryFailure = (failure: EffectDrizzleQueryError) => {
  // Drizzle wraps the SQL failure in an Effect Cause, not a bare SqlError.
  const error = Cause.isCause(failure.cause)
    ? Cause.findErrorOption(failure.cause)
    : Option.none();
  return databaseFailure(
    Option.isSome(error) && error.value instanceof SqlError
      ? error.value.reason.cause
      : undefined,
  );
};

const makeCatalog = Effect.gen(function* () {
  const db = yield* Database;
  const sql = db.$client;

  const lookupApplication = Effect.fn('Catalog.lookupApplication')(function* (
    steamAppId: number,
  ) {
    // One primary read admits ONLY existing metadata with existing eligible
    // control. Never split this into a metadata read and an eligibility check,
    // use Sessions, or fetch a source to fill a missing snapshot.
    const rows = yield* db
      .select({
        steamAppId: applicationSnapshot.steamAppId,
        title: applicationSnapshot.title,
        productType: applicationSnapshot.productType,
        baseAppId: applicationSnapshot.baseAppId,
        developers: applicationSnapshot.developers,
        publishers: applicationSnapshot.publishers,
        supportedOs: applicationSnapshot.supportedOs,
        releaseStatus: applicationSnapshot.releaseStatus,
        releaseDateKind: applicationSnapshot.releaseDateKind,
        releaseDate: applicationSnapshot.releaseDate,
        releaseWindow: applicationSnapshot.releaseWindow,
        sourceUrl: applicationSnapshot.sourceUrl,
        language: applicationSnapshot.language,
        observedAt: applicationSnapshot.observedAt,
      })
      .from(applicationSnapshot)
      .innerJoin(
        publicationControl,
        eq(publicationControl.steamAppId, applicationSnapshot.steamAppId),
      )
      .where(
        and(
          eq(applicationSnapshot.steamAppId, steamAppId),
          eq(publicationControl.state, 'eligible'),
        ),
      )
      .pipe(Effect.mapError(lookupQueryFailure));
    const row = rows[0];
    if (!row) {
      return yield* Effect.fail(new CatalogFailure({ code: 'NOT_FOUND' }));
    }
    const date = yield* Effect.gen(function* () {
      switch (row.releaseDateKind) {
        case 'exact':
          if (row.releaseDate !== null && row.releaseWindow === null) {
            return { kind: 'exact' as const, date: row.releaseDate };
          }
          break;
        case 'window':
          if (row.releaseWindow !== null && row.releaseDate === null) {
            return { kind: 'window' as const, window: row.releaseWindow };
          }
          break;
        case 'unknown':
          if (row.releaseDate === null && row.releaseWindow === null) {
            return { kind: 'unknown' as const };
          }
      }
      // A corrupt persisted tag must not invent precision or expose a row.
      return yield* Effect.fail(
        new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
      );
    });
    return {
      steam_app_id: row.steamAppId,
      metadata: {
        title: row.title,
        product_type: row.productType,
        base_app_id: row.baseAppId,
        developers: row.developers,
        publishers: row.publishers,
        supported_os: row.supportedOs,
        release: { status: row.releaseStatus, date },
      },
      provenance: {
        source_url: row.sourceUrl,
        language: row.language,
        observed_at: row.observedAt,
      },
    };
  });

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

  const changePublication = Effect.fn('Catalog.changePublication')(function* (
    steamAppId: number,
    input: unknown,
  ) {
    const { state, expected_generation: expected } =
      yield* validatePublicationCommand(steamAppId, input);
    const generation = yield* Effect.sync(() => crypto.randomUUID());
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    // Candidates become issued generations ONLY on initialization/transition.
    // Capture pre-state, guarded deletion, and guarded control advancement in
    // one ordered primary D1 transaction. Deletion precedes advancement so both
    // guards compare the SAME prior control. SQL failure rolls everything back;
    // rejection and same-state paths deliberately execute no mutations.
    const [captured] = yield* sql
      .batch([
        sql`select steam_app_id, ${state} as state, outcome,
            case when outcome = 'applied' then ${generation}
              else prior_generation end as generation,
            case when outcome = 'applied' then ${issuedAt}
              else prior_issued_at end as generation_issued_at
            from (
              select requested.steam_app_id, p.generation as prior_generation,
                p.generation_issued_at as prior_issued_at,
                case
                  when (p.steam_app_id is null and ${expected} is not null)
                    or (p.steam_app_id is not null and p.generation is not ${expected})
                    then 'PUBLICATION_GENERATION_MISMATCH'
                  when p.state = ${state} then 'unchanged'
                  else 'applied'
                end as outcome
              from (select ${steamAppId} as steam_app_id) requested
              left join steam_application_publication p on p.steam_app_id = requested.steam_app_id
            ) decision`,
        sql`delete from steam_application_snapshot
            where steam_app_id = ${steamAppId} and ${state} = 'withdrawn'
              and (
                (${expected} is null and not exists (
                  select 1 from steam_application_publication where steam_app_id = ${steamAppId}
                ))
                or exists (
                  select 1 from steam_application_publication
                  where steam_app_id = ${steamAppId} and generation = ${expected} and state <> ${state}
                )
              )`,
        sql`insert into steam_application_publication
            (steam_app_id, state, generation, generation_issued_at)
            select ${steamAppId}, ${state}, ${generation}, ${issuedAt}
            where (
              (${expected} is null and not exists (
                select 1 from steam_application_publication where steam_app_id = ${steamAppId}
              ))
              or exists (
                select 1 from steam_application_publication
                where steam_app_id = ${steamAppId} and generation = ${expected} and state <> ${state}
              )
            )
            on conflict (steam_app_id) do update set
              state = excluded.state,
              generation = excluded.generation,
              generation_issued_at = excluded.generation_issued_at
            where steam_application_publication.generation = ${expected}
              and steam_application_publication.state <> ${state}`,
      ])
      .pipe(
        Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
      );
    const row = yield* Schema.decodeUnknownEffect(publicationDecisionRow)(
      captured.length === 1 ? captured[0] : undefined,
    ).pipe(
      Effect.mapError(
        () => new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
      ),
    );
    if (row.outcome === 'PUBLICATION_GENERATION_MISMATCH') {
      return yield* Effect.fail(new CatalogFailure({ code: row.outcome }));
    }
    if (row.generation === null || row.generation_issued_at === null) {
      return yield* Effect.fail(
        new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
      );
    }
    return {
      steam_app_id: row.steam_app_id,
      state: row.state,
      generation: row.generation,
      generation_issued_at: row.generation_issued_at,
      outcome: row.outcome,
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

  return {
    lookupApplication,
    acquireAuthorization,
    inspectPublication,
    changePublication,
    submitSnapshot,
  };
});

// A cohesive application boundary, not query choreography exposed to callers.
// Supply Database per request/execution; never capture a Worker's first binding.
export class Catalog extends Context.Service<
  Catalog,
  Effect.Success<typeof makeCatalog>
>()('gq-games-api/Catalog') {
  static layer = Layer.effect(Catalog, makeCatalog);
}
