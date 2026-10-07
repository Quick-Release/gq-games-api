// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import * as Alchemy from 'alchemy';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import * as Cloudflare from 'alchemy/Cloudflare';
import { localState } from 'alchemy/State';
import { Config, Effect } from 'effect';
import { apiConfig } from '../../alchemy.run.ts';

export default Alchemy.Stack(
  'gq-games-api-d1-test',
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    if (!(yield* AlchemyContext).dev) {
      return yield* Effect.die('The D1 integration fixture is local-only.');
    }
    const db = yield* Cloudflare.D1.Database('Database', {
      migrations: yield* Config.String('D1_TEST_MIGRATIONS'),
    });
    const api = yield* Cloudflare.Worker('Api', {
      ...apiConfig,
      env: { DB: db },
      main: fileURLToPath(new URL('./d1-worker.ts', import.meta.url)),
      dev: {
        host: '127.0.0.1',
        port: yield* Config.Number('D1_TEST_PORT'),
        strictPort: true,
      },
      build: { output: { dir: resolve('.alchemy/bundles/Api') } },
    });
    return { url: api.url };
  }),
);
