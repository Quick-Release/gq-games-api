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

it('commits durable generations, converges gated contenders, and rolls back failed native D1 batches in workerd', async () => {
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
        error: { code: 'SERVICE_UNAVAILABLE' },
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

      const prefix = '/internal/v1/steam/applications';
      const http = async (path: string, token: string, method = 'GET') => {
        const response = await fetch(
          `${url}${path.startsWith('/fixture/') ? '' : prefix}${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Request-ID': 'caller-id',
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
        expect(response.headers.get('Cache-Control')).toBe('no-store');
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
      expect(failure.status).toBe(503);
      expect(failure.body).toEqual({
        error: { code: 'SERVICE_UNAVAILABLE', request_id: failure.requestId },
      });
      expect(await inspect(5002)).toEqual({
        steam_app_id: 5002,
        state: 'uninitialized',
        generation: null,
        generation_issued_at: null,
      });

      expect(await json('/fixture/audit')).toEqual({
        tables: [
          { name: '__alchemy_migrations' },
          { name: '_cf_METADATA' }, // workerd's own D1 metadata, not catalog data
          { name: 'steam_application_publication' },
        ],
        columns: [
          { name: 'steam_app_id', type: 'INTEGER' },
          { name: 'state', type: 'TEXT' },
          { name: 'generation', type: 'TEXT' },
          { name: 'generation_issued_at', type: 'INTEGER' },
        ],
        history: [{ count: 1 }],
      });
      return Promise.all(
        [1, 1001, 2001, 2002, 3001, 3002, 4001, 5001, 4294967295].map(inspect),
      );
    });

    // New workerd/Alchemy process, identical local D1 storage. No reseeding.
    await withWorker(async () => {
      for (const stored of persisted) {
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
        }
      }
      expect(await json('/fixture/acquire/2002')).toEqual({
        error: { code: 'PUBLICATION_WITHDRAWN' },
      });
      const audit = await json('/fixture/audit');
      expect(audit).toMatchObject({ history: [{ count: 1 }] });
    });
    await assertNoCredentialFiles();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
