// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { existsSync } from 'node:fs';
import { NodeServices } from '@effect/platform-node';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import { State } from 'alchemy/State';
import { ConfigProvider, Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  apiConfig,
  Db,
  deploymentState,
  deploymentTarget,
  localPublicationState,
  stateFor,
} from '../alchemy.run';
import drizzleConfig from '../drizzle.config';
import pkg from '../package.json';

// Configuration regression tests, not Cloudflare binding/runtime validation.
describe('Alchemy tooling', () => {
  it('owns the Worker configuration without a Wrangler file', () => {
    expect(existsSync('wrangler.jsonc')).toBe(false);
    expect(existsSync('wrangler.json')).toBe(false);
    expect(existsSync('wrangler.toml')).toBe(false);
    expect(apiConfig.main).toBe('./src/index.ts');
    expect(apiConfig.compatibility.flags).toContain('nodejs_compat');
    expect(apiConfig.dev).toEqual({
      host: '127.0.0.1',
      port: 8787,
      strictPort: true,
    });
  });

  it('binds D1 in Alchemy and keeps migration generation credential-free', () => {
    expect(apiConfig.env.DB).toBe(Db);
    expect(drizzleConfig).toEqual({
      dialect: 'sqlite',
      schema: './src/db/schema.ts',
      out: './drizzle',
    });
    expect(pkg.dependencies['drizzle-orm']).toBe(
      pkg.devDependencies['drizzle-kit'],
    );
    expect(pkg.dependencies['@effect/sql-d1']).toBe(pkg.dependencies.effect);
    expect(existsSync('drizzle/meta/_journal.json')).toBe(false);
  });

  it('keeps secrets out of JSON state: local adapter for dev, encrypted store otherwise', async () => {
    const secrets = {
      INGESTION_BEARER_TOKEN: crypto.randomUUID(),
      PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
    };
    const localId = Effect.gen(function* () {
      const state = yield* yield* State;
      return state.id;
    }).pipe(
      Effect.provide(localPublicationState),
      Effect.provideService(AlchemyContext, {
        dotAlchemy: '.alchemy',
        dev: true,
        adopt: false,
      }),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(secrets),
      ),
      Effect.provide(NodeServices.layer),
    );
    expect(await Effect.runPromise(localId)).toBe('local-publication');
    expect(stateFor(true)).toBe(localPublicationState);
    // Deployed stages never fall back to plaintext local JSON state.
    expect(stateFor(false)).toBe(deploymentState);
    expect(stateFor(false)).not.toBe(localPublicationState);
  });

  it('requires a hostname and exact source revision for deployed stages', async () => {
    const target = (config: Record<string, unknown>) =>
      Effect.runPromiseExit(
        deploymentTarget.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(config),
          ),
        ),
      );
    const revision = 'a'.repeat(40);
    const ok = await target({
      API_DOMAIN: 'games-api.example.com',
      SOURCE_REVISION: revision,
    });
    expect(ok).toMatchObject({
      _tag: 'Success',
      value: { domain: 'games-api.example.com', workersDev: false },
    });
    for (const config of [
      { SOURCE_REVISION: revision },
      { API_DOMAIN: 'games-api.example.com' },
      { API_DOMAIN: 'games-api.example.com', SOURCE_REVISION: 'main' },
      {
        API_DOMAIN: 'https://games-api.example.com',
        SOURCE_REVISION: revision,
      },
    ]) {
      expect((await target(config))._tag).toBe('Failure');
    }
  });

  it('rate limits the anonymous read through a declared binding', () => {
    expect(apiConfig.env.CATALOG_RATE_LIMIT).toMatchObject({
      simple: { limit: 100, period: 60 },
    });
  });

  it('keeps local tooling separate from deployment stages', () => {
    expect(pkg.scripts.dev).toBe('alchemy dev --stage local-dev');
    expect(pkg.scripts.preview).toBe(
      'alchemy dev --config scripts/preview-worker.ts --stage local-preview',
    );
    expect(pkg.scripts.build).toBe('node scripts/build-worker.ts');
    expect(pkg.devDependencies).not.toHaveProperty('@cloudflare/vite-plugin');
    expect(pkg.devDependencies).not.toHaveProperty('wrangler');
    expect(apiConfig.build.output).toEqual({
      dir: 'dist',
      entryFileNames: 'index.js',
    });
  });
});
