// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { existsSync } from 'node:fs';
import { NodeServices } from '@effect/platform-node';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import { State } from 'alchemy/State';
import { ConfigProvider, Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { apiConfig, Db, publicationState } from '../alchemy.run';
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

  it('never persists configured publication secrets in Alchemy JSON state', async () => {
    const stateId = (
      dev: boolean,
      secrets: Record<string, string | undefined>,
    ) =>
      Effect.gen(function* () {
        const state = yield* yield* State;
        return state.id;
      }).pipe(
        Effect.provide(publicationState),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: '.alchemy',
          dev,
          adopt: false,
        }),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(secrets),
        ),
        Effect.provide(NodeServices.layer),
      );
    const secrets = {
      INGESTION_BEARER_TOKEN: crypto.randomUUID(),
      PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
    };
    expect(await Effect.runPromise(stateId(true, secrets))).toBe(
      'local-publication',
    );
    expect(await Effect.runPromise(stateId(false, {}))).toBe('local');
    for (const configured of [
      secrets,
      { INGESTION_BEARER_TOKEN: secrets.INGESTION_BEARER_TOKEN },
      {
        PUBLICATION_ADMIN_BEARER_TOKEN: secrets.PUBLICATION_ADMIN_BEARER_TOKEN,
      },
    ]) {
      const exit = await Effect.runPromiseExit(stateId(false, configured));
      expect(exit._tag).toBe('Failure');
      const diagnostic = String(exit);
      expect(diagnostic).toContain('approved protected deployment state store');
      expect(diagnostic).not.toContain(secrets.INGESTION_BEARER_TOKEN);
      expect(diagnostic).not.toContain(secrets.PUBLICATION_ADMIN_BEARER_TOKEN);
    }
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
