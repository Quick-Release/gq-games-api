// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import * as Alchemy from 'alchemy';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import * as Cloudflare from '@alchemy.run/cloudflare';
import { Config, Effect } from 'effect';
import { apiConfig, publicationState } from '../../alchemy.run.ts';

export default Alchemy.Stack(
  'gq-games-api-cancellation-test',
  {
    providers: Cloudflare.providers(),
    state: publicationState,
  },
  Effect.gen(function* () {
    if (!(yield* AlchemyContext).dev)
      return yield* Effect.die('The cancellation fixture is local-only.');
    const db = yield* Cloudflare.D1.Database('Database', {
      migrations: yield* Config.String('CANCELLATION_TEST_MIGRATIONS'),
    });
    const api = yield* Cloudflare.Worker('Api', {
      ...apiConfig,
      // Inherit production compatibility, including enable_request_signal.
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
      main: fileURLToPath(new URL('./cancellation-worker.ts', import.meta.url)),
      dev: {
        host: '127.0.0.1',
        port: yield* Config.Number('CANCELLATION_TEST_PORT'),
        strictPort: true,
      },
      build: { output: { dir: resolve('.alchemy/bundles/Api') } },
    });
    return { url: api.url };
  }),
);
