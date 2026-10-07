// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vite-plus/test';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    throw new Error('Expected a TCP port for the D1 test');
  }
  return address.port;
};

it('runs generated migrations and Effect-native Drizzle CRUD in local workerd', async () => {
  // Isolated cwd means state, local D1 storage, logs, generated migrations,
  // and credentials all stay outside the repository and are cleaned up.
  const directory = await mkdtemp(join(tmpdir(), 'gq-drizzle-d1-'));
  const migrations = join(directory, 'migrations');
  const kit = fileURLToPath(
    new URL('./bin.cjs', import.meta.resolve('drizzle-kit')),
  );
  const alchemy = fileURLToPath(
    new URL('../bin/cli.js', import.meta.resolve('alchemy')),
  );
  const schema = fileURLToPath(
    new URL('../fixtures/schema.ts', import.meta.url),
  );
  const stack = fileURLToPath(
    new URL('../fixtures/d1-stack.ts', import.meta.url),
  );
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  try {
    await exec(process.execPath, [
      kit,
      'generate',
      '--dialect',
      'sqlite',
      '--schema',
      schema,
      '--out',
      migrations,
    ]);

    // Restart against the same isolated D1 to verify migrations aren't replayed.
    for (let run = 0; run < 2; run++) {
      const child = spawn(
        process.execPath,
        [
          alchemy,
          'dev',
          '--config',
          stack,
          '--stage',
          'local-d1-test',
          '--profile',
          'unconfigured-test',
        ],
        {
          cwd: directory,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, 'config'),
            CLOUDFLARE_API_TOKEN: '',
            CLOUDFLARE_API_KEY: '',
            CLOUDFLARE_ACCOUNT_ID: '',
            CLOUDFLARE_EMAIL: '',
            ALCHEMY_TUI: '0',
            ALCHEMY_DEV_ONCE: '0',
            CI: '1',
            NO_COLOR: '1',
            D1_TEST_PORT: String(port),
            D1_TEST_MIGRATIONS: migrations,
          },
        },
      );
      let output = '';
      let spawnError: Error | undefined;
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('error', (error) => {
        spawnError = error;
      });
      const closed = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      try {
        const deadline = Date.now() + 30_000;
        let ready = false;
        while (Date.now() < deadline) {
          if (spawnError || child.exitCode !== null) {
            throw new Error(
              `Alchemy test process failed: ${spawnError ?? output}`,
            );
          }
          if (output.includes('[Api] Started')) {
            const response = await fetch(`${url}/ready`, {
              signal: AbortSignal.timeout(2_000),
            });
            ready = response.ok && (await response.text()) === 'ready';
            if (ready) break;
          }
          await pause(100);
        }
        expect(ready, output).toBe(true);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.text();
        expect(response.status, body).toBe(200);
        expect(JSON.parse(body)).toEqual({
          inserted: [
            { id: 1, value: "synthetic '); DROP TABLE orm_probe; --" },
          ],
          updated: [{ id: 1, value: 'updated' }],
          remaining: [],
          history: [{ count: 1 }],
          error: 'EffectDrizzleQueryError',
        });
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
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
