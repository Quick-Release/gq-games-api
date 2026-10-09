// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { Schema } from 'effect';
import { expect, it } from 'vite-plus/test';
import { verifyHttpLifecycle } from './catalog-lifecycle';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const authorization = Schema.Struct({
  steam_app_id: Schema.Number,
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});
const control = Schema.Struct({
  steam_app_id: Schema.Number,
  state: Schema.Literals(['uninitialized', 'eligible', 'withdrawn']),
  generation: Schema.NullOr(Schema.String),
  generation_issued_at: Schema.NullOr(Schema.Number),
});
const race = Schema.Struct({
  arrivals: Schema.Number,
  candidates: Schema.Array(Schema.Number),
  results: Schema.Array(Schema.Struct({ authorization, inspection: control })),
});
const strict = { onExcessProperty: 'error' } as const;
const snapshotOutcome = Schema.Struct({
  steam_app_id: Schema.Number,
  outcome: Schema.Literals(['applied', 'unchanged', 'ignored_stale']),
  current_observed_at: Schema.Number,
});
const snapshotFailure = Schema.Struct({
  error: Schema.Struct({ code: Schema.String }),
});
const publicationOutcome = Schema.Struct({
  steam_app_id: Schema.Number,
  state: Schema.Literals(['eligible', 'withdrawn']),
  generation: Schema.String,
  generation_issued_at: Schema.Number,
  outcome: Schema.Literals(['applied', 'unchanged']),
});
const publicationRace = Schema.Struct({
  arrivals: Schema.Number,
  withdrawal: Schema.Union([publicationOutcome, snapshotFailure]),
  other: Schema.Union([
    publicationOutcome,
    authorization,
    snapshotOutcome,
    snapshotFailure,
  ]),
});
const snapshotRace = Schema.Struct({
  arrivals: Schema.Number,
  results: Schema.Array(Schema.Union([snapshotOutcome, snapshotFailure])),
});
const snapshotAudit = Schema.Struct({
  snapshot: Schema.NullOr(
    Schema.Struct({
      steamAppId: Schema.Number,
      eventId: Schema.String,
      title: Schema.String,
      productType: Schema.Literals(['game', 'demo', 'dlc']),
      baseAppId: Schema.NullOr(Schema.Number),
      developers: Schema.NullOr(Schema.Array(Schema.String)),
      publishers: Schema.NullOr(Schema.Array(Schema.String)),
      supportedOs: Schema.NullOr(Schema.Array(Schema.String)),
      releaseStatus: Schema.Literals(['upcoming', 'released', 'unknown']),
      releaseDateKind: Schema.Literals(['exact', 'window', 'unknown']),
      releaseDate: Schema.NullOr(Schema.String),
      releaseWindow: Schema.NullOr(Schema.String),
      sourceUrl: Schema.String,
      language: Schema.Literal('en'),
      observedAt: Schema.Number,
      extractorVersion: Schema.String,
    }),
  ),
});
const syntheticSnapshot = (
  observedAt = 1_700_000_010,
  eventId = 'synthetic-delivery-1',
) => ({
  event_id: eventId,
  metadata: {
    title: 'Synthetic Café Demo',
    product_type: 'demo',
    base_app_id: 9001,
    developers: ['Synthetic Developer A', 'Synthetic Developer B'],
    publishers: ['Synthetic Publisher A', 'Synthetic Publisher B'],
    supported_os: ['windows', 'macos', 'linux'],
    release: {
      status: 'upcoming',
      date: { kind: 'exact', date: '2030-04-12' },
    },
  },
  provenance: {
    source_url: 'https://catalog.example.invalid/apps/1001',
    language: 'en',
    observed_at: observedAt,
    extractor_version: 'synthetic-v1',
  },
});
// Independent expected storage, not a projection through production code.
const initialSnapshotRow = {
  steamAppId: 1001,
  eventId: 'synthetic-delivery-1',
  title: 'Synthetic Café Demo',
  productType: 'demo',
  baseAppId: 9001,
  developers: ['Synthetic Developer A', 'Synthetic Developer B'],
  publishers: ['Synthetic Publisher A', 'Synthetic Publisher B'],
  supportedOs: ['linux', 'macos', 'windows'],
  releaseStatus: 'upcoming',
  releaseDateKind: 'exact',
  releaseDate: '2030-04-12',
  releaseWindow: null,
  sourceUrl: 'https://catalog.example.invalid/apps/1001',
  language: 'en',
  observedAt: 1_700_000_010,
  extractorVersion: 'synthetic-v1',
};

const availablePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP port for the catalog test');
  }
  return address.port;
};

it('persists generation-fenced snapshots and publication changes, serves only eligible applications, and rolls back native D1 batches across workerd restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gq-catalog-d1-'));
  const migrations = join(directory, 'migrations');
  const home = join(directory, 'home');
  const config = join(directory, 'config');
  const alchemy = fileURLToPath(
    new URL('../bin/cli.js', import.meta.resolve('alchemy')),
  );
  const stack = fileURLToPath(
    new URL('../fixtures/catalog-stack.ts', import.meta.url),
  );
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  // Credentials exist only in this process and the fixture's process/bindings.
  const ingestion = `${randomUUID()}${randomUUID()}`;
  const admin = `${randomUUID()}${randomUUID()}`;
  const secrets = [ingestion, admin];

  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    // Do not put response text (potential driver diagnostics) in assertion output.
    expect(response.status, 'Fixture adapter response status').toBe(200);
    for (const secret of secrets) {
      expect(text.includes(secret), 'No credential in a fixture response').toBe(
        false,
      );
    }
    const value: unknown = JSON.parse(text);
    return value;
  };
  const inspect = async (id: number) =>
    Schema.decodeUnknownSync(
      control,
      strict,
    )(await json(`/fixture/inspect/${id}`));
  const acquire = async (id: number, millis = 1_700_000_000_999) =>
    Schema.decodeUnknownSync(
      authorization,
      strict,
    )(await json(`/fixture/acquire/${id}?millis=${millis}`));
  const lookup = async (id: number) => json(`/fixture/lookup/${id}`);
  const countedLookup = async (id: number, expected: unknown) => {
    const measured = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Unknown,
        counts: Schema.Struct({
          prepared: Schema.Number,
          executed: Schema.Number,
          batches: Schema.Number,
          execs: Schema.Number,
          sessions: Schema.Number,
        }),
      }),
      strict,
    )(await json(`/fixture/lookup-counted/${id}`));
    expect(measured.result).toEqual(expected);
    // Counts come from actual prepare/execution calls forwarded to workerd.
    // No stubbed result, SQL inspection, or second control/snapshot read.
    expect(measured.counts).toEqual({
      prepared: 1,
      executed: 1,
      batches: 0,
      execs: 0,
      sessions: 0,
    });
  };
  const publicHttp = async (path: string) => {
    const response = await fetch(`${url}${path}`, {
      // Intentionally no bearer credential or publication generation.
      headers: { 'X-Request-ID': 'caller-public-id' },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).toBeTruthy();
    expect(requestId).not.toBe('caller-public-id');
    const text = await response.text();
    for (const secret of secrets) {
      expect(
        text.includes(secret),
        'No credential in public HTTP response',
      ).toBe(false);
    }
    const body: unknown = JSON.parse(text);
    return { status: response.status, requestId, body };
  };
  const lookupHttp = async (id: number | string) =>
    publicHttp(`/v1/steam/applications/${id}`);
  const auditSnapshot = async (id: number) =>
    Schema.decodeUnknownSync(
      snapshotAudit,
      strict,
    )(await json(`/fixture/snapshot-audit/${id}`)).snapshot;
  const submit = async (
    id: number,
    generation: unknown,
    snapshot: unknown,
    operation = 'submit',
    millis = 1_700_000_100_999,
  ) =>
    json(`/fixture/${operation}/${id}?millis=${millis}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation, snapshot }),
    });
  const change = async (
    id: number,
    input: unknown,
    millis = 1_700_000_020_999,
    operation = 'change',
  ) =>
    json(`/fixture/${operation}/${id}?millis=${millis}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  const changed = async (
    id: number,
    state: 'eligible' | 'withdrawn',
    expectedGeneration: string | null,
    millis = 1_700_000_020_999,
  ) =>
    Schema.decodeUnknownSync(
      publicationOutcome,
      strict,
    )(
      await change(
        id,
        { state, expected_generation: expectedGeneration },
        millis,
      ),
    );
  const publicationRaceRequest = async (id: number, input: unknown) =>
    Schema.decodeUnknownSync(
      publicationRace,
      strict,
    )(
      await json(`/fixture/publication-contenders/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
  const applied = (id: number, observedAt: number) => ({
    steam_app_id: id,
    outcome: 'applied',
    current_observed_at: observedAt,
  });
  const assertNoCredentialFiles = async () => {
    for (const entry of await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const contents = new TextDecoder().decode(
        await readFile(join(entry.parentPath, entry.name)),
      );
      for (const secret of secrets) {
        expect(
          contents.includes(secret),
          'No credential persisted to a fixture file',
        ).toBe(false);
      }
    }
  };

  const withWorker = async <A>(run: () => Promise<A>) => {
    // Allowlist the child environment instead of inheriting auth profiles,
    // source credentials, provider keys, or unrelated private configuration.
    const child = spawn(
      process.execPath,
      [
        alchemy,
        'dev',
        '--config',
        stack,
        '--stage',
        'local-catalog-test',
        '--profile',
        'unconfigured-test',
      ],
      {
        cwd: directory,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          HOME: home,
          XDG_CONFIG_HOME: config,
          TMPDIR: directory,
          CLOUDFLARE_API_TOKEN: '',
          CLOUDFLARE_API_KEY: '',
          CLOUDFLARE_ACCOUNT_ID: '',
          CLOUDFLARE_EMAIL: '',
          ALCHEMY_TUI: '0',
          ALCHEMY_DEV_ONCE: '0',
          CI: '1',
          NO_COLOR: '1',
          CATALOG_TEST_PORT: String(port),
          CATALOG_TEST_MIGRATIONS: migrations,
          INGESTION_BEARER_TOKEN: ingestion,
          PUBLICATION_ADMIN_BEARER_TOKEN: admin,
        },
      },
    );
    let started = false;
    let spawnFailed = false;
    let leakedCredential = false;
    let unsafeDiagnostic = false;
    let output = '';
    const prohibitedDiagnostics = [
      'catalog_fixture_missing_table',
      'insert into steam_application_publication',
      'insert into steam_application_snapshot',
      'Synthetic Café Demo',
      'Synthetic Ineligible Game',
      'Synthetic Announced Game',
      'Synthetic Unlinked Demo',
      'Synthetic Released DLC',
      'synthetic-ineligible-snapshot',
      'synthetic-public-game',
      'synthetic-public-demo',
      'synthetic-public-dlc',
      'synthetic-lookup-withdrawn-generation',
      'synthetic-lookup-empty-generation',
      'synthetic-delivery-1',
      'synthetic-lifecycle-observation-',
      'Synthetic Lifecycle Observation',
      'https://catalog.example.invalid/apps/1001',
      'select steam_app_id',
      'D1_ERROR',
      'no such table',
      'SqlError',
      'EffectDrizzleQueryError',
      "synthetic eligible '); DROP TABLE control; --",
      'synthetic-withdrawn-generation',
      '1700000000',
    ];
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      for (const secret of secrets) {
        leakedCredential ||= output.includes(secret);
        output = output.replaceAll(secret, '[redacted]');
      }
      unsafeDiagnostic ||= prohibitedDiagnostics.some((marker) =>
        output.includes(marker),
      );
      started ||= output.includes('[Api] Started');
      output = output.slice(-100_000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => {
      spawnFailed = true;
    });
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    try {
      const deadline = Date.now() + 45_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (spawnFailed || child.exitCode !== null) {
          // Never echo Alchemy/driver output: it may contain SQL or causes.
          throw new Error(
            'Local catalog fixture exited before readiness; diagnostics withheld',
          );
        }
        if (started) {
          try {
            const response = await fetch(`${url}/ready`, {
              signal: AbortSignal.timeout(2_000),
            });
            ready = response.ok && (await response.text()) === 'ready';
            if (ready) break;
          } catch {
            // The local proxy can become visible just before workerd is ready.
          }
        }
        await pause(100);
      }
      expect(ready, 'Local workerd readiness within timeout').toBe(true);
      return await run();
    } finally {
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          await exec('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
          process.kill(-child.pid, 'SIGTERM');
        }
        const timer = setTimeout(() => {
          if (
            child.pid &&
            child.exitCode === null &&
            process.platform !== 'win32'
          ) {
            process.kill(-child.pid, 'SIGKILL');
          }
        }, 5_000);
        await closed;
        clearTimeout(timer);
      }
      // Include shutdown output and late file writes in the leak assertions.
      await closed;
      await assertNoCredentialFiles();
      expect(leakedCredential, 'No credential in child diagnostics').toBe(
        false,
      );
      expect(
        unsafeDiagnostic,
        'No SQL, parameters, content, or driver causes in diagnostics',
      ).toBe(false);
    }
  };

  try {
    await mkdir(home);
    await mkdir(config);
    // Copy reviewed repository migrations as-is. Alchemy alone applies them;
    // no Kit generation, schema push, or second migration executor here.
    await cp(
      fileURLToPath(new URL('../../drizzle/', import.meta.url)),
      migrations,
      {
        recursive: true,
      },
    );

    const persisted = await withWorker(async () => {
      expect(await inspect(1001)).toEqual({
        steam_app_id: 1001,
        state: 'uninitialized',
        generation: null,
        generation_issued_at: null,
      });
      const first = await acquire(1001);
      expect(first).toEqual({
        steam_app_id: 1001,
        generation: expect.any(String),
        minimum_observed_at: 1_700_000_000,
      });
      expect(first.generation.length).toBeGreaterThan(0);
      expect(await inspect(1001)).toEqual({
        steam_app_id: 1001,
        state: 'eligible',
        generation: first.generation,
        generation_issued_at: 1_700_000_000,
      });
      // A later candidate clock must not change the original generation/floor.
      expect(await acquire(1001, 1_900_000_000_001)).toEqual(first);
      expect(await inspect(1001)).toEqual({
        steam_app_id: 1001,
        state: 'eligible',
        generation: first.generation,
        generation_issued_at: 1_700_000_000,
      });
      expect(await json('/fixture/seed', { method: 'POST' })).toEqual({
        seeded: true,
      });
      const eligible = {
        steam_app_id: 2001,
        state: 'eligible',
        generation: "synthetic eligible '); DROP TABLE control; --",
        generation_issued_at: 37,
      };
      expect(await inspect(2001)).toEqual(eligible);
      expect(await acquire(2001)).toEqual({
        steam_app_id: 2001,
        generation: eligible.generation,
        minimum_observed_at: 37,
      });
      expect(await inspect(2001)).toEqual(eligible);
      const withdrawn = {
        steam_app_id: 2002,
        state: 'withdrawn',
        generation: 'synthetic-withdrawn-generation',
        generation_issued_at: 43,
      };
      expect(await inspect(2002)).toEqual(withdrawn);
      expect(await json('/fixture/acquire/2002')).toEqual({
        error: { code: 'PUBLICATION_WITHDRAWN' },
      });
      expect(await inspect(2002)).toEqual(withdrawn);

      expect(await json('/fixture/seed-lookup', { method: 'POST' })).toEqual({
        seeded: true,
      });
      expect((await inspect(6000)).state).toBe('uninitialized');
      expect(await auditSnapshot(6000)).toBeNull();
      expect((await inspect(6001)).state).toBe('uninitialized');
      expect((await inspect(6002)).state).toBe('withdrawn');
      for (const id of [6001, 6002]) {
        expect(await auditSnapshot(id)).toMatchObject({
          steamAppId: id,
          title: 'Synthetic Ineligible Game',
          eventId: 'synthetic-ineligible-snapshot',
        });
      }
      expect((await inspect(6003)).state).toBe('eligible');
      expect(await auditSnapshot(6003)).toBeNull();
      const notFoundIds = [6000, 6001, 6002, 6003, 2002];
      const missingRequestIds = new Set<string | null>();
      for (const id of notFoundIds) {
        expect(await lookup(id)).toEqual({ error: { code: 'NOT_FOUND' } });
        await countedLookup(id, { error: { code: 'NOT_FOUND' } });
        const missing = await lookupHttp(id);
        expect(missing.status).toBe(404);
        // Identical complete envelopes for absent control, orphan snapshot,
        // eligible without snapshot, withdrawn with/without snapshot. Only the
        // fresh server correlation ID differs; all have no-store headers.
        expect(missing.body).toEqual({
          error: { code: 'NOT_FOUND', request_id: missing.requestId },
        });
        expect(missingRequestIds.has(missing.requestId)).toBe(false);
        missingRequestIds.add(missing.requestId);
      }

      // Snapshot submissions never initialize or rewrite publication control.
      const initial = syntheticSnapshot();
      expect(await auditSnapshot(1001)).toBeNull();
      expect(await submit(1001, first.generation, initial)).toEqual(
        applied(1001, 1_700_000_010),
      );
      expect(await auditSnapshot(1001)).toEqual(initialSnapshotRow);
      const initialPublicApplication = {
        steam_app_id: 1001,
        metadata: {
          title: 'Synthetic Café Demo',
          product_type: 'demo',
          base_app_id: 9001,
          developers: ['Synthetic Developer A', 'Synthetic Developer B'],
          publishers: ['Synthetic Publisher A', 'Synthetic Publisher B'],
          supported_os: ['linux', 'macos', 'windows'],
          release: {
            status: 'upcoming',
            date: { kind: 'exact', date: '2030-04-12' },
          },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001',
          language: 'en',
          observed_at: 1_700_000_010,
        },
      };
      expect(await lookup(1001)).toEqual(initialPublicApplication);
      await countedLookup(1001, initialPublicApplication);
      const initialPublic = await lookupHttp(1001);
      expect(initialPublic.status).toBe(200);
      expect(initialPublic.body).toEqual({ data: initialPublicApplication });
      const unchangedControl = await inspect(1001);
      const preserve = async (
        snapshot: unknown,
        expected: unknown,
        generation: unknown = first.generation,
        operation = 'submit',
      ) => {
        expect(await submit(1001, generation, snapshot, operation)).toEqual(
          expected,
        );
        expect(await auditSnapshot(1001)).toEqual(initialSnapshotRow);
        expect(await inspect(1001)).toEqual(unchangedControl);
        expect(await lookup(1001)).toEqual(initialPublicApplication);
      };
      await preserve(
        {
          event_id: 'synthetic-stale',
          metadata: {
            title: 'Synthetic Stale Game',
            product_type: 'game',
            base_app_id: null,
            developers: null,
            publishers: [],
            supported_os: [],
            release: { status: 'released', date: { kind: 'unknown' } },
          },
          provenance: {
            ...initial.provenance,
            observed_at: 1_700_000_009,
            source_url: 'https://catalog.example.invalid/apps/1001-alternate',
          },
        },
        {
          steam_app_id: 1001,
          outcome: 'ignored_stale',
          current_observed_at: 1_700_000_010,
        },
      );
      await preserve(syntheticSnapshot(1_700_000_010, 'synthetic-redelivery'), {
        steam_app_id: 1001,
        outcome: 'unchanged',
        current_observed_at: 1_700_000_010,
      });
      // Equivalent decoded strings, reversed object keys, and OS order all
      // compare semantically; the accepted event must remain the first event.
      const representation = JSON.stringify({
        snapshot: {
          provenance: Object.fromEntries(
            Object.entries(initial.provenance).reverse(),
          ),
          metadata: Object.fromEntries(
            Object.entries({
              ...initial.metadata,
              supported_os: ['linux', 'windows', 'macos'],
            }).reverse(),
          ),
          event_id: 'synthetic-representation-only',
        },
        generation: first.generation,
      }).replace('Café', 'Caf\\u00e9');
      expect(
        await json('/fixture/submit/1001', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: representation,
        }),
      ).toEqual({
        steam_app_id: 1001,
        outcome: 'unchanged',
        current_observed_at: 1_700_000_010,
      });
      expect(await auditSnapshot(1001)).toEqual(initialSnapshotRow);

      // Every independently mutable equality field, including case, internal
      // whitespace, Unicode spelling, ordered credits, null and empty sets.
      const metadataDifferences = [
        { title: 'Synthetic café Demo' },
        { title: 'Synthetic  Café Demo' },
        { title: 'Synthetic Cafe\u0301 Demo' },
        { product_type: 'dlc' },
        { base_app_id: 9002 },
        { base_app_id: null },
        { developers: ['Synthetic Developer B', 'Synthetic Developer A'] },
        { developers: ['Synthetic Developer C'] },
        { developers: null },
        { developers: [] },
        { publishers: ['Synthetic Publisher B', 'Synthetic Publisher A'] },
        { publishers: ['Synthetic Publisher C'] },
        { publishers: null },
        { publishers: [] },
        { supported_os: ['linux'] },
        { supported_os: null },
        { supported_os: [] },
        { release: { ...initial.metadata.release, status: 'released' } },
        { release: { ...initial.metadata.release, status: 'unknown' } },
        {
          release: {
            status: 'upcoming',
            date: { kind: 'exact', date: '2030-04-13' },
          },
        },
        {
          release: {
            status: 'upcoming',
            date: { kind: 'window', window: 'Q4 2030' },
          },
        },
        { release: { status: 'upcoming', date: { kind: 'unknown' } } },
      ];
      for (const difference of metadataDifferences) {
        await preserve(
          {
            ...initial,
            event_id: 'synthetic-conflicting-delivery',
            metadata: { ...initial.metadata, ...difference },
          },
          { error: { code: 'SNAPSHOT_CONFLICT' } },
        );
      }
      for (const difference of [
        { source_url: 'https://catalog.example.invalid/apps/1001-alternate' },
        { source_url: 'https://CATALOG.example.invalid/apps/1001' },
        { extractor_version: 'synthetic-v2' },
      ]) {
        await preserve(
          {
            ...initial,
            event_id: 'synthetic-provenance-conflict',
            provenance: { ...initial.provenance, ...difference },
          },
          { error: { code: 'SNAPSHOT_CONFLICT' } },
        );
      }
      for (const generation of [undefined, null, '', ' synthetic ', 123]) {
        // Pass nullish generations explicitly: preserve's default applies to
        // undefined, so exercise the missing field separately below.
        if (generation === undefined) {
          expect(await submit(1001, undefined, initial)).toEqual({
            error: { code: 'VALIDATION_FAILED' },
          });
          expect(await auditSnapshot(1001)).toEqual(initialSnapshotRow);
        } else {
          await preserve(
            initial,
            { error: { code: 'VALIDATION_FAILED' } },
            generation,
          );
        }
      }
      for (const observedAt of [1_700_000_009, 1_700_000_010, 1_700_000_099]) {
        await preserve(
          syntheticSnapshot(observedAt),
          { error: { code: 'PUBLICATION_GENERATION_MISMATCH' } },
          'synthetic-obsolete-generation',
        );
      }
      await preserve(syntheticSnapshot(1_699_999_999), {
        error: { code: 'VALIDATION_FAILED' },
      });
      await preserve(
        initial,
        { error: { code: 'SOURCE_NOT_APPROVED' } },
        first.generation,
        'submit-no-policy',
      );
      for (const difference of [
        { source_url: 'https://unapproved.example.invalid/apps/1001' },
        { extractor_version: 'synthetic-unapproved' },
      ]) {
        await preserve(
          { ...initial, provenance: { ...initial.provenance, ...difference } },
          { error: { code: 'SOURCE_NOT_APPROVED' } },
        );
      }
      const invalidSnapshots = [
        null,
        { ...initial, steam_app_id: 1001 },
        { ...initial, event_id: ' synthetic-invalid' },
        { ...initial, metadata: { ...initial.metadata, title: ' ' } },
        { ...initial, metadata: { ...initial.metadata, reviews: [] } },
        {
          ...initial,
          metadata: {
            ...initial.metadata,
            developers: ['Duplicate', 'Duplicate'],
          },
        },
        {
          ...initial,
          metadata: {
            ...initial.metadata,
            publishers: ['Duplicate', 'Duplicate'],
          },
        },
        {
          ...initial,
          metadata: { ...initial.metadata, supported_os: ['linux', 'linux'] },
        },
        { ...initial, metadata: { ...initial.metadata, base_app_id: 1001 } },
        { ...initial, metadata: { ...initial.metadata, product_type: 'game' } },
        {
          ...initial,
          metadata: {
            ...initial.metadata,
            release: {
              status: 'released',
              date: { kind: 'exact', date: '2030-02-29' },
            },
          },
        },
        { ...initial, provenance: { ...initial.provenance, language: 'fr' } },
        {
          ...initial,
          provenance: { ...initial.provenance, observed_at: 1_700_000_401 },
        },
        {
          ...initial,
          provenance: { ...initial.provenance, observed_at: 1_700_000_010.5 },
        },
        { ...initial, metadata: { title: initial.metadata.title } },
      ];
      for (const invalid of invalidSnapshots) {
        await preserve(invalid, { error: { code: 'VALIDATION_FAILED' } });
      }
      expect(
        await submit(1003, 'synthetic-absent-generation', initial),
      ).toEqual({
        error: { code: 'PUBLICATION_GENERATION_MISMATCH' },
      });
      expect(await auditSnapshot(1003)).toBeNull();
      expect((await inspect(1003)).state).toBe('uninitialized');
      expect(
        await submit(
          2002,
          withdrawn.generation,
          syntheticSnapshot(1_700_000_100),
        ),
      ).toEqual({ error: { code: 'PUBLICATION_WITHDRAWN' } });
      expect(await auditSnapshot(2002)).toBeNull();
      expect(await inspect(2002)).toEqual(withdrawn);

      // Full replacement clears ALL formerly known nullable fields and date
      // columns, updates event/provenance, and does not touch the generation.
      const cleared = {
        ...syntheticSnapshot(1_700_000_011, 'synthetic-cleared'),
        metadata: {
          title: 'Synthetic Unknown Game',
          product_type: 'game',
          base_app_id: null,
          developers: null,
          publishers: null,
          supported_os: null,
          release: { status: 'unknown', date: { kind: 'unknown' } },
        },
        provenance: {
          ...initial.provenance,
          observed_at: 1_700_000_011,
          source_url: 'https://catalog.example.invalid/apps/1001-alternate',
        },
      };
      expect(await submit(1001, first.generation, cleared)).toEqual(
        applied(1001, 1_700_000_011),
      );
      const clearedRow = {
        ...initialSnapshotRow,
        eventId: 'synthetic-cleared',
        title: 'Synthetic Unknown Game',
        productType: 'game',
        baseAppId: null,
        developers: null,
        publishers: null,
        supportedOs: null,
        releaseStatus: 'unknown',
        releaseDateKind: 'unknown',
        releaseDate: null,
        sourceUrl: 'https://catalog.example.invalid/apps/1001-alternate',
        observedAt: 1_700_000_011,
      };
      expect(await auditSnapshot(1001)).toEqual(clearedRow);
      expect(await lookup(1001)).toEqual({
        steam_app_id: 1001,
        metadata: {
          title: 'Synthetic Unknown Game',
          product_type: 'game',
          base_app_id: null,
          developers: null,
          publishers: null,
          supported_os: null,
          release: { status: 'unknown', date: { kind: 'unknown' } },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001-alternate',
          language: 'en',
          observed_at: 1_700_000_011,
        },
      });
      expect(await inspect(1001)).toEqual(unchangedControl);
      for (const difference of [
        { developers: [] },
        { publishers: [] },
        { supported_os: [] },
      ]) {
        expect(
          await submit(1001, first.generation, {
            ...cleared,
            metadata: { ...cleared.metadata, ...difference },
          }),
        ).toEqual({ error: { code: 'SNAPSHOT_CONFLICT' } });
        expect(await auditSnapshot(1001)).toEqual(clearedRow);
      }
      const windowed = {
        ...initial,
        event_id: 'synthetic-window',
        metadata: {
          ...initial.metadata,
          release: {
            status: 'upcoming',
            date: { kind: 'window', window: 'Q4 2030' },
          },
        },
        provenance: {
          ...initial.provenance,
          observed_at: 1_700_000_012,
          extractor_version: 'synthetic-v2',
        },
      };
      expect(await submit(1001, first.generation, windowed)).toEqual(
        applied(1001, 1_700_000_012),
      );
      const windowRow = {
        ...initialSnapshotRow,
        eventId: 'synthetic-window',
        observedAt: 1_700_000_012,
        releaseDateKind: 'window',
        releaseDate: null,
        releaseWindow: 'Q4 2030',
        extractorVersion: 'synthetic-v2',
      };
      expect(await auditSnapshot(1001)).toEqual(windowRow);
      const windowPublicApplication = {
        steam_app_id: 1001,
        metadata: {
          title: 'Synthetic Café Demo',
          product_type: 'demo',
          base_app_id: 9001,
          developers: ['Synthetic Developer A', 'Synthetic Developer B'],
          publishers: ['Synthetic Publisher A', 'Synthetic Publisher B'],
          supported_os: ['linux', 'macos', 'windows'],
          release: {
            status: 'upcoming',
            date: { kind: 'window', window: 'Q4 2030' },
          },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001',
          language: 'en',
          observed_at: 1_700_000_012,
        },
      };
      await countedLookup(1001, windowPublicApplication);
      const lastKnown = await lookupHttp(1001);
      expect(lastKnown.status).toBe(200);
      expect(lastKnown.body).toEqual({ data: windowPublicApplication });
      expect(
        await submit(1001, first.generation, {
          ...windowed,
          metadata: {
            ...windowed.metadata,
            release: {
              status: 'upcoming',
              date: { kind: 'window', window: 'Q1 2031' },
            },
          },
        }),
      ).toEqual({ error: { code: 'SNAPSHOT_CONFLICT' } });
      expect(await auditSnapshot(1001)).toEqual(windowRow);

      // D1's raw TEXT binds collapse lone UTF-16 surrogates to U+FFFD and
      // SQLite string functions stop at NUL. Audit through Drizzle decoding,
      // not raw SQL or JSON.stringify expectations derived from service code.
      const unicodeCharacters = [
        '\ud800',
        '\ud801',
        '\udc00',
        '\udc01',
        '\ufffd',
        '\u0000',
      ];
      for (const [index, character] of unicodeCharacters.entries()) {
        const id = 4201 + index;
        const permit = await acquire(id);
        const beforeControl = await inspect(id);
        const scalar = `synthetic-${character}-tail`;
        const different = `synthetic-${
          unicodeCharacters[index ^ 1] ?? character
        }-tail`;
        const snapshot = {
          ...initial,
          event_id: scalar,
          metadata: {
            ...initial.metadata,
            title: scalar,
            release: {
              status: 'upcoming',
              date: { kind: 'window', window: scalar },
            },
          },
          provenance: {
            ...initial.provenance,
            extractor_version: scalar,
          },
        };
        const row = {
          ...initialSnapshotRow,
          steamAppId: id,
          eventId: scalar,
          title: scalar,
          releaseDateKind: 'window',
          releaseDate: null,
          releaseWindow: scalar,
          extractorVersion: scalar,
        };
        expect(await submit(id, permit.generation, snapshot)).toEqual(
          applied(id, 1_700_000_010),
        );
        expect(await auditSnapshot(id)).toEqual(row);
        // Event identity is excluded from content equality, but the originally
        // accepted event spelling must survive an identical redelivery.
        expect(
          await submit(id, permit.generation, {
            ...snapshot,
            event_id: different,
          }),
        ).toEqual({
          steam_app_id: id,
          outcome: 'unchanged',
          current_observed_at: 1_700_000_010,
        });
        expect(await auditSnapshot(id)).toEqual(row);
        // Isolate each content comparison: one lossy field cannot be hidden
        // by a correctly compared field elsewhere in the same snapshot.
        for (const candidate of [
          {
            ...snapshot,
            metadata: { ...snapshot.metadata, title: different },
          },
          {
            ...snapshot,
            metadata: {
              ...snapshot.metadata,
              release: {
                status: 'upcoming',
                date: { kind: 'window', window: different },
              },
            },
          },
          {
            ...snapshot,
            provenance: {
              ...snapshot.provenance,
              extractor_version: different,
            },
          },
        ]) {
          expect(await submit(id, permit.generation, candidate)).toEqual({
            error: { code: 'SNAPSHOT_CONFLICT' },
          });
          expect(await auditSnapshot(id)).toEqual(row);
        }
        if (character === '\u0000') {
          // Different text AFTER NUL must participate in equality too.
          const afterNul = 'synthetic-\u0000-different-tail';
          for (const candidate of [
            {
              ...snapshot,
              metadata: { ...snapshot.metadata, title: afterNul },
            },
            {
              ...snapshot,
              metadata: {
                ...snapshot.metadata,
                release: {
                  status: 'upcoming',
                  date: { kind: 'window', window: afterNul },
                },
              },
            },
            {
              ...snapshot,
              provenance: {
                ...snapshot.provenance,
                extractor_version: afterNul,
              },
            },
          ]) {
            expect(await submit(id, permit.generation, candidate)).toEqual({
              error: { code: 'SNAPSHOT_CONFLICT' },
            });
            expect(await auditSnapshot(id)).toEqual(row);
          }
        }
        // A newer observation replaces scalar spelling and clears a formerly
        // known window to SQL NULL, not a JSON string or JSON null artifact.
        expect(
          await submit(id, permit.generation, {
            ...cleared,
            event_id: different,
            metadata: { ...cleared.metadata, title: different },
            provenance: {
              ...initial.provenance,
              observed_at: 1_700_000_011,
              extractor_version: different,
            },
          }),
        ).toEqual(applied(id, 1_700_000_011));
        expect(await auditSnapshot(id)).toEqual({
          ...clearedRow,
          steamAppId: id,
          eventId: different,
          title: different,
          sourceUrl: initial.provenance.source_url,
          extractorVersion: different,
        });
        expect(await inspect(id)).toEqual(beforeControl);
      }

      // Minimum and maximum ordinary Unicode scalar lengths still work. Emoji
      // are one code point, not two UTF-16 units or four UTF-8 bytes.
      for (const [id, title, eventId, window, extractorVersion, sourceUrl] of [
        [4207, 'x', 'x', 'x', 'x', 'https://example.invalid'],
        [
          4208,
          '😀'.repeat(512),
          '😀'.repeat(128),
          '😀'.repeat(256),
          '😀'.repeat(128),
          `https://catalog.example.invalid/${'😀'.repeat(2016)}`,
        ],
      ] as const) {
        const permit = await acquire(id);
        const snapshot = {
          ...initial,
          event_id: eventId,
          metadata: {
            ...initial.metadata,
            title,
            release: { status: 'upcoming', date: { kind: 'window', window } },
          },
          provenance: {
            ...initial.provenance,
            source_url: sourceUrl,
            extractor_version: extractorVersion,
          },
        };
        const row = {
          ...initialSnapshotRow,
          steamAppId: id,
          eventId,
          title,
          releaseDateKind: 'window',
          releaseDate: null,
          releaseWindow: window,
          sourceUrl,
          extractorVersion,
        };
        expect(await submit(id, permit.generation, snapshot)).toEqual(
          applied(id, 1_700_000_010),
        );
        expect(await auditSnapshot(id)).toEqual(row);
        expect(
          await submit(id, permit.generation, {
            ...snapshot,
            event_id: 'synthetic-boundary-redelivery',
          }),
        ).toEqual({
          steam_app_id: id,
          outcome: 'unchanged',
          current_observed_at: 1_700_000_010,
        });
        expect(await auditSnapshot(id)).toEqual(row);
        // Bounds remain enforced by the real service before D1 writes.
        const invalidScalar = id === 4207 ? '' : '😀';
        for (const candidate of [
          { ...snapshot, event_id: id === 4207 ? '' : eventId + invalidScalar },
          {
            ...snapshot,
            metadata: {
              ...snapshot.metadata,
              title: id === 4207 ? '' : title + invalidScalar,
            },
          },
          {
            ...snapshot,
            metadata: {
              ...snapshot.metadata,
              release: {
                status: 'upcoming',
                date: {
                  kind: 'window',
                  window: id === 4207 ? '' : window + invalidScalar,
                },
              },
            },
          },
          {
            ...snapshot,
            provenance: {
              ...snapshot.provenance,
              extractor_version:
                id === 4207 ? '' : extractorVersion + invalidScalar,
            },
          },
          {
            ...snapshot,
            provenance: {
              ...snapshot.provenance,
              source_url: id === 4207 ? '' : sourceUrl + invalidScalar,
            },
          },
        ]) {
          expect(await submit(id, permit.generation, candidate)).toEqual({
            error: { code: 'VALIDATION_FAILED' },
          });
          expect(await auditSnapshot(id)).toEqual(row);
        }
      }

      // Exact approved source spelling includes literal lone surrogates in the
      // path. URL parsing may accept/normalize them, but storage must not. NUL
      // is deliberately NOT used in URLs because the validator rejects it.
      const sourcePermit = await acquire(4209);
      const sourceSpellings = [
        'café',
        'cafe\u0301',
        'caf%C3%A9',
        '\ud800',
        '\ud801',
        '\udc00',
        '\udc01',
        '\ufffd',
      ].map((spelling) => `https://catalog.example.invalid/apps/${spelling}`);
      for (const [index, sourceUrl] of sourceSpellings.entries()) {
        const observedAt = 1_700_000_010 + index;
        const eventId = `synthetic-source-spelling-${index}`;
        const snapshot = {
          ...syntheticSnapshot(observedAt, eventId),
          provenance: {
            ...initial.provenance,
            observed_at: observedAt,
            source_url: sourceUrl,
          },
        };
        const row = {
          ...initialSnapshotRow,
          steamAppId: 4209,
          eventId,
          observedAt,
          sourceUrl,
        };
        expect(await submit(4209, sourcePermit.generation, snapshot)).toEqual(
          applied(4209, observedAt),
        );
        expect(await auditSnapshot(4209)).toEqual(row);
        expect(
          await submit(4209, sourcePermit.generation, {
            ...snapshot,
            event_id: 'synthetic-source-redelivery',
          }),
        ).toEqual({
          steam_app_id: 4209,
          outcome: 'unchanged',
          current_observed_at: observedAt,
        });
        for (const differentSource of sourceSpellings) {
          if (differentSource === sourceUrl) continue;
          expect(
            await submit(4209, sourcePermit.generation, {
              ...snapshot,
              provenance: {
                ...snapshot.provenance,
                source_url: differentSource,
              },
            }),
          ).toEqual({ error: { code: 'SNAPSHOT_CONFLICT' } });
          expect(await auditSnapshot(4209)).toEqual(row);
        }
      }

      // Accepted event IDs are not globally unique; the base target need not
      // exist. The exact floor and +300-second future bound both permit writes.
      const second = await acquire(1002);
      expect(
        await submit(1002, second.generation, syntheticSnapshot(1_700_000_000)),
      ).toEqual(applied(1002, 1_700_000_000));
      expect(await auditSnapshot(1002)).toEqual({
        ...initialSnapshotRow,
        steamAppId: 1002,
        observedAt: 1_700_000_000,
      });
      expect((await inspect(9001)).state).toBe('uninitialized');
      const future = await acquire(1004);
      expect(
        await submit(1004, future.generation, syntheticSnapshot(1_700_000_400)),
      ).toEqual(applied(1004, 1_700_000_400));
      const futureRow = {
        ...initialSnapshotRow,
        steamAppId: 1004,
        observedAt: 1_700_000_400,
      };
      expect(await auditSnapshot(1004)).toEqual(futureRow);
      expect(
        await submit(1004, future.generation, syntheticSnapshot(1_700_000_401)),
      ).toEqual({ error: { code: 'VALIDATION_FAILED' } });
      expect(await auditSnapshot(1004)).toEqual(futureRow);

      const independentGenerations = new Set([first.generation]);
      for (const id of [1, 4294967295]) {
        const independent = await acquire(id, 1_700_000_001_000);
        expect(independent).toEqual({
          steam_app_id: id,
          generation: expect.any(String),
          minimum_observed_at: 1_700_000_001,
        });
        expect(independentGenerations.has(independent.generation)).toBe(false);
        independentGenerations.add(independent.generation);
        expect(await inspect(id)).toEqual({
          steam_app_id: id,
          state: 'eligible',
          generation: independent.generation,
          generation_issued_at: 1_700_000_001,
        });
      }
      // Two cold IDs exercise coordinated actual contention, not sleeps alone.
      for (const id of [3001, 3002]) {
        expect((await inspect(id)).state).toBe('uninitialized');
        const competition = Schema.decodeUnknownSync(
          race,
          strict,
        )(await json(`/fixture/contenders/${id}`));
        expect(competition.arrivals).toBe(12);
        expect(competition.results).toHaveLength(12);
        expect(new Set(competition.candidates).size).toBe(12);
        const committed = competition.results[0]?.authorization;
        expect(committed).toBeDefined();
        if (!committed)
          throw new Error('Expected a committed contender result');
        expect(committed.steam_app_id).toBe(id);
        expect(committed.generation.length).toBeGreaterThan(0);
        expect(committed.minimum_observed_at).toBeGreaterThanOrEqual(
          1_800_000_000,
        );
        expect(committed.minimum_observed_at).toBeLessThanOrEqual(
          1_800_000_011,
        );
        expect(Number.isInteger(committed.minimum_observed_at)).toBe(true);
        for (const result of competition.results) {
          expect(result.authorization).toEqual(committed);
          expect(result.inspection).toEqual({
            steam_app_id: id,
            state: 'eligible',
            generation: committed.generation,
            generation_issued_at: committed.minimum_observed_at,
          });
        }
        expect(await acquire(id, 1_950_000_000_000)).toEqual(committed);
      }
      expect((await inspect(4001)).state).toBe('uninitialized');
      expect(await json('/fixture/fail/4001')).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });
      expect(await inspect(4001)).toEqual({
        steam_app_id: 4001,
        state: 'uninitialized',
        generation: null,
        generation_issued_at: null,
      });
      // After rollback, the same ID can commit normally with a NEW floor.
      expect((await acquire(4001, 1_700_000_009_999)).minimum_observed_at).toBe(
        1_700_000_009,
      );

      const compete = async (
        id: number,
        generation: string,
        snapshots: unknown[],
      ) =>
        Schema.decodeUnknownSync(
          snapshotRace,
          strict,
        )(
          await json(`/fixture/snapshot-contenders/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ generation, snapshots }),
          }),
        );
      // Scrambled unique times give real concurrent newer/older competition.
      // A successful apply reports ITS timestamp even if a later write wins.
      for (const [id, existing] of [
        [3101, false],
        [3102, true],
      ] as const) {
        const permit = await acquire(id);
        if (existing) {
          expect(
            await submit(
              id,
              permit.generation,
              syntheticSnapshot(1_700_000_024, 'synthetic-existing'),
            ),
          ).toEqual(applied(id, 1_700_000_024));
        }
        const observations = [
          30, 21, 27, 20, 31, 23, 29, 22, 28, 25, 26, 19,
        ].map((second) => 1_700_000_000 + second);
        const snapshots = observations.map((time, index) => ({
          ...syntheticSnapshot(time, `synthetic-contender-${index}`),
          metadata: {
            ...initial.metadata,
            title: `Synthetic Contender ${index}`,
          },
        }));
        const competition = await compete(id, permit.generation, snapshots);
        expect(competition.arrivals).toBe(12);
        expect(competition.results).toHaveLength(12);
        const acceptedTimes = new Set<number>(existing ? [1_700_000_024] : []);
        for (const [index, result] of competition.results.entries()) {
          expect('error' in result).toBe(false);
          if ('error' in result)
            throw new Error('Unexpected snapshot contender rejection');
          expect(result.steam_app_id).toBe(id);
          const time = observations[index];
          if (time === undefined)
            throw new Error('Missing contender observation');
          if (result.outcome === 'applied') {
            expect(result.current_observed_at).toBe(time);
            acceptedTimes.add(time);
          } else {
            expect(result.outcome).toBe('ignored_stale');
            expect(result.current_observed_at).toBeGreaterThan(time);
          }
        }
        // A stale response must name an actually accepted atomic pre-state,
        // never its own uncommitted payload or a nonexistent intermediate row.
        for (const result of competition.results) {
          if ('error' in result)
            throw new Error('Unexpected snapshot contender rejection');
          expect(acceptedTimes.has(result.current_observed_at)).toBe(true);
        }
        expect(competition.results[4]).toEqual(applied(id, 1_700_000_031));
        expect(await auditSnapshot(id)).toEqual({
          ...initialSnapshotRow,
          steamAppId: id,
          eventId: 'synthetic-contender-4',
          title: 'Synthetic Contender 4',
          observedAt: 1_700_000_031,
        });
        expect(await inspect(id)).toEqual({
          steam_app_id: id,
          state: 'eligible',
          generation: permit.generation,
          generation_issued_at: permit.minimum_observed_at,
        });
      }
      // Equal differing contenders establish exactly one winner, with every
      // loser a mutation-free conflict. Equal decoded contenders are no-ops.
      for (const [id, different] of [
        [3201, true],
        [3202, false],
      ] as const) {
        const permit = await acquire(id);
        const snapshots = Array.from({ length: 12 }, (_, index) => ({
          ...syntheticSnapshot(1_700_000_030, `synthetic-equal-${index}`),
          metadata: {
            ...initial.metadata,
            title: different
              ? `Synthetic Equal ${index}`
              : initial.metadata.title,
          },
        }));
        const competition = await compete(id, permit.generation, snapshots);
        expect(competition.arrivals).toBe(12);
        expect(competition.results).toHaveLength(12);
        const winners = competition.results.flatMap((result, index) =>
          !('error' in result) && result.outcome === 'applied' ? [index] : [],
        );
        expect(winners).toHaveLength(1);
        const winner = winners[0];
        if (winner === undefined)
          throw new Error('Expected an equal-time winner');
        for (const [index, result] of competition.results.entries()) {
          expect(result).toEqual(
            index === winner
              ? applied(id, 1_700_000_030)
              : different
                ? { error: { code: 'SNAPSHOT_CONFLICT' } }
                : {
                    steam_app_id: id,
                    outcome: 'unchanged',
                    current_observed_at: 1_700_000_030,
                  },
          );
        }
        expect(await auditSnapshot(id)).toEqual({
          ...initialSnapshotRow,
          steamAppId: id,
          eventId: `synthetic-equal-${winner}`,
          title: different
            ? `Synthetic Equal ${winner}`
            : initialSnapshotRow.title,
          observedAt: 1_700_000_030,
        });
      }

      // The binding appends a REAL failing SQL step after the real submit
      // batch. Both inserts and replacements must roll back, not just report
      // failure after leaving a partial mutation behind.
      const rollbackPermit = await acquire(4101);
      const rollbackControl = await inspect(4101);
      const rollbackFirst = syntheticSnapshot(
        1_700_000_050,
        'synthetic-rollback-first',
      );
      expect(
        await submit(
          4101,
          rollbackPermit.generation,
          rollbackFirst,
          'submit-fail',
        ),
      ).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR' } });
      expect(await auditSnapshot(4101)).toBeNull();
      expect(await inspect(4101)).toEqual(rollbackControl);
      expect(
        await submit(4101, rollbackPermit.generation, rollbackFirst),
      ).toEqual(applied(4101, 1_700_000_050));
      const rollbackRow = {
        ...initialSnapshotRow,
        steamAppId: 4101,
        eventId: 'synthetic-rollback-first',
        observedAt: 1_700_000_050,
      };
      expect(await auditSnapshot(4101)).toEqual(rollbackRow);
      const rollbackReplacement = {
        ...cleared,
        event_id: 'synthetic-rollback-replacement',
        provenance: { ...cleared.provenance, observed_at: 1_700_000_051 },
      };
      expect(
        await submit(
          4101,
          rollbackPermit.generation,
          rollbackReplacement,
          'submit-fail',
        ),
      ).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR' } });
      expect(await auditSnapshot(4101)).toEqual(rollbackRow);
      expect(await inspect(4101)).toEqual(rollbackControl);
      // Retry unchanged payload/event/generation after the uncertain failure.
      expect(
        await submit(4101, rollbackPermit.generation, rollbackReplacement),
      ).toEqual(applied(4101, 1_700_000_051));
      const retriedRow = {
        ...clearedRow,
        steamAppId: 4101,
        eventId: 'synthetic-rollback-replacement',
        observedAt: 1_700_000_051,
      };
      expect(await auditSnapshot(4101)).toEqual(retriedRow);
      expect(
        await submit(4101, rollbackPermit.generation, rollbackReplacement),
      ).toEqual({
        steam_app_id: 4101,
        outcome: 'unchanged',
        current_observed_at: 1_700_000_051,
      });
      expect(await auditSnapshot(4101)).toEqual(retriedRow);
      // A response can be lost after COMMIT too: discard it, accept a newer
      // observation, and retry the original without expecting original outcome.
      const uncertain = syntheticSnapshot(1_700_000_052, 'synthetic-uncertain');
      await submit(4101, rollbackPermit.generation, uncertain);
      expect(
        await submit(
          4101,
          rollbackPermit.generation,
          syntheticSnapshot(1_700_000_053, 'synthetic-after-uncertain'),
        ),
      ).toEqual(applied(4101, 1_700_000_053));
      const afterUncertain = {
        ...initialSnapshotRow,
        steamAppId: 4101,
        eventId: 'synthetic-after-uncertain',
        observedAt: 1_700_000_053,
      };
      expect(await auditSnapshot(4101)).toEqual(afterUncertain);
      expect(await submit(4101, rollbackPermit.generation, uncertain)).toEqual({
        steam_app_id: 4101,
        outcome: 'ignored_stale',
        current_observed_at: 1_700_000_053,
      });
      expect(await auditSnapshot(4101)).toEqual(afterUncertain);

      // Issue #5: service acceptance through the SAME workerd/D1 run. Persisted
      // audits below are narrowly for deletion/retention, never public lookup.
      const mismatch = { error: { code: 'PUBLICATION_GENERATION_MISMATCH' } };
      const deniedPublication = { error: { code: 'PUBLICATION_WITHDRAWN' } };
      const publicationGenerations = new Set<string>();
      for (const [id, state] of [
        [7001, 'eligible'],
        [7002, 'withdrawn'],
      ] as const) {
        expect(await inspect(id)).toEqual({
          steam_app_id: id,
          state: 'uninitialized',
          generation: null,
          generation_issued_at: null,
        });
        expect(
          await change(id, { state, expected_generation: 'synthetic-absent' }),
        ).toEqual(mismatch);
        expect((await inspect(id)).state).toBe('uninitialized');
        const initialized = await changed(id, state, null);
        expect(initialized).toEqual({
          steam_app_id: id,
          state,
          generation: expect.any(String),
          generation_issued_at: 1_700_000_020,
          outcome: 'applied',
        });
        expect(initialized.generation.length).toBeGreaterThan(0);
        expect(publicationGenerations.has(initialized.generation)).toBe(false);
        publicationGenerations.add(initialized.generation);
        const { outcome: _outcome, ...stored } = initialized;
        expect(await inspect(id)).toEqual(stored);
        expect(
          await changed(id, state, initialized.generation, 1_900_000_000_999),
        ).toEqual({
          ...initialized,
          outcome: 'unchanged',
        });
        for (const target of ['eligible', 'withdrawn']) {
          for (const expectedGeneration of [null, 'synthetic-stale']) {
            expect(
              await change(id, {
                state: target,
                expected_generation: expectedGeneration,
              }),
            ).toEqual(mismatch);
            expect(await inspect(id)).toEqual(stored);
            expect(await auditSnapshot(id)).toBeNull();
          }
        }
        if (state === 'withdrawn') {
          expect(await json(`/fixture/acquire/${id}`)).toEqual(
            deniedPublication,
          );
          expect(
            await submit(
              id,
              initialized.generation,
              syntheticSnapshot(1_700_000_100),
            ),
          ).toEqual(deniedPublication);
        } else {
          expect(await acquire(id, 1_900_000_000_999)).toEqual({
            steam_app_id: id,
            generation: initialized.generation,
            minimum_observed_at: 1_700_000_020,
          });
        }
        expect(await inspect(id)).toEqual(stored);
      }

      const populatedId = 7003;
      const oldPermit = await acquire(populatedId);
      expect(
        await submit(populatedId, oldPermit.generation, syntheticSnapshot()),
      ).toEqual(applied(populatedId, 1_700_000_010));
      const populatedRow = { ...initialSnapshotRow, steamAppId: populatedId };
      const populatedControl = await inspect(populatedId);
      expect(await auditSnapshot(populatedId)).toEqual(populatedRow);
      expect(
        await changed(
          populatedId,
          'eligible',
          oldPermit.generation,
          1_900_000_000_999,
        ),
      ).toEqual({
        ...populatedControl,
        outcome: 'unchanged',
      });
      for (const target of ['eligible', 'withdrawn']) {
        for (const expectedGeneration of [null, 'synthetic-stale']) {
          expect(
            await change(populatedId, {
              state: target,
              expected_generation: expectedGeneration,
            }),
          ).toEqual(mismatch);
          expect(await inspect(populatedId)).toEqual(populatedControl);
          expect(await auditSnapshot(populatedId)).toEqual(populatedRow);
        }
      }
      // Strict service payloads also fail before changing accepted control or
      // any accepted event/provenance. No unsafe arbitrary reason is retained.
      for (const invalid of [
        null,
        [],
        'withdrawn',
        {},
        { state: 'withdrawn' },
        { expected_generation: oldPermit.generation },
        { state: 'uninitialized', expected_generation: oldPermit.generation },
        { state: 'withdrawn', expected_generation: 1 },
        { state: 'withdrawn', expected_generation: '' },
        { state: 'withdrawn', expected_generation: ' synthetic ' },
        {
          state: 'withdrawn',
          expected_generation: oldPermit.generation,
          reason: 'Synthetic private reason',
        },
      ]) {
        expect(await change(populatedId, invalid)).toEqual({
          error: { code: 'VALIDATION_FAILED' },
        });
        expect(await inspect(populatedId)).toEqual(populatedControl);
        expect(await auditSnapshot(populatedId)).toEqual(populatedRow);
      }
      // Deliberately inconsistent fixed seed: a same-state withdrawn command is
      // mutation-free too, not an unconditional purge disguised as a no-op.
      const orphanedRow = await auditSnapshot(6002);
      const orphanedControl = await inspect(6002);
      expect(
        await changed(6002, 'withdrawn', orphanedControl.generation),
      ).toEqual({
        ...orphanedControl,
        outcome: 'unchanged',
      });
      expect(
        await change(6002, { state: 'withdrawn', expected_generation: null }),
      ).toEqual(mismatch);
      expect(await inspect(6002)).toEqual(orphanedControl);
      expect(await auditSnapshot(6002)).toEqual(orphanedRow);

      const removed = await changed(
        populatedId,
        'withdrawn',
        oldPermit.generation,
      );
      expect(removed).toEqual({
        steam_app_id: populatedId,
        state: 'withdrawn',
        generation: expect.any(String),
        generation_issued_at: 1_700_000_020,
        outcome: 'applied',
      });
      expect(removed.generation).not.toBe(oldPermit.generation);
      expect(await auditSnapshot(populatedId)).toBeNull();
      expect(
        await changed(
          populatedId,
          'withdrawn',
          removed.generation,
          1_900_000_000_999,
        ),
      ).toEqual({ ...removed, outcome: 'unchanged' });
      expect(await json(`/fixture/acquire/${populatedId}`)).toEqual(
        deniedPublication,
      );
      expect(
        await submit(
          populatedId,
          oldPermit.generation,
          syntheticSnapshot(1_700_000_100),
        ),
      ).toEqual(deniedPublication);
      expect(
        await change(populatedId, {
          state: 'eligible',
          expected_generation: oldPermit.generation,
        }),
      ).toEqual(mismatch);
      const reinstated = await changed(
        populatedId,
        'eligible',
        removed.generation,
        1_700_000_030_999,
      );
      expect(reinstated).toEqual({
        steam_app_id: populatedId,
        state: 'eligible',
        generation: expect.any(String),
        generation_issued_at: 1_700_000_030,
        outcome: 'applied',
      });
      expect(
        new Set([
          oldPermit.generation,
          removed.generation,
          reinstated.generation,
        ]).size,
      ).toBe(3);
      expect(await auditSnapshot(populatedId)).toBeNull();
      expect(await acquire(populatedId, 1_900_000_000_999)).toEqual({
        steam_app_id: populatedId,
        generation: reinstated.generation,
        minimum_observed_at: 1_700_000_030,
      });
      for (const generation of [oldPermit.generation, removed.generation]) {
        expect(
          await submit(
            populatedId,
            generation,
            syntheticSnapshot(1_700_000_100),
          ),
        ).toEqual(mismatch);
        expect(await auditSnapshot(populatedId)).toBeNull();
      }
      expect(
        await submit(
          populatedId,
          reinstated.generation,
          syntheticSnapshot(1_700_000_029),
        ),
      ).toEqual({ error: { code: 'VALIDATION_FAILED' } });
      expect(await auditSnapshot(populatedId)).toBeNull();
      const { outcome: _reinstatedOutcome, ...reinstatedControl } = reinstated;
      expect(await inspect(populatedId)).toEqual(reinstatedControl);
      expect(
        await submit(
          populatedId,
          reinstated.generation,
          syntheticSnapshot(
            1_700_000_030,
            'synthetic-fresh-after-reinstatement',
          ),
        ),
      ).toEqual(applied(populatedId, 1_700_000_030));
      const freshRow = {
        ...populatedRow,
        eventId: 'synthetic-fresh-after-reinstatement',
        observedAt: 1_700_000_030,
      };
      expect(await auditSnapshot(populatedId)).toEqual(freshRow);
      expect(
        await submit(
          populatedId,
          reinstated.generation,
          syntheticSnapshot(1_700_000_029),
        ),
      ).toEqual({
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await auditSnapshot(populatedId)).toEqual(freshRow);
      expect(await inspect(populatedId)).toEqual(reinstatedControl);
      // Queued old generation remains denied even after new metadata exists.
      expect(
        await submit(
          populatedId,
          oldPermit.generation,
          syntheticSnapshot(1_700_000_100),
        ),
      ).toEqual(mismatch);
      expect(
        await change(populatedId, {
          state: 'withdrawn',
          expected_generation: removed.generation,
        }),
      ).toEqual(mismatch);
      expect(await auditSnapshot(populatedId)).toEqual(freshRow);
      expect(await inspect(populatedId)).toEqual(reinstatedControl);

      // Late REAL SQL fault: existing control advancement AND snapshot deletion
      // must roll back; absent initialization must not leave a control either.
      const rollbackAdminPermit = await acquire(7004);
      expect(
        await submit(7004, rollbackAdminPermit.generation, syntheticSnapshot()),
      ).toEqual(applied(7004, 1_700_000_010));
      const rollbackAdminControl = await inspect(7004);
      const rollbackAdminRow = { ...initialSnapshotRow, steamAppId: 7004 };
      expect(
        await change(
          7004,
          {
            state: 'withdrawn',
            expected_generation: rollbackAdminPermit.generation,
          },
          1_700_000_020_999,
          'change-fail',
        ),
      ).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR' } });
      expect(await inspect(7004)).toEqual(rollbackAdminControl);
      expect(await auditSnapshot(7004)).toEqual(rollbackAdminRow);
      for (const state of ['eligible', 'withdrawn']) {
        expect(
          await change(
            7005,
            { state, expected_generation: null },
            1_700_000_020_999,
            'change-fail',
          ),
        ).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR' } });
        expect((await inspect(7005)).state).toBe('uninitialized');
        expect(await auditSnapshot(7005)).toBeNull();
      }

      // Both invocations arrive at D1 before either executes; the fixture releases
      // commit order explicitly and delays results until both commits complete.
      for (const withdrawalFirst of [false, true]) {
        for (const other of ['acquire', 'submit', 'change'] as const) {
          const id =
            7100 +
            (withdrawalFirst ? 10 : 0) +
            ['acquire', 'submit', 'change'].indexOf(other);
          const permit = await acquire(id);
          const snapshot = syntheticSnapshot(
            1_700_000_010,
            'synthetic-raced-submission',
          );
          const competition = await publicationRaceRequest(id, {
            other,
            withdrawal_first: withdrawalFirst,
            expected_generation: permit.generation,
            snapshot,
            other_change: {
              state: 'withdrawn',
              expected_generation: permit.generation,
            },
          });
          expect(competition.arrivals).toBe(2);
          const winner = Schema.decodeUnknownSync(
            publicationOutcome,
            strict,
          )(
            other === 'change' && !withdrawalFirst
              ? competition.other
              : competition.withdrawal,
          );
          expect(winner).toEqual({
            steam_app_id: id,
            state: 'withdrawn',
            generation: expect.any(String),
            generation_issued_at:
              other === 'change' && !withdrawalFirst
                ? 1_700_000_010
                : 1_700_000_020,
            outcome: 'applied',
          });
          expect(winner.generation).not.toBe(permit.generation);
          if (other === 'change') {
            expect(
              withdrawalFirst ? competition.other : competition.withdrawal,
            ).toEqual(mismatch);
          } else {
            expect(competition.other).toEqual(
              withdrawalFirst
                ? deniedPublication
                : other === 'acquire'
                  ? permit
                  : applied(id, 1_700_000_010),
            );
          }
          const { outcome: _winnerOutcome, ...winningControl } = winner;
          expect(await inspect(id)).toEqual(winningControl);
          expect(await auditSnapshot(id)).toBeNull();
          expect(await json(`/fixture/acquire/${id}`)).toEqual(
            deniedPublication,
          );
          expect(
            await submit(
              id,
              permit.generation,
              syntheticSnapshot(1_700_000_100),
            ),
          ).toEqual(deniedPublication);
          // A stale competing command cannot reinstate the winner's withdrawal.
          expect(
            await change(id, {
              state: 'eligible',
              expected_generation: permit.generation,
            }),
          ).toEqual(mismatch);
          expect(await inspect(id)).toEqual(winningControl);
        }
        // Same-state admin racing withdrawal: unchanged must capture the earlier
        // eligible generation even when its response arrives after withdrawal.
        const id = withdrawalFirst ? 7113 : 7103;
        const permit = await acquire(id);
        expect(
          await submit(id, permit.generation, syntheticSnapshot()),
        ).toEqual(applied(id, 1_700_000_010));
        const competition = await publicationRaceRequest(id, {
          other: 'change',
          withdrawal_first: withdrawalFirst,
          expected_generation: permit.generation,
          other_change: {
            state: 'eligible',
            expected_generation: permit.generation,
          },
        });
        expect(competition.arrivals).toBe(2);
        expect(competition.other).toEqual(
          withdrawalFirst
            ? mismatch
            : {
                steam_app_id: id,
                state: 'eligible',
                generation: permit.generation,
                generation_issued_at: 1_700_000_000,
                outcome: 'unchanged',
              },
        );
        const winner = Schema.decodeUnknownSync(
          publicationOutcome,
          strict,
        )(competition.withdrawal);
        expect(winner).toEqual({
          steam_app_id: id,
          state: 'withdrawn',
          generation: expect.any(String),
          generation_issued_at: 1_700_000_020,
          outcome: 'applied',
        });
        expect(await auditSnapshot(id)).toBeNull();
        expect(await inspect(id)).toEqual({
          steam_app_id: id,
          state: 'withdrawn',
          generation: winner.generation,
          generation_issued_at: 1_700_000_020,
        });
      }

      // Cold acquisition versus null-expectation withdrawal has a different
      // legitimate outcome: an acquire that commits first invalidates null.
      for (const withdrawalFirst of [false, true]) {
        const id = withdrawalFirst ? 7121 : 7120;
        const competition = await publicationRaceRequest(id, {
          other: 'acquire',
          withdrawal_first: withdrawalFirst,
          expected_generation: null,
        });
        expect(competition.arrivals).toBe(2);
        if (withdrawalFirst) {
          const winner = Schema.decodeUnknownSync(
            publicationOutcome,
            strict,
          )(competition.withdrawal);
          expect(winner).toEqual({
            steam_app_id: id,
            state: 'withdrawn',
            generation: expect.any(String),
            generation_issued_at: 1_700_000_020,
            outcome: 'applied',
          });
          expect(competition.other).toEqual(deniedPublication);
          expect(await inspect(id)).toEqual({
            steam_app_id: id,
            state: 'withdrawn',
            generation: winner.generation,
            generation_issued_at: 1_700_000_020,
          });
        } else {
          const winner = Schema.decodeUnknownSync(
            authorization,
            strict,
          )(competition.other);
          expect(winner).toEqual({
            steam_app_id: id,
            generation: expect.any(String),
            minimum_observed_at: 1_700_000_010,
          });
          expect(competition.withdrawal).toEqual(mismatch);
          expect(await inspect(id)).toEqual({
            steam_app_id: id,
            state: 'eligible',
            generation: winner.generation,
            generation_issued_at: 1_700_000_010,
          });
        }
        expect(await auditSnapshot(id)).toBeNull();
      }

      const prefix = '/internal/v1/steam/applications';
      const http = async (
        path: string,
        token: string,
        method = 'GET',
        snapshot?: unknown,
        generation?: string,
        encodedSnapshot?: string,
        overrides: RequestInit = {},
      ) => {
        const response = await fetch(
          `${url}${path.startsWith('/fixture/') ? '' : prefix}${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Request-ID': 'caller-id',
              ...(snapshot === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
              ...(generation === undefined
                ? {}
                : { 'X-Publication-Generation': generation }),
            },
            ...(snapshot === undefined
              ? {}
              : { body: encodedSnapshot ?? JSON.stringify(snapshot) }),
            signal: AbortSignal.timeout(10_000),
            ...overrides,
          },
        );
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Content-Type')).toContain(
          'application/json',
        );
        const requestId = response.headers.get('X-Request-ID');
        expect(requestId).toBeTruthy();
        expect(requestId).not.toBe('caller-id');
        const text = await response.text();
        for (const secret of secrets) {
          expect(
            text.includes(secret),
            'No credential in catalog HTTP response',
          ).toBe(false);
        }
        for (const marker of [
          'catalog_fixture_missing_table',
          'D1_ERROR',
          'no such table',
          'SqlError',
          'EffectDrizzleQueryError',
          'Synthetic private reason',
          'insert into steam_application_publication',
          'delete from steam_application_snapshot',
        ]) {
          expect(
            text.includes(marker),
            'No SQL, causes, or submitted reasons in HTTP responses',
          ).toBe(false);
        }
        const body: unknown = JSON.parse(text);
        return { status: response.status, requestId, body };
      };
      const before = Math.floor(Date.now() / 1000);
      const post = await http(
        '/5001/ingestion-authorization',
        ingestion,
        'POST',
      );
      const after = Math.floor(Date.now() / 1000);
      expect(post.status).toBe(200);
      const posted = Schema.decodeUnknownSync(
        Schema.Struct({ data: authorization }),
        strict,
      )(post.body).data;
      expect(posted.steam_app_id).toBe(5001);
      expect(posted.minimum_observed_at).toBeGreaterThanOrEqual(before);
      expect(posted.minimum_observed_at).toBeLessThanOrEqual(after);
      expect(Number.isInteger(posted.minimum_observed_at)).toBe(true);
      const get = await http('/5001/publication', admin);
      expect(get.status).toBe(200);
      expect(get.body).toEqual({
        data: {
          steam_app_id: 5001,
          state: 'eligible',
          generation: posted.generation,
          generation_issued_at: posted.minimum_observed_at,
        },
      });
      expect(get.requestId).not.toBe(post.requestId);
      // Representative real Hono/auth -> Effect -> native D1 PUTs. Policy is
      // supplied by the isolated Worker environment, not by a Node service stub.
      const httpSnapshot = syntheticSnapshot(
        posted.minimum_observed_at,
        'synthetic-http-first',
      );
      const put = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        httpSnapshot,
        posted.generation,
      );
      expect(put.status).toBe(200);
      expect(put.body).toEqual({
        data: applied(5001, posted.minimum_observed_at),
      });
      const httpInitialRow = {
        ...initialSnapshotRow,
        steamAppId: 5001,
        eventId: 'synthetic-http-first',
        observedAt: posted.minimum_observed_at,
      };
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      const httpPublicApplication = {
        steam_app_id: 5001,
        metadata: {
          title: 'Synthetic Café Demo',
          product_type: 'demo',
          base_app_id: 9001,
          developers: ['Synthetic Developer A', 'Synthetic Developer B'],
          publishers: ['Synthetic Publisher A', 'Synthetic Publisher B'],
          supported_os: ['linux', 'macos', 'windows'],
          release: {
            status: 'upcoming',
            date: { kind: 'exact', date: '2030-04-12' },
          },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001',
          language: 'en',
          observed_at: posted.minimum_observed_at,
        },
      };
      const lookedUp = await lookupHttp(5001);
      expect(lookedUp.status).toBe(200);
      expect(lookedUp.body).toEqual({ data: httpPublicApplication });
      expect(lookedUp.requestId).not.toBe(put.requestId);
      expect(await lookup(5001)).toEqual(httpPublicApplication);
      const noOp = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        { ...httpSnapshot, event_id: 'synthetic-http-redelivery' },
        posted.generation,
      );
      expect(noOp.status).toBe(200);
      expect(noOp.body).toEqual({
        data: {
          steam_app_id: 5001,
          outcome: 'unchanged',
          current_observed_at: posted.minimum_observed_at,
        },
      });
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      // Real Hono PUT also compares decoded content, not JSON key/escape or
      // supported-OS ordering. The first accepted event remains unchanged.
      const httpRepresentation = JSON.stringify({
        provenance: Object.fromEntries(
          Object.entries(httpSnapshot.provenance).reverse(),
        ),
        metadata: Object.fromEntries(
          Object.entries({
            ...httpSnapshot.metadata,
            supported_os: ['linux', 'windows', 'macos'],
          }).reverse(),
        ),
        event_id: 'synthetic-http-representation',
      }).replace('Café', 'Caf\\u00e9');
      const equivalentPut = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        httpSnapshot,
        posted.generation,
        httpRepresentation,
      );
      expect(equivalentPut.status).toBe(200);
      expect(equivalentPut.body).toEqual({
        data: {
          steam_app_id: 5001,
          outcome: 'unchanged',
          current_observed_at: posted.minimum_observed_at,
        },
      });
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      const conflict = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        {
          ...httpSnapshot,
          metadata: {
            ...httpSnapshot.metadata,
            title: 'Synthetic HTTP Conflict',
          },
        },
        posted.generation,
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({
        error: { code: 'SNAPSHOT_CONFLICT', request_id: conflict.requestId },
      });
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      const missingGeneration = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        httpSnapshot,
      );
      expect(missingGeneration.status).toBe(422);
      const safeValidation = Schema.decodeUnknownSync(
        Schema.Struct({
          error: Schema.Struct({
            code: Schema.Literal('VALIDATION_FAILED'),
            request_id: Schema.String,
            issues: Schema.optionalKey(
              Schema.Array(
                Schema.Struct({ path: Schema.String, code: Schema.String }),
              ),
            ),
          }),
        }),
        strict,
      )(missingGeneration.body);
      expect(safeValidation.error.request_id).toBe(missingGeneration.requestId);
      expect(safeValidation.error.issues?.length ?? 0).toBeLessThanOrEqual(20);
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      const wrongRole = await http(
        '/5001/snapshot',
        admin,
        'PUT',
        httpSnapshot,
        posted.generation,
      );
      expect(wrongRole.status).toBe(403);
      expect(wrongRole.body).toEqual({
        error: { code: 'FORBIDDEN', request_id: wrongRole.requestId },
      });
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      const unapproved = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        {
          ...httpSnapshot,
          provenance: {
            ...httpSnapshot.provenance,
            source_url: 'https://unapproved.example.invalid/apps/1001',
          },
        },
        posted.generation,
      );
      expect(unapproved.status).toBe(403);
      expect(unapproved.body).toEqual({
        error: {
          code: 'SOURCE_NOT_APPROVED',
          request_id: unapproved.requestId,
        },
      });
      expect(await auditSnapshot(5001)).toEqual(httpInitialRow);
      const httpNewer = {
        ...httpSnapshot,
        event_id: 'synthetic-http-newer',
        provenance: {
          ...httpSnapshot.provenance,
          observed_at: posted.minimum_observed_at + 1,
        },
      };
      const replacement = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        httpNewer,
        posted.generation,
      );
      expect(replacement.status).toBe(200);
      expect(replacement.body).toEqual({
        data: applied(5001, posted.minimum_observed_at + 1),
      });
      const httpNewerRow = {
        ...httpInitialRow,
        eventId: 'synthetic-http-newer',
        observedAt: posted.minimum_observed_at + 1,
      };
      expect(await auditSnapshot(5001)).toEqual(httpNewerRow);
      const stale = await http(
        '/5001/snapshot',
        ingestion,
        'PUT',
        httpSnapshot,
        posted.generation,
      );
      expect(stale.status).toBe(200);
      expect(stale.body).toEqual({
        data: {
          steam_app_id: 5001,
          outcome: 'ignored_stale',
          current_observed_at: posted.minimum_observed_at + 1,
        },
      });
      expect(await auditSnapshot(5001)).toEqual(httpNewerRow);
      const lastKnownHttpApplication = {
        steam_app_id: 5001,
        metadata: {
          title: 'Synthetic Café Demo',
          product_type: 'demo',
          base_app_id: 9001,
          developers: ['Synthetic Developer A', 'Synthetic Developer B'],
          publishers: ['Synthetic Publisher A', 'Synthetic Publisher B'],
          supported_os: ['linux', 'macos', 'windows'],
          release: {
            status: 'upcoming',
            date: { kind: 'exact', date: '2030-04-12' },
          },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001',
          language: 'en',
          observed_at: posted.minimum_observed_at + 1,
        },
      };
      const afterStale = await lookupHttp(5001);
      expect(afterStale.status).toBe(200);
      expect(afterStale.body).toEqual({ data: lastKnownHttpApplication });
      await countedLookup(5001, lastKnownHttpApplication);

      // These public expectations are independent full literals, not input
      // projections, storage rows, production schemas, or serialization helpers.
      // A small future allowance keeps the fixed observations above the acquired
      // floor; it does not claim a real source observation or freshness promise.
      const publicObservedAt = Math.floor(Date.now() / 1000) + 60;
      const publicCases = [
        {
          id: 5101,
          snapshot: {
            event_id: 'synthetic-public-game',
            metadata: {
              title: 'Synthetic Announced Game',
              product_type: 'game',
              base_app_id: null,
              developers: ['Synthetic Developer Z', 'Synthetic Developer A'],
              publishers: [],
              supported_os: null,
              release: {
                status: 'upcoming',
                date: { kind: 'exact', date: '2000-02-29' },
              },
            },
            provenance: {
              source_url: 'https://catalog.example.invalid/apps/1001',
              language: 'en',
              observed_at: publicObservedAt,
              extractor_version: 'synthetic-v1',
            },
          },
          expected: {
            steam_app_id: 5101,
            metadata: {
              title: 'Synthetic Announced Game',
              product_type: 'game',
              base_app_id: null,
              developers: ['Synthetic Developer Z', 'Synthetic Developer A'],
              publishers: [],
              supported_os: null,
              release: {
                status: 'upcoming',
                date: { kind: 'exact', date: '2000-02-29' },
              },
            },
            provenance: {
              source_url: 'https://catalog.example.invalid/apps/1001',
              language: 'en',
              observed_at: publicObservedAt,
            },
          },
        },
        {
          id: 5102,
          snapshot: {
            event_id: 'synthetic-public-demo',
            metadata: {
              title: 'Synthetic Unlinked Demo',
              product_type: 'demo',
              base_app_id: null,
              developers: [],
              publishers: null,
              supported_os: [],
              release: { status: 'unknown', date: { kind: 'unknown' } },
            },
            provenance: {
              source_url: 'https://catalog.example.invalid/apps/1001',
              language: 'en',
              observed_at: publicObservedAt,
              extractor_version: 'synthetic-v1',
            },
          },
          expected: {
            steam_app_id: 5102,
            metadata: {
              title: 'Synthetic Unlinked Demo',
              product_type: 'demo',
              base_app_id: null,
              developers: [],
              publishers: null,
              supported_os: [],
              release: { status: 'unknown', date: { kind: 'unknown' } },
            },
            provenance: {
              source_url: 'https://catalog.example.invalid/apps/1001',
              language: 'en',
              observed_at: publicObservedAt,
            },
          },
        },
        {
          id: 5103,
          snapshot: {
            event_id: 'synthetic-public-dlc',
            metadata: {
              title: 'Synthetic Released DLC',
              product_type: 'dlc',
              base_app_id: 9101,
              developers: null,
              publishers: ['Synthetic Publisher Z', 'Synthetic Publisher A'],
              supported_os: ['windows', 'linux', 'macos'],
              release: {
                status: 'released',
                date: { kind: 'window', window: 'Q4 2099' },
              },
            },
            provenance: {
              source_url: 'https://catalog.example.invalid/apps/1001',
              language: 'en',
              observed_at: publicObservedAt,
              extractor_version: 'synthetic-v1',
            },
          },
          expected: {
            steam_app_id: 5103,
            metadata: {
              title: 'Synthetic Released DLC',
              product_type: 'dlc',
              base_app_id: 9101,
              developers: null,
              publishers: ['Synthetic Publisher Z', 'Synthetic Publisher A'],
              supported_os: ['linux', 'macos', 'windows'],
              release: {
                status: 'released',
                date: { kind: 'window', window: 'Q4 2099' },
              },
            },
            provenance: {
              source_url: 'https://catalog.example.invalid/apps/1001',
              language: 'en',
              observed_at: publicObservedAt,
            },
          },
        },
      ];
      for (const { id, snapshot, expected } of publicCases) {
        const acquired = await http(
          `/${id}/ingestion-authorization`,
          ingestion,
          'POST',
        );
        expect(acquired.status).toBe(200);
        const permit = Schema.decodeUnknownSync(
          Schema.Struct({ data: authorization }),
          strict,
        )(acquired.body).data;
        expect(permit.steam_app_id).toBe(id);
        const unpublished = await lookupHttp(id);
        expect(unpublished.status).toBe(404);
        expect(unpublished.body).toEqual({
          error: { code: 'NOT_FOUND', request_id: unpublished.requestId },
        });
        const submitted = await http(
          `/${id}/snapshot`,
          ingestion,
          'PUT',
          snapshot,
          permit.generation,
        );
        expect(submitted.status).toBe(200);
        expect(submitted.body).toEqual({ data: applied(id, publicObservedAt) });
        const published = await lookupHttp(id);
        expect(published.status).toBe(200);
        // Exact equality also excludes every internal field, TTL, availability,
        // stale/current flag, and any other response-only enrichment.
        expect(published.body).toEqual({ data: expected });
        expect(await lookup(id)).toEqual(expected);
        await countedLookup(id, expected);
        expect(
          new Set([
            acquired.requestId,
            submitted.requestId,
            published.requestId,
          ]).size,
        ).toBe(3);
      }
      // No base lookup is required to serve a verified relationship; no target
      // control/snapshot is implicitly created. Status is never derived from a
      // passed exact date or a future release window.
      for (const id of [9001, 9101]) {
        const uncatalogedBase = await lookupHttp(id);
        expect(uncatalogedBase.status).toBe(404);
        expect(uncatalogedBase.body).toEqual({
          error: { code: 'NOT_FOUND', request_id: uncatalogedBase.requestId },
        });
        expect((await inspect(id)).state).toBe('uninitialized');
      }
      for (const id of [
        '0',
        '4294967296',
        '01',
        '-1',
        '+1',
        '1.0',
        '1e3',
        '0x10',
        'NaN',
        '%201',
        '1%20',
      ]) {
        const malformed = await lookupHttp(id);
        expect(malformed.status).toBe(400);
        expect(malformed.body).toEqual({
          error: { code: 'INVALID_APP_ID', request_id: malformed.requestId },
        });
      }
      // Valid range endpoints have eligible control but no snapshot, not a
      // parsing error. They remain anonymous and indistinguishably not found.
      for (const id of [1, 4294967295]) {
        const boundary = await lookupHttp(id);
        expect(boundary.status).toBe(404);
        expect(boundary.body).toEqual({
          error: { code: 'NOT_FOUND', request_id: boundary.requestId },
        });
      }
      expect(await json('/fixture/lookup-fail/5001')).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });
      const failedLookup = await publicHttp('/fixture/http-lookup-failure');
      expect(failedLookup.status).toBe(500);
      expect(failedLookup.body).toEqual({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          request_id: failedLookup.requestId,
        },
      });
      const afterLookupFailure = await lookupHttp(5001);
      expect(afterLookupFailure.status).toBe(200);
      expect(afterLookupFailure.body).toEqual({
        data: lastKnownHttpApplication,
      });

      const denial = await http(
        '/2002/ingestion-authorization',
        ingestion,
        'POST',
      );
      expect(denial.status).toBe(409);
      expect(denial.body).toEqual({
        error: {
          code: 'PUBLICATION_WITHDRAWN',
          request_id: denial.requestId,
        },
      });
      expect(await inspect(2002)).toEqual(withdrawn);
      const failure = await http('/fixture/http-failure', ingestion, 'POST');
      expect(failure.status).toBe(500);
      expect(failure.body).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR', request_id: failure.requestId },
      });
      expect(await inspect(5002)).toEqual({
        steam_app_id: 5002,
        state: 'uninitialized',
        generation: null,
        generation_issued_at: null,
      });

      // Production admin PUT -> Hono authentication/transport -> Effect -> D1.
      // These tests are independent of whether public lookup is delivered.
      const publicationHttp = async (id: number | string, input: unknown) =>
        http(`/${id}/publication`, admin, 'PUT', input);
      const safeHttpFailure = (
        result: Awaited<ReturnType<typeof http>>,
        status: number,
        code: string,
      ) => {
        expect(result.status).toBe(status);
        if (code === 'VALIDATION_FAILED') {
          const failure = Schema.decodeUnknownSync(
            Schema.Struct({
              error: Schema.Struct({
                code: Schema.Literal('VALIDATION_FAILED'),
                request_id: Schema.String,
                issues: Schema.optionalKey(
                  Schema.Array(
                    Schema.Struct({ path: Schema.String, code: Schema.String }),
                  ),
                ),
              }),
            }),
            strict,
          )(result.body);
          expect(failure.error.request_id).toBe(result.requestId);
          expect(failure.error.issues?.length ?? 0).toBeLessThanOrEqual(20);
          for (const issue of failure.error.issues ?? []) {
            expect(issue.path).toMatch(/^[a-z_.]*$/);
            expect(issue.code).toMatch(/^[A-Z_]+$/);
          }
        } else {
          expect(result.body).toEqual({
            error: { code, request_id: result.requestId },
          });
        }
      };
      const httpChanged = (result: Awaited<ReturnType<typeof http>>) => {
        expect(result.status).toBe(200);
        return Schema.decodeUnknownSync(
          Schema.Struct({ data: publicationOutcome }),
          strict,
        )(result.body).data;
      };
      const coldAdmin = await http('/7201/publication', admin);
      expect(coldAdmin.status).toBe(200);
      expect(coldAdmin.body).toEqual({
        data: {
          steam_app_id: 7201,
          state: 'uninitialized',
          generation: null,
          generation_issued_at: null,
        },
      });
      const issuedBefore = Math.floor(Date.now() / 1000);
      const initializedHttp = httpChanged(
        await publicationHttp(7201, {
          state: 'eligible',
          expected_generation: null,
        }),
      );
      expect(initializedHttp).toEqual({
        steam_app_id: 7201,
        state: 'eligible',
        generation: expect.any(String),
        generation_issued_at: expect.any(Number),
        outcome: 'applied',
      });
      expect(initializedHttp.generation.length).toBeGreaterThan(0);
      expect(Number.isInteger(initializedHttp.generation_issued_at)).toBe(true);
      expect(initializedHttp.generation_issued_at).toBeGreaterThanOrEqual(
        issuedBefore,
      );
      expect(initializedHttp.generation_issued_at).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000),
      );
      expect(await auditSnapshot(7201)).toBeNull();
      const adminHttpSnapshot = syntheticSnapshot(
        initializedHttp.generation_issued_at,
        'synthetic-admin-http-accepted',
      );
      const acceptedHttp = await http(
        '/7201/snapshot',
        ingestion,
        'PUT',
        adminHttpSnapshot,
        initializedHttp.generation,
      );
      expect(acceptedHttp.status).toBe(200);
      expect(acceptedHttp.body).toEqual({
        data: applied(7201, initializedHttp.generation_issued_at),
      });
      const adminHttpRow = {
        ...initialSnapshotRow,
        steamAppId: 7201,
        eventId: 'synthetic-admin-http-accepted',
        observedAt: initializedHttp.generation_issued_at,
      };
      expect(await auditSnapshot(7201)).toEqual(adminHttpRow);
      const { outcome: _httpOutcome, ...adminHttpControl } = initializedHttp;
      expect(
        httpChanged(
          await publicationHttp(7201, {
            state: 'eligible',
            expected_generation: initializedHttp.generation,
          }),
        ),
      ).toEqual({ ...initializedHttp, outcome: 'unchanged' });
      for (const state of ['eligible', 'withdrawn']) {
        for (const expectedGeneration of [null, 'synthetic-stale-admin-http']) {
          safeHttpFailure(
            await publicationHttp(7201, {
              state,
              expected_generation: expectedGeneration,
            }),
            409,
            'PUBLICATION_GENERATION_MISMATCH',
          );
          expect(await inspect(7201)).toEqual(adminHttpControl);
          expect(await auditSnapshot(7201)).toEqual(adminHttpRow);
        }
      }
      for (const input of [
        null,
        [],
        1,
        'withdrawn',
        {},
        { state: 'withdrawn' },
        { expected_generation: initializedHttp.generation },
        {
          state: 'uninitialized',
          expected_generation: initializedHttp.generation,
        },
        { state: 'Withdrawn', expected_generation: initializedHttp.generation },
        { state: 'withdrawn', expected_generation: false },
        { state: 'withdrawn', expected_generation: '' },
        { state: 'withdrawn', expected_generation: ' synthetic ' },
        {
          state: 'withdrawn',
          expected_generation: initializedHttp.generation,
          reason: 'Synthetic private reason',
        },
        {
          state: 'withdrawn',
          expected_generation: initializedHttp.generation,
          steam_app_id: 7201,
        },
      ]) {
        safeHttpFailure(
          await publicationHttp(7201, input),
          422,
          'VALIDATION_FAILED',
        );
        expect(await inspect(7201)).toEqual(adminHttpControl);
        expect(await auditSnapshot(7201)).toEqual(adminHttpRow);
      }
      // A malformed JSON body makes auth-before-parsing externally observable.
      for (const [token, status, code] of [
        ['', 401, 'UNAUTHORIZED'],
        ['synthetic-invalid-credential', 401, 'UNAUTHORIZED'],
        [ingestion, 403, 'FORBIDDEN'],
      ] as const) {
        safeHttpFailure(
          await http('/7201/publication', token, 'PUT', {}, undefined, '{'),
          status,
          code,
        );
      }
      for (const [path, status, code] of [
        ['/fixture/http-change-no-config', 503, 'SERVICE_UNAVAILABLE'],
        ['/fixture/http-change-secure', 403, 'FORBIDDEN'],
      ] as const) {
        safeHttpFailure(
          await http(path, admin, 'PUT', {}, undefined, '{'),
          status,
          code,
        );
        expect((await inspect(7204)).state).toBe('uninitialized');
      }
      safeHttpFailure(
        await http('/7201/publication', admin, 'PUT', {}, undefined, '{'),
        400,
        'INVALID_JSON',
      );
      for (const headers of [
        { 'Content-Type': 'text/plain' },
        { 'Content-Type': 'application/json; charset=iso-8859-1' },
        { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      ]) {
        const requestHeaders = new Headers({
          Authorization: `Bearer ${admin}`,
        });
        for (const [key, value] of Object.entries(headers)) {
          if (value !== undefined) requestHeaders.set(key, value);
        }
        safeHttpFailure(
          await http(
            '/7201/publication',
            admin,
            'PUT',
            {},
            undefined,
            undefined,
            {
              headers: requestHeaders,
            },
          ),
          415,
          'UNSUPPORTED_MEDIA_TYPE',
        );
      }
      // Actual streamed HTTP bytes without Content-Length: the real Worker
      // reader must stop at 32 KiB, rather than trust a declared body size.
      const streamed = {
        headers: {
          Authorization: `Bearer ${admin}`,
          'Content-Type': 'application/json',
          'X-Request-ID': 'caller-id',
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(' '.repeat(32 * 1024)));
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
        }),
        duplex: 'half',
      };
      safeHttpFailure(
        await http(
          '/7201/publication',
          admin,
          'PUT',
          {},
          undefined,
          undefined,
          streamed,
        ),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      for (const id of [
        '0',
        '4294967296',
        '01',
        '-1',
        '+1',
        '1.0',
        '1e3',
        '0x10',
        'NaN',
        '%201',
        '1%20',
      ]) {
        safeHttpFailure(
          await publicationHttp(id, {
            state: 'withdrawn',
            expected_generation: null,
          }),
          400,
          'INVALID_APP_ID',
        );
      }
      expect(await inspect(7201)).toEqual(adminHttpControl);
      expect(await auditSnapshot(7201)).toEqual(adminHttpRow);

      // Simulate a lost success: deliberately discard the committed PUT result.
      // Reconcile via admin GET, not by blindly replacing the old expectation.
      const uncertainAdminCommand = {
        state: 'withdrawn',
        expected_generation: initializedHttp.generation,
      };
      await publicationHttp(7201, uncertainAdminCommand);
      const reconciledHttp = await http('/7201/publication', admin);
      expect(reconciledHttp.status).toBe(200);
      const reconciled = Schema.decodeUnknownSync(
        Schema.Struct({ data: control }),
        strict,
      )(reconciledHttp.body).data;
      expect(reconciled).toEqual({
        steam_app_id: 7201,
        state: 'withdrawn',
        generation: expect.any(String),
        generation_issued_at: expect.any(Number),
      });
      expect(reconciled.generation).not.toBe(initializedHttp.generation);
      expect(Number.isInteger(reconciled.generation_issued_at)).toBe(true);
      expect(await auditSnapshot(7201)).toBeNull();
      safeHttpFailure(
        await publicationHttp(7201, uncertainAdminCommand),
        409,
        'PUBLICATION_GENERATION_MISMATCH',
      );
      expect(
        httpChanged(
          await publicationHttp(7201, {
            state: 'withdrawn',
            expected_generation: reconciled.generation,
          }),
        ),
      ).toEqual({ ...reconciled, outcome: 'unchanged' });
      safeHttpFailure(
        await http('/7201/ingestion-authorization', ingestion, 'POST'),
        409,
        'PUBLICATION_WITHDRAWN',
      );
      safeHttpFailure(
        await http(
          '/7201/snapshot',
          ingestion,
          'PUT',
          adminHttpSnapshot,
          initializedHttp.generation,
        ),
        409,
        'PUBLICATION_WITHDRAWN',
      );
      safeHttpFailure(
        await publicationHttp(7201, {
          state: 'eligible',
          expected_generation: initializedHttp.generation,
        }),
        409,
        'PUBLICATION_GENERATION_MISMATCH',
      );
      expect((await http('/7201/publication', admin)).body).toEqual({
        data: reconciled,
      });
      const httpReinstated = httpChanged(
        await publicationHttp(7201, {
          state: 'eligible',
          expected_generation: reconciled.generation,
        }),
      );
      expect(httpReinstated).toEqual({
        steam_app_id: 7201,
        state: 'eligible',
        generation: expect.any(String),
        generation_issued_at: expect.any(Number),
        outcome: 'applied',
      });
      expect(
        new Set([
          initializedHttp.generation,
          reconciled.generation,
          httpReinstated.generation,
        ]).size,
      ).toBe(3);
      expect(await auditSnapshot(7201)).toBeNull();
      const reacquiredHttp = await http(
        '/7201/ingestion-authorization',
        ingestion,
        'POST',
      );
      expect(reacquiredHttp.status).toBe(200);
      expect(reacquiredHttp.body).toEqual({
        data: {
          steam_app_id: 7201,
          generation: httpReinstated.generation,
          minimum_observed_at: httpReinstated.generation_issued_at,
        },
      });
      safeHttpFailure(
        await http(
          '/7201/snapshot',
          ingestion,
          'PUT',
          syntheticSnapshot(httpReinstated.generation_issued_at + 1),
          initializedHttp.generation,
        ),
        409,
        'PUBLICATION_GENERATION_MISMATCH',
      );
      safeHttpFailure(
        await http(
          '/7201/snapshot',
          ingestion,
          'PUT',
          syntheticSnapshot(httpReinstated.generation_issued_at - 1),
          httpReinstated.generation,
        ),
        422,
        'VALIDATION_FAILED',
      );
      expect(await auditSnapshot(7201)).toBeNull();
      const freshHttp = await http(
        '/7201/snapshot',
        ingestion,
        'PUT',
        syntheticSnapshot(
          httpReinstated.generation_issued_at,
          'synthetic-admin-http-fresh',
        ),
        httpReinstated.generation,
      );
      expect(freshHttp.status).toBe(200);
      expect(freshHttp.body).toEqual({
        data: applied(7201, httpReinstated.generation_issued_at),
      });
      expect(await auditSnapshot(7201)).toEqual({
        ...adminHttpRow,
        eventId: 'synthetic-admin-http-fresh',
        observedAt: httpReinstated.generation_issued_at,
      });
      const absentWithdrawnHttp = httpChanged(
        await publicationHttp(7202, {
          state: 'withdrawn',
          expected_generation: null,
        }),
      );
      expect(absentWithdrawnHttp).toEqual({
        steam_app_id: 7202,
        state: 'withdrawn',
        generation: expect.any(String),
        generation_issued_at: expect.any(Number),
        outcome: 'applied',
      });
      safeHttpFailure(
        await publicationHttp(7202, {
          state: 'withdrawn',
          expected_generation: null,
        }),
        409,
        'PUBLICATION_GENERATION_MISMATCH',
      );
      safeHttpFailure(
        await http('/7202/ingestion-authorization', ingestion, 'POST'),
        409,
        'PUBLICATION_WITHDRAWN',
      );
      expect(await auditSnapshot(7202)).toBeNull();
      const failedChangeHttp = await http(
        '/fixture/http-change-failure',
        admin,
        'PUT',
        {
          state: 'withdrawn',
          expected_generation: rollbackAdminPermit.generation,
        },
      );
      safeHttpFailure(failedChangeHttp, 500, 'INTERNAL_SERVER_ERROR');
      expect(await inspect(7004)).toEqual(rollbackAdminControl);
      expect(await auditSnapshot(7004)).toEqual(rollbackAdminRow);
      const retriedAdmin = await changed(
        7004,
        'withdrawn',
        rollbackAdminPermit.generation,
        1_700_000_040_999,
      );
      expect(retriedAdmin).toEqual({
        steam_app_id: 7004,
        state: 'withdrawn',
        generation: expect.any(String),
        generation_issued_at: 1_700_000_040,
        outcome: 'applied',
      });
      expect(await auditSnapshot(7004)).toBeNull();
      const { outcome: _retriedOutcome, ...retriedControl } = retriedAdmin;
      expect(
        await change(
          7004,
          {
            state: 'eligible',
            expected_generation: retriedAdmin.generation,
          },
          1_700_000_050_999,
          'change-fail',
        ),
      ).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR' } });
      expect(await inspect(7004)).toEqual(retriedControl);
      expect(await auditSnapshot(7004)).toBeNull();

      const lifecycle = await verifyHttpLifecycle({
        url,
        ingestion,
        admin,
        auditSnapshot,
      });

      expect(await json('/fixture/audit')).toEqual({
        tables: [
          { name: '__alchemy_migrations' },
          { name: '_cf_METADATA' }, // workerd's own D1 metadata, not catalog data
          { name: 'steam_application_publication' },
          { name: 'steam_application_snapshot' },
        ],
        columns: [
          { name: 'steam_app_id', type: 'INTEGER' },
          { name: 'state', type: 'TEXT' },
          { name: 'generation', type: 'TEXT' },
          { name: 'generation_issued_at', type: 'INTEGER' },
        ],
        history: [{ count: 3 }],
      });
      return {
        lifecycle,
        lifecycleState: await Promise.all(
          lifecycle.ids.map(async (id) => ({
            id,
            control: await inspect(id),
            snapshot: await auditSnapshot(id),
          })),
        ),
        publicApplications: [
          windowPublicApplication,
          lastKnownHttpApplication,
          ...publicCases.map(({ expected }) => expected),
        ],
        notFoundIds,
        controls: await Promise.all(
          [
            1, 1001, 1002, 1003, 1004, 2001, 2002, 3001, 3002, 3101, 3102, 3201,
            3202, 4001, 4101, 4201, 4202, 4203, 4204, 4205, 4206, 4207, 4208,
            4209, 5001, 5101, 5102, 5103, 6000, 6001, 6002, 6003, 7001, 7002,
            7003, 7004, 7005, 7100, 7101, 7102, 7103, 7110, 7111, 7112, 7113,
            7120, 7121, 7201, 7202, 7204, 4294967295,
          ].map(inspect),
        ),
        snapshots: await Promise.all(
          [
            1001, 1002, 1003, 1004, 2002, 3101, 3102, 3201, 3202, 4101, 4201,
            4202, 4203, 4204, 4205, 4206, 4207, 4208, 4209, 5001, 5101, 5102,
            5103, 6000, 6001, 6002, 6003, 7001, 7002, 7003, 7004, 7005, 7100,
            7101, 7102, 7103, 7110, 7111, 7112, 7113, 7120, 7121, 7201, 7202,
            7204,
          ].map(async (id) => ({ id, snapshot: await auditSnapshot(id) })),
        ),
      };
    });

    // New workerd/Alchemy process, identical local D1 storage. No reseeding.
    await withWorker(async () => {
      const freshRestarted = await lookupHttp(8001);
      expect(freshRestarted.status).toBe(200);
      expect(freshRestarted.body).toEqual(persisted.lifecycle.publicFresh);
      for (const { id, control, snapshot } of persisted.lifecycleState) {
        expect(await inspect(id)).toEqual(control);
        expect(await auditSnapshot(id)).toEqual(snapshot);
      }
      for (const application of persisted.publicApplications) {
        const restarted = await lookupHttp(application.steam_app_id);
        expect(restarted.status).toBe(200);
        expect(restarted.body).toEqual({ data: application });
        await countedLookup(application.steam_app_id, application);
      }
      for (const id of persisted.notFoundIds) {
        const restarted = await lookupHttp(id);
        expect(restarted.status).toBe(404);
        expect(restarted.body).toEqual({
          error: { code: 'NOT_FOUND', request_id: restarted.requestId },
        });
      }
      for (const { id, snapshot } of persisted.snapshots) {
        expect(await auditSnapshot(id)).toEqual(snapshot);
      }
      for (const stored of persisted.controls) {
        expect(await inspect(stored.steam_app_id)).toEqual(stored);
        if (stored.state === 'eligible') {
          expect(await acquire(stored.steam_app_id, 2_000_000_000_999)).toEqual(
            {
              steam_app_id: stored.steam_app_id,
              generation: stored.generation,
              minimum_observed_at: stored.generation_issued_at,
            },
          );
          expect(await inspect(stored.steam_app_id)).toEqual(stored);
        } else if (stored.state === 'withdrawn') {
          expect(await json(`/fixture/acquire/${stored.steam_app_id}`)).toEqual(
            {
              error: { code: 'PUBLICATION_WITHDRAWN' },
            },
          );
          expect(await inspect(stored.steam_app_id)).toEqual(stored);
        }
      }
      expect(await json('/fixture/acquire/2002')).toEqual({
        error: { code: 'PUBLICATION_WITHDRAWN' },
      });
      const audit = await json('/fixture/audit');
      expect(audit).toMatchObject({ history: [{ count: 3 }] });
    });
    await assertNoCredentialFiles();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
