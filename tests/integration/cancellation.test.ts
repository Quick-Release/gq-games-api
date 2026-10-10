// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { Schema } from 'effect';
import { expect, it } from 'vite-plus/test';

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
const measurements = Schema.Struct({
  checkpoint: Schema.Number,
  physicalAborts: Schema.Number,
  abortBeforeDispatch: Schema.Number,
  abortAfterDispatch: Schema.Number,
  observedOutcomes: Schema.Number,
  batches: Schema.Number,
  reads: Schema.Number,
  settled: Schema.Number,
  forwarded: Schema.Number,
  succeeded: Schema.Number,
  failed: Schema.Number,
  headers: Schema.Number,
  request_aborted: Schema.Number,
  write_dispatched: Schema.Number,
  write_succeeded: Schema.Number,
  write_failed: Schema.Number,
  effect_exit: Schema.Number,
  body_reader_acquired: Schema.Number,
  body_reader_released: Schema.Number,
  readerLocked: Schema.Boolean,
  readerUnlocked: Schema.Boolean,
  cleanup_complete: Schema.Number,
  interrupted: Schema.Number,
  success: Schema.Number,
  failure: Schema.Number,
  defect: Schema.Number,
  correlated: Schema.Boolean,
});
const availablePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string')
    throw new Error('Expected loopback TCP port');
  return address.port;
};

it('distinguishes physical cancellation, native D1 outcome, and cooperative cleanup in isolated local workerd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gq-cancellation-'));
  const home = join(directory, 'home');
  const config = join(directory, 'config');
  const migrations = join(directory, 'migrations');
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  let physicalPort = port;
  const ingestion = randomUUID() + randomUUID();
  const admin = randomUUID() + randomUUID();
  const secrets = [ingestion, admin];
  const sockets = new Set<ReturnType<typeof createConnection>>();
  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    expect(response.status, 'Local fixture control status').toBe(200);
    for (const secret of secrets)
      expect(text.includes(secret), 'No credential in fixture response').toBe(
        false,
      );
    const value: unknown = JSON.parse(text);
    return value;
  };
  const arm = (key: string, kind: string) =>
    json(`/fixture/gates/${key}/arm?kind=${kind}`, { method: 'POST' });
  const action = (key: string, name: string) =>
    json(`/fixture/gates/${key}/${name}`, { method: 'POST' });
  const state = async (key: string) =>
    Schema.decodeUnknownSync(measurements)(
      await json(`/fixture/gates/${key}/state`),
    );
  const marker = async (
    key: string,
    name: keyof Schema.Schema.Type<typeof measurements>,
  ) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const observed = await state(key);
      if (observed[name]) return observed;
      await pause(10);
    }
    throw new Error(`Missing local server marker: ${key}/${name}`);
  };
  const inspect = async (id: number) =>
    Schema.decodeUnknownSync(
      Schema.Struct({ state: Schema.NullOr(Schema.String) }),
    )(await json(`/fixture/inspect/${id}`));
  const raw = async (
    key: string,
    path: string,
    method = 'POST',
    upload = false,
    controlledAbort = false,
    payload?: { body: string; generation?: string },
  ) => {
    const socket = createConnection({ host: '127.0.0.1', port: physicalPort });
    sockets.add(socket);
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.on('error', () => {}); // Reset is intentional; never treat it as server evidence.
    socket.once('close', () => sockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', () =>
        reject(new Error('Loopback socket connection failed')),
      );
    });
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\nAuthorization: Bearer ${ingestion}\r\nX-Fixture-Gate: ${key}\r\n${controlledAbort ? 'X-Fixture-Controlled-Abort: 1\r\n' : ''}${payload?.generation ? `X-Publication-Generation: ${payload.generation}\r\n` : ''}${upload || payload ? 'Content-Type: application/json\r\n' : ''}Content-Length: ${upload ? 1000 : Buffer.byteLength(payload?.body ?? '')}\r\n\r\n${payload?.body ?? (upload ? '{' : '')}`,
    );
    return {
      disconnect: () => socket.resetAndDestroy(),
      hasHeaders: () => text.includes('\r\n\r\n'),
      send: (chunk: string) => socket.write(chunk),
      response: async () => {
        const deadline = Date.now() + 15_000;
        let body: unknown;
        // These small buffered envelopes have one HTTP body chunk, but TCP
        // can split that chunk anywhere. Wait for complete JSON, not a brace.
        while (body === undefined && Date.now() < deadline) {
          const bodyText = text.slice(
            text.indexOf('{'),
            text.lastIndexOf('}') + 1,
          );
          try {
            body = JSON.parse(bodyText);
          } catch {
            await pause(5);
          }
        }
        if (body === undefined)
          throw new Error('Native HTTP response watchdog');
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]);
        const headers = text.slice(0, text.indexOf('\r\n\r\n'));
        for (const secret of secrets)
          expect(
            text.includes(secret),
            'No credential in native HTTP response',
          ).toBe(false);
        return { status, headers, body };
      },
    };
  };
  const withWorker = async <A>(run: () => Promise<A>) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../bin/cli.js', import.meta.resolve('alchemy'))),
        'dev',
        '--config',
        join(directory, 'tests/fixtures/cancellation-stack.ts'),
        '--stage',
        'local-cancellation-test',
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
          CANCELLATION_TEST_PORT: String(port),
          CANCELLATION_TEST_MIGRATIONS: migrations,
          INGESTION_BEARER_TOKEN: ingestion,
          PUBLICATION_ADMIN_BEARER_TOKEN: admin,
        },
      },
    );
    let started = false;
    let spawnFailed = false;
    let leaked = false;
    let unsafe = false;
    let output = '';
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      for (const secret of secrets) {
        leaked ||= output.includes(secret);
        output = output.replaceAll(secret, '[redacted]');
      }
      unsafe ||= [
        'cancellation_fixture_missing_table',
        'D1_ERROR',
        'no such table',
        'insert into steam_application',
        'SqlError',
        'EffectDrizzleQueryError',
        'Unhandled API error',
        'Synthetic Cancellation Observation',
        'synthetic-cancellation-original',
        'https://catalog.example.invalid/apps/1001',
      ].some((value) => output.includes(value));
      started ||= output.includes('[Api] Started');
      output = output.slice(-100_000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => {
      spawnFailed = true;
    });
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    try {
      const deadline = Date.now() + 90_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (spawnFailed || child.exitCode !== null)
          throw new Error(
            'Local cancellation fixture exited before readiness; diagnostics withheld',
          );
        if (started) {
          try {
            const response = await fetch(`${url}/ready`, {
              signal: AbortSignal.timeout(2_000),
            });
            ready = response.ok && (await response.text()) === 'ready';
            if (ready) break;
          } catch {
            /* Proxy can appear before workerd is ready. */
          }
        }
        await pause(100);
      }
      expect(ready, 'Local workerd readiness').toBe(true);
      // The raw relay closes its upstream with FIN; in this pinned stack the
      // abort probe requires a reset on workerd's owned native HTTP listener.
      // POSIX acceptance prerequisite: ps + lsof (discovery only, no executor).
      physicalPort = port;
      const processes = await exec('ps', ['-eo', 'pid=,ppid=']);
      const descendants = new Set([child.pid]);
      const pairs = [...processes.stdout.matchAll(/^\s*(\d+)\s+(\d+)\s*$/gm)];
      let changed = true;
      while (changed) {
        changed = false;
        for (const pair of pairs) {
          const pid = Number(pair[1]);
          if (descendants.has(Number(pair[2])) && !descendants.has(pid)) {
            descendants.add(pid);
            changed = true;
          }
        }
      }
      const listening = await exec('lsof', [
        '-nP',
        '-a',
        '-p',
        [...descendants].join(','),
        '-iTCP',
        '-sTCP:LISTEN',
        '-Fn',
      ]);
      const candidates = [
        ...listening.stdout.matchAll(/^n127\.0\.0\.1:(\d+)$/gm),
      ].map((match) => Number(match[1]));
      for (const candidate of candidates) {
        if (candidate === port) continue;
        try {
          const response = await fetch(`http://127.0.0.1:${candidate}/ready`, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok && (await response.text()) === 'ready') {
            physicalPort = candidate;
            break;
          }
        } catch {
          /* Only this fixture's descendant HTTP listener is eligible. */
        }
      }
      expect(physicalPort, 'Native worker loopback socket found').not.toBe(
        port,
      );
      return await run();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32')
          await exec('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, 'SIGTERM');
        const timer = setTimeout(() => {
          if (
            child.pid &&
            child.exitCode === null &&
            process.platform !== 'win32'
          )
            process.kill(-child.pid, 'SIGKILL');
        }, 5_000);
        await closed;
        clearTimeout(timer);
      }
      await closed;
      expect(leaked, 'No credentials in child output').toBe(false);
      expect(unsafe, 'No SQL or driver causes in child output').toBe(false);
      for (const entry of await readdir(directory, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const content = new TextDecoder().decode(
          await readFile(join(entry.parentPath, entry.name)),
        );
        for (const secret of secrets)
          expect(content.includes(secret), 'No credentials persisted').toBe(
            false,
          );
      }
    }
  };
  try {
    await mkdir(home);
    await mkdir(config);
    // Freeze this run's source graph: Alchemy's dev bundle watcher otherwise
    // resets volatile gate markers when another contributor edits production.
    const root = fileURLToPath(new URL('../../', import.meta.url));
    await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
    for (const name of [
      'alchemy.run.ts',
      'drizzle.config.ts',
      'package.json',
    ]) {
      await cp(join(root, name), join(directory, name));
    }
    await mkdir(join(directory, 'tests/fixtures'), { recursive: true });
    for (const name of [
      'cancellation-stack.ts',
      'cancellation-worker.ts',
      'cancellation-gates.ts',
    ]) {
      await cp(
        join(root, 'tests/fixtures', name),
        join(directory, 'tests/fixtures', name),
      );
    }
    await symlink(
      join(root, 'node_modules'),
      join(directory, 'node_modules'),
      'junction',
    );
    await cp(
      fileURLToPath(new URL('../../drizzle/', import.meta.url)),
      migrations,
      { recursive: true },
    );
    const recovery = await withWorker(async () => {
      await arm('before-dispatch', 'pre');
      const pending = await raw(
        'before-dispatch',
        '/internal/v1/steam/applications/9101/ingestion-authorization',
      );
      await marker('before-dispatch', 'checkpoint');
      expect((await state('before-dispatch')).batches).toBe(0);
      pending.disconnect();
      await marker('before-dispatch', 'physicalAborts');
      await marker('before-dispatch', 'request_aborted');
      const preflight = await marker('before-dispatch', 'cleanup_complete');
      expect(preflight).toMatchObject({
        physicalAborts: 1,
        request_aborted: 1,
        abortBeforeDispatch: 1,
        abortAfterDispatch: 0,
        write_dispatched: 0,
        effect_exit: 1,
        interrupted: 1,
        cleanup_complete: 1,
      });
      await action('before-dispatch', 'release');
      expect((await state('before-dispatch')).batches).toBe(0);
      expect(await inspect(9101)).toEqual({ state: null });

      // Binding success and storage are observed BEFORE the socket is reset.
      await arm('committed-disconnect', 'batch');
      const committed = await raw(
        'committed-disconnect',
        '/internal/v1/steam/applications/9102/ingestion-authorization',
      );
      await marker('committed-disconnect', 'succeeded');
      expect(await inspect(9102)).toEqual({ state: 'eligible' });
      expect(committed.hasHeaders()).toBe(false);
      expect((await state('committed-disconnect')).effect_exit).toBe(0);
      committed.disconnect();
      await marker('committed-disconnect', 'physicalAborts');
      await marker('committed-disconnect', 'request_aborted');
      await action('committed-disconnect', 'respond');
      const completed = await marker(
        'committed-disconnect',
        'cleanup_complete',
      );
      expect(completed).toMatchObject({
        batches: 1,
        settled: 1,
        succeeded: 1,
        failed: 0,
        write_dispatched: 1,
        write_succeeded: 1,
        abortAfterDispatch: 1,
        abortBeforeDispatch: 0,
        observedOutcomes: 1,
        effect_exit: 1,
        success: 1,
        interrupted: 0,
        correlated: true,
      });
      expect(await inspect(9102)).toEqual({ state: 'eligible' });

      // Keep the receiver connected for cooperative read interruption evidence.
      await arm('controlled-read', 'read');
      const read = await raw(
        'controlled-read',
        '/v1/steam/applications/9102',
        'GET',
        false,
        true,
      );
      await marker('controlled-read', 'succeeded');
      expect((await state('controlled-read')).effect_exit).toBe(0);
      await action('controlled-read', 'abort');
      const readResponse = await read.response();
      expect(readResponse.status).toBe(408);
      expect(readResponse.body).toMatchObject({
        error: { code: 'REQUEST_ABORTED', request_id: expect.any(String) },
      });
      const interrupted = await marker('controlled-read', 'cleanup_complete');
      expect(interrupted).toMatchObject({
        reads: 1,
        effect_exit: 1,
        interrupted: 1,
        success: 0,
        failure: 0,
        correlated: true,
        physicalAborts: 0,
      });
      await action('controlled-read', 'respond');
      await marker('controlled-read', 'forwarded');
      expect((await state('controlled-read')).effect_exit).toBe(1);

      // Separately establish native transport propagation, not a fetch reject.
      await arm('physical-read', 'read');
      const physicalRead = await raw(
        'physical-read',
        '/v1/steam/applications/9102',
        'GET',
      );
      await marker('physical-read', 'succeeded');
      physicalRead.disconnect();
      await marker('physical-read', 'physicalAborts');
      await marker('physical-read', 'request_aborted');
      await action('physical-read', 'respond');
      expect((await state('physical-read')).success).toBe(0);

      await arm('stalled-upload', 'upload');
      const upload = await raw(
        'stalled-upload',
        '/internal/v1/steam/applications/9103/snapshot',
        'PUT',
        true,
      );
      await marker('stalled-upload', 'body_reader_acquired');
      upload.disconnect();
      await marker('stalled-upload', 'physicalAborts');
      await marker('stalled-upload', 'request_aborted');
      const releasedUpload = await marker(
        'stalled-upload',
        'body_reader_released',
      );
      expect(releasedUpload).toMatchObject({
        body_reader_acquired: 1,
        body_reader_released: 1,
        readerLocked: true,
        readerUnlocked: true,
        batches: 0,
        reads: 0,
        effect_exit: 0,
      });
      await marker('stalled-upload', 'cleanup_complete');
      expect(await inspect(9103)).toEqual({ state: null });

      // Real elapsed time, below the byte bound, without EOF. Keep sending
      // bytes so an inactivity timeout cannot satisfy this absolute deadline.
      await arm('slow-connected-upload', 'upload');
      const startedAt = Date.now();
      const slow = await raw(
        'slow-connected-upload',
        '/internal/v1/steam/applications/9104/snapshot',
        'PUT',
        true,
      );
      await marker('slow-connected-upload', 'body_reader_acquired');
      let sent = 0;
      const sending = setInterval(() => {
        slow.send(' ');
        sent++;
      }, 1000);
      try {
        const timeout = await slow.response();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9500);
        expect(Date.now() - startedAt).toBeLessThan(14_000);
        expect(sent).toBeGreaterThanOrEqual(8);
        expect(timeout.status).toBe(408);
        expect(timeout.body).toMatchObject({
          error: { code: 'BODY_READ_TIMEOUT', request_id: expect.any(String) },
        });
        expect(timeout.headers).toMatch(/cache-control: no-store/i);
        const cleaned = await marker(
          'slow-connected-upload',
          'cleanup_complete',
        );
        expect(cleaned).toMatchObject({
          body_reader_acquired: 1,
          body_reader_released: 1,
          readerLocked: true,
          readerUnlocked: true,
          batches: 0,
          reads: 0,
          effect_exit: 0,
          correlated: true,
        });
        expect(await inspect(9104)).toEqual({ state: null });
      } finally {
        clearInterval(sending);
        slow.disconnect();
      }

      await arm('later-sql-failure', 'sql-failure');
      const failedBatch = await raw(
        'later-sql-failure',
        '/internal/v1/steam/applications/9105/ingestion-authorization',
      );
      const rollback = await failedBatch.response();
      expect(rollback.status).toBe(500);
      expect(rollback.body).toMatchObject({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });
      expect(await inspect(9105)).toEqual({ state: null });
      const failed = await marker('later-sql-failure', 'cleanup_complete');
      expect(failed).toMatchObject({
        batches: 1,
        settled: 1,
        succeeded: 0,
        failed: 1,
        write_failed: 1,
        success: 0,
        failure: 1,
      });
      failedBatch.disconnect();

      await arm('postcommit-decoding', 'decode-failure');
      const decoding = await raw(
        'postcommit-decoding',
        '/internal/v1/steam/applications/9106/ingestion-authorization',
      );
      const decodingResponse = await decoding.response();
      expect(decodingResponse.status).toBe(500);
      expect(decodingResponse.body).toMatchObject({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });
      expect(await inspect(9106)).toEqual({ state: 'eligible' });
      const decoded = await marker('postcommit-decoding', 'cleanup_complete');
      expect(decoded).toMatchObject({
        batches: 1,
        settled: 1,
        succeeded: 1,
        failed: 0,
        write_succeeded: 1,
        effect_exit: 1,
        success: 0,
        failure: 1,
        interrupted: 0,
      });
      decoding.disconnect();

      await arm('recovery-authorization', 'upload');
      const authorizationSocket = await raw(
        'recovery-authorization',
        '/internal/v1/steam/applications/9107/ingestion-authorization',
      );
      const authorizationResponse = await authorizationSocket.response();
      expect(authorizationResponse.status).toBe(200);
      const authorization = Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({
            generation: Schema.String,
            minimum_observed_at: Schema.Number,
          }),
        }),
      )(authorizationResponse.body).data;
      authorizationSocket.disconnect();
      const snapshot = {
        event_id: 'synthetic-cancellation-original',
        metadata: {
          title: 'Synthetic Cancellation Observation',
          product_type: 'game',
          base_app_id: null,
          developers: null,
          publishers: null,
          supported_os: ['linux'],
          release: { status: 'unknown', date: { kind: 'unknown' } },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001',
          language: 'en',
          observed_at: Math.floor(Date.now() / 1000),
          extractor_version: 'synthetic-v1',
        },
      };
      const original = JSON.stringify(snapshot);
      await arm('outcome-unavailable', 'batch');
      const uncertain = await raw(
        'outcome-unavailable',
        '/internal/v1/steam/applications/9107/snapshot',
        'PUT',
        false,
        false,
        { body: original, generation: authorization.generation },
      );
      await marker('outcome-unavailable', 'succeeded');
      expect(await json('/fixture/snapshot/9107')).toEqual({
        snapshot: {
          eventId: 'synthetic-cancellation-original',
          observedAt: snapshot.provenance.observed_at,
        },
      });
      expect(uncertain.hasHeaders()).toBe(false);
      uncertain.disconnect();
      await marker('outcome-unavailable', 'physicalAborts');
      await marker('outcome-unavailable', 'request_aborted');
      expect(await state('outcome-unavailable')).toMatchObject({
        batches: 1,
        succeeded: 1,
        write_succeeded: 0,
        effect_exit: 0,
        cleanup_complete: 0,
      });
      // Deliberately NEVER release this result gate. withWorker terminates the
      // actual process tree: missing outcome is not cooperative interruption
      // or rollback evidence. Independent storage inspection follows restart.
      return { authorization, snapshot, original };
    });
    await withWorker(async () => {
      expect(await inspect(9107)).toEqual({ state: 'eligible' });
      expect(await json('/fixture/snapshot/9107')).toEqual({
        snapshot: {
          eventId: 'synthetic-cancellation-original',
          observedAt: recovery.snapshot.provenance.observed_at,
        },
      });
      const replay = async (key: string, body: string) => {
        await arm(key, 'upload');
        const request = await raw(
          key,
          '/internal/v1/steam/applications/9107/snapshot',
          'PUT',
          false,
          false,
          { body, generation: recovery.authorization.generation },
        );
        const response = await request.response();
        request.disconnect();
        expect(response.status).toBe(200);
        return Schema.decodeUnknownSync(
          Schema.Struct({ data: Schema.Struct({ outcome: Schema.String }) }),
        )(response.body).data.outcome;
      };
      expect(await replay('same-delivery', recovery.original)).toBe(
        'unchanged',
      );
      // Construct a genuinely later synthetic observation using the local
      // clock, never floor + 1 or a manufactured timestamp to force a write.
      const observationDeadline = Date.now() + 3_000;
      while (
        Math.floor(Date.now() / 1000) <=
        recovery.snapshot.provenance.observed_at
      ) {
        if (Date.now() >= observationDeadline)
          throw new Error('Local observation clock did not advance');
        await pause(20);
      }
      const observedAt = Math.floor(Date.now() / 1000);
      const newer = {
        ...recovery.snapshot,
        event_id: 'synthetic-cancellation-newer',
        provenance: {
          ...recovery.snapshot.provenance,
          observed_at: observedAt,
        },
      };
      expect(await replay('newer-delivery', JSON.stringify(newer))).toBe(
        'applied',
      );
      expect(await replay('old-delivery', recovery.original)).toBe(
        'ignored_stale',
      );
      expect(await json('/fixture/snapshot/9107')).toEqual({
        snapshot: {
          eventId: 'synthetic-cancellation-newer',
          observedAt,
        },
      });
      expect(await inspect(9101)).toEqual({ state: null });
      expect(await inspect(9105)).toEqual({ state: null });
      expect(await inspect(9106)).toEqual({ state: 'eligible' });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
