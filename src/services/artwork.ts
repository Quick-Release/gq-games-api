// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { Database } from '../db/database';
import { CatalogFailure } from './catalog-failure';
import { approveArtwork, validateArtwork } from './artwork-input';
import { validatePublicationCommand } from './publication';

const temporaryFailures = new Set([
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
  return new CatalogFailure({
    code: temporaryFailures.has(message.replace(/^D1_ERROR: /, ''))
      ? 'SERVICE_UNAVAILABLE'
      : 'INTERNAL_SERVER_ERROR',
  });
};
const authorizationRow = Schema.Struct({
  state: Schema.Literals(['eligible', 'withdrawn']),
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});
const publicationRow = Schema.Struct({
  state: Schema.Literals(['eligible', 'withdrawn']),
  generation: Schema.String,
  generation_issued_at: Schema.Number,
});
const publicationDecision = Schema.Struct({
  state: Schema.Literals(['eligible', 'withdrawn']),
  generation: Schema.NullOr(Schema.String),
  generation_issued_at: Schema.NullOr(Schema.Number),
  outcome: Schema.Literals([
    'applied',
    'unchanged',
    'PUBLICATION_GENERATION_MISMATCH',
  ]),
});
const observationDecision = Schema.Struct({
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
const publicContent = Schema.Struct({
  revision: Schema.String,
  observed_at: Schema.Number,
  renditions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      mime: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  provenance: Schema.Struct({
    source_url: Schema.String,
    extractor_version: Schema.String,
  }),
  rights: Schema.Struct({
    holder: Schema.String,
    permission: Schema.String,
    attribution: Schema.String,
  }),
});
const contentRow = Schema.Struct({
  provider: Schema.String,
  asset_id: Schema.String,
  payload: Schema.String,
});
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () => new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
    ),
  );
const decodeContent = Effect.fn('Artwork.decodeContent')(function* (
  input: unknown,
) {
  const row = yield* decode(contentRow, input);
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(row.payload),
    catch: () => new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
  });
  const payload = yield* decode(publicContent, parsed);
  return { provider: row.provider, asset_id: row.asset_id, ...payload };
});
const makeArtwork = Effect.gen(function* () {
  const db = yield* Database;
  const sql = db.$client;
  const acquireAuthorization = Effect.fn('Artwork.acquireAuthorization')(
    function* (provider: string, assetId: string) {
      const generation = yield* Effect.sync(() => crypto.randomUUID());
      const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const [, captured] = yield* sql
        .batch([
          sql`insert into artwork_publication (provider, asset_id, state, generation, generation_issued_at)
        values (${provider}, ${assetId}, 'eligible', ${generation}, ${issuedAt})
        on conflict (provider, asset_id) do nothing`,
          sql`select state, generation, generation_issued_at as minimum_observed_at
        from artwork_publication where provider = ${provider} and asset_id = ${assetId}`,
        ])
        .pipe(
          Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
        );
      const row = yield* Schema.decodeUnknownEffect(authorizationRow)(
        captured[0],
      ).pipe(
        Effect.mapError(
          () => new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
        ),
      );
      if (row.state === 'withdrawn')
        return yield* Effect.fail(
          new CatalogFailure({ code: 'PUBLICATION_WITHDRAWN' }),
        );
      return {
        provider,
        asset_id: assetId,
        generation: row.generation,
        minimum_observed_at: row.minimum_observed_at,
      };
    },
  );
  const inspectPublication = Effect.fn('Artwork.inspectPublication')(function* (
    provider: string,
    assetId: string,
  ) {
    const rows =
      yield* sql`select state, generation, generation_issued_at from artwork_publication
      where provider = ${provider} and asset_id = ${assetId}`.pipe(
        Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
      );
    const row = rows.length ? yield* decode(publicationRow, rows[0]) : null;
    return {
      provider,
      asset_id: assetId,
      state: row?.state ?? ('uninitialized' as const),
      generation: row?.generation ?? null,
      generation_issued_at: row?.generation_issued_at ?? null,
    };
  });

  const changePublication = Effect.fn('Artwork.changePublication')(function* (
    provider: string,
    assetId: string,
    input: unknown,
  ) {
    // This validator's application identity is irrelevant to its shared command shape.
    const { state, expected_generation: expected } =
      yield* validatePublicationCommand(1, input);
    const generation = yield* Effect.sync(() => crypto.randomUUID());
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const permitted = sql`(( ${expected} is null and not exists (
      select 1 from artwork_publication where provider = ${provider} and asset_id = ${assetId}
    )) or exists (select 1 from artwork_publication where provider = ${provider} and asset_id = ${assetId}
      and generation = ${expected} and state <> ${state}))`;
    const [captured] = yield* sql
      .batch([
        sql`select ${state} as state, outcome,
        case when outcome = 'applied' then ${generation} else prior_generation end as generation,
        case when outcome = 'applied' then ${issuedAt} else prior_issued_at end as generation_issued_at
        from (select p.generation as prior_generation, p.generation_issued_at as prior_issued_at,
          case when (p.provider is null and ${expected} is not null)
            or (p.provider is not null and p.generation is not ${expected}) then 'PUBLICATION_GENERATION_MISMATCH'
            when p.state = ${state} then 'unchanged' else 'applied' end as outcome
          from (select 1) requested left join artwork_publication p on p.provider = ${provider} and p.asset_id = ${assetId}) decision`,
        sql`delete from artwork_association where provider = ${provider} and asset_id = ${assetId} and ${permitted}`,
        sql`delete from artwork_content where provider = ${provider} and asset_id = ${assetId} and ${permitted}`,
        sql`insert into artwork_publication (provider, asset_id, state, generation, generation_issued_at)
        select ${provider}, ${assetId}, ${state}, ${generation}, ${issuedAt}
        where ${expected} is null
        on conflict (provider, asset_id) do nothing`,
        sql`update artwork_publication set state = ${state}, generation = ${generation}, generation_issued_at = ${issuedAt}
        where provider = ${provider} and asset_id = ${assetId} and generation = ${expected} and state <> ${state}`,
      ])
      .pipe(
        Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
      );
    const row = yield* decode(publicationDecision, captured[0]);
    if (row.outcome === 'PUBLICATION_GENERATION_MISMATCH')
      return yield* Effect.fail(new CatalogFailure({ code: row.outcome }));
    return { provider, asset_id: assetId, ...row };
  });

  const submitObservation = Effect.fn('Artwork.submitObservation')(function* (
    provider: string,
    assetId: string,
    generation: unknown,
    input: unknown,
    policy: unknown,
  ) {
    const observation = yield* validateArtwork(
      input,
      Math.floor((yield* Clock.currentTimeMillis) / 1000),
    );
    if (
      typeof generation !== 'string' ||
      !generation.trim() ||
      generation.trim() !== generation ||
      Array.from(generation).length > 128
    ) {
      return yield* Effect.fail(
        new CatalogFailure({
          code: 'VALIDATION_FAILED',
          issues: [{ path: 'publication_generation', code: 'INVALID_VALUE' }],
        }),
      );
    }
    yield* approveArtwork(provider, observation, policy);
    const { applications, ...content } = observation;
    const payload = JSON.stringify(content);
    const requested = JSON.stringify(applications);
    // Every guard runs against the primary, within the same batch as pre-state
    // classification. JSON application input is validated and bound, never SQL.
    const applicationsWithdrawn = sql`exists (select 1 from json_each(${requested}) j
      join steam_application_publication a on a.steam_app_id = json_extract(j.value, '$.steam_app_id')
      where a.state = 'withdrawn')`;
    const applicationsMismatch = sql`exists (select 1 from json_each(${requested}) j
      left join steam_application_publication a on a.steam_app_id = json_extract(j.value, '$.steam_app_id')
      where a.steam_app_id is null or a.generation <> json_extract(j.value, '$.generation'))`;
    const belowFloor = sql`exists (select 1 from json_each(${requested}) j
      join steam_application_publication a on a.steam_app_id = json_extract(j.value, '$.steam_app_id')
      where ${observation.observed_at} < a.generation_issued_at)`;
    const authorized = sql`exists (select 1 from artwork_publication p where p.provider = ${provider}
      and p.asset_id = ${assetId} and p.state = 'eligible' and p.generation = ${generation}
      and ${observation.observed_at} >= p.generation_issued_at)
      and not ${applicationsWithdrawn} and not ${applicationsMismatch} and not ${belowFloor}`;
    const newer = sql`not exists (select 1 from artwork_content c where c.provider = ${provider}
      and c.asset_id = ${assetId} and c.observed_at >= ${observation.observed_at})`;
    const [captured] = yield* sql
      .batch([
        sql`select outcome, case when outcome = 'applied' then ${observation.observed_at} else prior_observed_at end as current_observed_at
        from (select c.observed_at as prior_observed_at, case
          when p.state = 'withdrawn' or ${applicationsWithdrawn} then 'PUBLICATION_WITHDRAWN'
          when p.provider is null or p.generation <> ${generation} or ${applicationsMismatch} then 'PUBLICATION_GENERATION_MISMATCH'
          when ${observation.observed_at} < p.generation_issued_at or ${belowFloor} then 'BELOW_PUBLICATION_FLOOR'
          when c.provider is null or ${observation.observed_at} > c.observed_at then 'applied'
          when ${observation.observed_at} < c.observed_at then 'ignored_stale'
          when c.payload = ${payload}
            and (select count(*) from artwork_association l where l.provider = ${provider} and l.asset_id = ${assetId}) = ${applications.length}
            and not exists (select 1 from json_each(${requested}) j where not exists (
              select 1 from artwork_association l where l.provider = ${provider} and l.asset_id = ${assetId}
                and l.steam_app_id = json_extract(j.value, '$.steam_app_id')
                and l.application_generation = json_extract(j.value, '$.generation') and l.asset_generation = ${generation}
            )) then 'unchanged' else 'SNAPSHOT_CONFLICT' end as outcome
          from (select 1) requested left join artwork_publication p on p.provider = ${provider} and p.asset_id = ${assetId}
          left join artwork_content c on c.provider = ${provider} and c.asset_id = ${assetId}) decision`,
        sql`delete from artwork_association where provider = ${provider} and asset_id = ${assetId} and ${authorized} and ${newer}`,
        sql`insert into artwork_association (provider, asset_id, steam_app_id, asset_generation, application_generation)
        select ${provider}, ${assetId}, json_extract(j.value, '$.steam_app_id'), ${generation}, json_extract(j.value, '$.generation')
        from json_each(${requested}) j where ${authorized} and ${newer}`,
        sql`insert into artwork_content (provider, asset_id, observed_at, payload)
        select ${provider}, ${assetId}, ${observation.observed_at}, ${payload} where ${authorized} and ${newer}
        on conflict (provider, asset_id) do update set observed_at = excluded.observed_at, payload = excluded.payload`,
      ])
      .pipe(
        Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
      );
    const row = yield* decode(observationDecision, captured[0]);
    switch (row.outcome) {
      case 'PUBLICATION_WITHDRAWN':
      case 'PUBLICATION_GENERATION_MISMATCH':
      case 'SNAPSHOT_CONFLICT':
        return yield* Effect.fail(new CatalogFailure({ code: row.outcome }));
      case 'BELOW_PUBLICATION_FLOOR':
        return yield* Effect.fail(
          new CatalogFailure({
            code: 'VALIDATION_FAILED',
            issues: [{ path: 'observed_at', code: 'BELOW_PUBLICATION_FLOOR' }],
          }),
        );
      default:
        if (row.current_observed_at === null) {
          return yield* Effect.fail(
            new CatalogFailure({ code: 'INTERNAL_SERVER_ERROR' }),
          );
        }
        return {
          provider,
          asset_id: assetId,
          outcome: row.outcome,
          current_observed_at: row.current_observed_at,
        };
    }
  });

  // Content, global control, current links and current application control are
  // one primary query. No response can bypass eligibility through a pre-read.
  const eligible = sql`p.state = 'eligible' and exists (
    select 1 from artwork_association l join steam_application_publication a on a.steam_app_id = l.steam_app_id
      where l.provider = c.provider and l.asset_id = c.asset_id and l.asset_generation = p.generation
        and a.state = 'eligible' and a.generation = l.application_generation
  )`;
  const resolve = Effect.fn('Artwork.resolve')(function* (
    provider: string,
    assetId: string,
  ) {
    const rows =
      yield* sql`select c.provider, c.asset_id, c.payload from artwork_content c
      join artwork_publication p on p.provider = c.provider and p.asset_id = c.asset_id
      where c.provider = ${provider} and c.asset_id = ${assetId} and ${eligible}`.pipe(
        Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
      );
    if (!rows.length)
      return yield* Effect.fail(new CatalogFailure({ code: 'NOT_FOUND' }));
    return yield* decodeContent(rows[0]);
  });
  const enumerate = Effect.fn('Artwork.enumerate')(function* (
    steamAppId: number,
    page: {
      limit: number;
      cursor: { provider: string; asset_id: string } | null;
    },
  ) {
    const cursor = page.cursor;
    const after = cursor
      ? sql`(c.provider > ${cursor.provider} or (c.provider = ${cursor.provider} and c.asset_id > ${cursor.asset_id}))`
      : sql`1 = 1`;
    const rows =
      yield* sql`select c.provider, c.asset_id, c.payload from artwork_content c
      join artwork_publication p on p.provider = c.provider and p.asset_id = c.asset_id
      join artwork_association l on l.provider = c.provider and l.asset_id = c.asset_id
      join steam_application_publication a on a.steam_app_id = l.steam_app_id
      where l.steam_app_id = ${steamAppId} and p.state = 'eligible' and l.asset_generation = p.generation
        and a.state = 'eligible' and a.generation = l.application_generation and ${after}
      order by c.provider collate binary, c.asset_id collate binary limit ${page.limit + 1}`.pipe(
        Effect.mapError((failure) => databaseFailure(failure.reason.cause)),
      );
    const items = yield* Effect.forEach(
      rows.slice(0, page.limit),
      decodeContent,
    );
    const last = items.at(-1);
    return {
      items,
      next_cursor:
        rows.length > page.limit && last
          ? `${last.provider}:${last.asset_id}`
          : null,
    };
  });
  return {
    acquireAuthorization,
    inspectPublication,
    changePublication,
    submitObservation,
    resolve,
    enumerate,
  };
});

export class Artwork extends Context.Service<
  Artwork,
  Effect.Success<typeof makeArtwork>
>()('gq-games-api/Artwork') {
  static layer = Layer.effect(Artwork, makeArtwork);
}
