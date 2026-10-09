// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { eq, sql } from 'drizzle-orm';
import { Clock, Deferred, Effect, Layer, Schema } from 'effect';
import { createApp } from '../../src/app';
import { Database } from '../../src/db/database';
import { applicationSnapshot, publicationControl } from '../../src/db/schema';
import type { WorkerEnv } from '../../src/env';
import { Catalog } from '../../src/services/catalog';

// This entire adapter is bundled ONLY by catalog-stack.ts. There are no
// production routes, env switches, or service hooks for seeds/faults/clocks.
const app = createApp({ allowInsecureLocalTest: true });
const approvedSources = JSON.stringify([
  ...[
    'https://catalog.example.invalid/apps/1001',
    'https://catalog.example.invalid/apps/1001-alternate',
    'https://CATALOG.example.invalid/apps/1001',
    // Exact synthetic spellings, never normalized through URL.toString().
    ...[
      'café',
      'cafe\u0301',
      'caf%C3%A9',
      '\ud800',
      '\ud801',
      '\udc00',
      '\udc01',
      '\ufffd',
    ].map((spelling) => `https://catalog.example.invalid/apps/${spelling}`),
  ].map((source_url) => ({ source_url, extractor_version: 'synthetic-v1' })),
  ...[
    'synthetic-v2',
    ...['\ud800', '\ud801', '\udc00', '\udc01', '\ufffd', '\u0000'].map(
      (character) => `synthetic-${character}-tail`,
    ),
    'synthetic-\u0000-different-tail',
  ].map((extractor_version) => ({
    source_url: 'https://catalog.example.invalid/apps/1001',
    extractor_version,
  })),
  { source_url: 'https://example.invalid', extractor_version: 'x' },
  {
    source_url: `https://catalog.example.invalid/${'😀'.repeat(2016)}`,
    extractor_version: '😀'.repeat(128),
  },
]);
const submission = Schema.Struct({
  generation: Schema.optionalKey(Schema.Unknown),
  snapshot: Schema.Unknown,
});
const competingSubmissions = Schema.Struct({
  generation: Schema.Unknown,
  snapshots: Schema.Array(Schema.Unknown),
});

const fixedClock = (clock: Clock.Clock, millis: number) => ({
  currentTimeMillisUnsafe: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeNanosUnsafe: clock.currentTimeNanosUnsafe.bind(clock),
  currentTimeNanos: clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: clock.monotonicTimeNanosUnsafe.bind(clock),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: clock.sleep.bind(clock),
});

const failingBatchBinding = (binding: D1Database) =>
  ({
    prepare: binding.prepare.bind(binding),
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      // Execute the ORIGINAL prepared steps plus a later real SQL failure through
      // the ORIGINAL workerd binding. Neither SQL results nor errors are mocked.
      binding.batch<T>([
        ...statements,
        binding.prepare('select * from catalog_fixture_missing_table'),
      ]),
    exec: binding.exec.bind(binding),
    dump: binding.dump.bind(binding),
    withSession: binding.withSession.bind(binding),
  }) satisfies D1Database;

const contenders = (steamAppId: number) =>
  Effect.gen(function* () {
    const catalog = yield* Catalog;
    const clock = yield* Clock.Clock;
    const gate = yield* Deferred.make<void>();
    const candidates = Array.from(
      { length: 12 },
      (_, index) => 1_800_000_000_999 + index * 1_000,
    );
    let arrivals = 0;
    const results = yield* Effect.forEach(
      candidates,
      (millis) =>
        Effect.gen(function* () {
          const contenderClock = {
            ...fixedClock(clock, millis),
            // Catalog generates its candidate before reading the clock. All
            // candidates reach this gate before ANY can submit its D1 batch.
            currentTimeMillis: Effect.gen(function* () {
              arrivals++;
              if (arrivals === candidates.length) {
                yield* Deferred.succeed(gate, undefined);
              }
              yield* Deferred.await(gate);
              return millis;
            }),
          };
          const authorization = yield* catalog
            .acquireAuthorization(steamAppId)
            .pipe(Effect.provideService(Clock.Clock, contenderClock));
          // Inspection starts only after this contender's acquire has returned.
          const inspection = yield* catalog.inspectPublication(steamAppId);
          return { authorization, inspection };
        }),
      { concurrency: 'unbounded' },
    );
    return { arrivals, candidates, results };
  });

const snapshotContenders = (steamAppId: number, input: unknown) =>
  Effect.gen(function* () {
    const { generation, snapshots } =
      Schema.decodeUnknownSync(competingSubmissions)(input);
    const catalog = yield* Catalog;
    const clock = yield* Clock.Clock;
    const gate = yield* Deferred.make<void>();
    let arrivals = 0;
    const results = yield* Effect.forEach(
      snapshots,
      (snapshot, index) =>
        Effect.gen(function* () {
          let arrived = false;
          const millis = 1_700_000_100_999 + index * 1_000;
          const contenderClock = {
            ...fixedClock(clock, millis),
            // Every submit reaches its first clock read before any validation
            // can finish or any submit batch can start. No sleeps or Node mocks.
            currentTimeMillis: Effect.gen(function* () {
              if (!arrived) {
                arrived = true;
                arrivals++;
                if (arrivals === snapshots.length) {
                  yield* Deferred.succeed(gate, undefined);
                }
              }
              yield* Deferred.await(gate);
              return millis;
            }),
          };
          return yield* catalog
            .submitSnapshot(steamAppId, generation, snapshot, approvedSources)
            .pipe(
              Effect.provideService(Clock.Clock, contenderClock),
              Effect.catchTag('CatalogFailure', (failure) =>
                Effect.succeed({ error: { code: failure.code } }),
              ),
            );
        }),
      { concurrency: 'unbounded' },
    );
    return { arrivals, results };
  });

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/ready') return new Response('ready');
    if (url.pathname === '/fixture/http-failure') {
      // The same real rollback injection through production Hono/auth/service
      // mapping. This fixed synthetic adapter is never in the Worker bundle.
      return app.fetch(
        new Request(
          new URL(
            '/internal/v1/steam/applications/5002/ingestion-authorization',
            request.url,
          ),
          request,
        ),
        { ...env, DB: failingBatchBinding(env.DB) },
        ctx,
      );
    }
    if (!url.pathname.startsWith('/fixture/')) {
      return app.fetch(request, env, ctx);
    }

    const [, , operation, id] = url.pathname.split('/');
    const steamAppId = Number(id);
    const binding =
      operation === 'fail' || operation === 'submit-fail'
        ? failingBatchBinding(env.DB)
        : env.DB;
    const input =
      operation?.startsWith('submit') || operation === 'snapshot-contenders'
        ? await request.json()
        : undefined;
    const catalogLayer = Catalog.layer.pipe(
      Layer.provide(Database.layer(binding)),
    );
    const program = Effect.gen(function* () {
      if (operation === 'seed') {
        const db = yield* Database;
        // Fixed, synthetic, insert-only setup. No arbitrary payload, state
        // transition, operator command, or general-purpose SQL endpoint.
        yield* db.insert(publicationControl).values([
          {
            steamAppId: 2001,
            state: 'eligible',
            generation: "synthetic eligible '); DROP TABLE control; --",
            generationIssuedAt: 37,
          },
          {
            steamAppId: 2002,
            state: 'withdrawn',
            generation: 'synthetic-withdrawn-generation',
            generationIssuedAt: 43,
          },
        ]);
        return { seeded: true };
      }
      if (operation === 'audit') {
        const db = yield* Database;
        // Narrow structural/history audit only; behavior uses Catalog inspection.
        const tables = yield* db.all<{ name: string }>(
          sql`select name from sqlite_schema
              where type = 'table' and name not like 'sqlite_%' order by name`,
        );
        const columns = yield* db.all<{ name: string; type: string }>(
          sql`select name, type from pragma_table_info('steam_application_publication')`,
        );
        const history = yield* db.all<{ count: number }>(
          sql`select count(*) as count from __alchemy_migrations`,
        );
        return { tables, columns, history };
      }
      if (operation === 'snapshot-audit') {
        const db = yield* Database;
        // One app only, all accepted fields only. No raw SQL/payload archive,
        // mutation hook, or unbounded snapshot listing is exposed.
        const rows = yield* db
          .select({
            steamAppId: applicationSnapshot.steamAppId,
            eventId: applicationSnapshot.eventId,
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
            extractorVersion: applicationSnapshot.extractorVersion,
          })
          .from(applicationSnapshot)
          .where(eq(applicationSnapshot.steamAppId, steamAppId));
        return { snapshot: rows[0] ?? null };
      }
      if (operation === 'contenders') return yield* contenders(steamAppId);
      if (operation === 'snapshot-contenders') {
        return yield* snapshotContenders(steamAppId, input);
      }
      const catalog = yield* Catalog;
      if (operation?.startsWith('submit')) {
        const { generation, snapshot } =
          Schema.decodeUnknownSync(submission)(input);
        const clock = yield* Clock.Clock;
        return yield* catalog
          .submitSnapshot(
            steamAppId,
            generation,
            snapshot,
            operation === 'submit-no-policy' ? undefined : approvedSources,
          )
          .pipe(
            Effect.provideService(
              Clock.Clock,
              fixedClock(
                clock,
                Number(url.searchParams.get('millis') ?? '1700000100999'),
              ),
            ),
            Effect.catchTag('CatalogFailure', (failure) =>
              Effect.succeed({ error: { code: failure.code } }),
            ),
          );
      }
      if (operation === 'inspect') {
        return yield* catalog.inspectPublication(steamAppId);
      }
      if (operation === 'acquire' || operation === 'fail') {
        const clock = yield* Clock.Clock;
        const millis = Number(
          url.searchParams.get('millis') ?? '1700000000999',
        );
        return yield* catalog.acquireAuthorization(steamAppId).pipe(
          Effect.provideService(Clock.Clock, fixedClock(clock, millis)),
          Effect.catchTag('CatalogFailure', (failure) =>
            Effect.succeed({ error: { code: failure.code } }),
          ),
        );
      }
      return { error: { code: 'NOT_FOUND' } };
    });
    return Response.json(
      await Effect.runPromise(
        program.pipe(
          Effect.provide(catalogLayer),
          Effect.provide(Database.layer(binding)),
        ),
      ),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
