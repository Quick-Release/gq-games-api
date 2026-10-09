// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import * as Alchemy from 'alchemy';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Config, Effect } from 'effect';
import { apiConfig, publicationState } from '../../alchemy.run.ts';

export default Alchemy.Stack(
  'gq-games-api-catalog-test',
  {
    providers: Cloudflare.providers(),
    // Exercise the actual stack's credential-safe local state selection.
    state: publicationState,
  },
  Effect.gen(function* () {
    if (!(yield* AlchemyContext).dev) {
      return yield* Effect.die(
        'The catalog integration fixture is local-only.',
      );
    }
    const db = yield* Cloudflare.D1.Database('Database', {
      migrations: yield* Config.String('CATALOG_TEST_MIGRATIONS'),
    });
    const api = yield* Cloudflare.Worker('Api', {
      ...apiConfig,
      env: {
        DB: db,
        APPROVED_SNAPSHOT_SOURCES: JSON.stringify([
          {
            source_url: 'https://catalog.example.invalid/apps/1001',
            extractor_version: 'synthetic-v1',
          },
        ]),
        INGESTION_BEARER_TOKEN: Config.Redacted('INGESTION_BEARER_TOKEN'),
        PUBLICATION_ADMIN_BEARER_TOKEN: Config.Redacted(
          'PUBLICATION_ADMIN_BEARER_TOKEN',
        ),
      },
      main: fileURLToPath(new URL('./catalog-worker.ts', import.meta.url)),
      dev: {
        host: '127.0.0.1',
        port: yield* Config.Number('CATALOG_TEST_PORT'),
        strictPort: true,
      },
      build: { output: { dir: resolve('.alchemy/bundles/Api') } },
    });
    return { url: api.url };
  }),
);
