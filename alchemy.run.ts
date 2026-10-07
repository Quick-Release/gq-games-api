// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { localState } from 'alchemy/State';
import { Effect } from 'effect';

// One configuration for Alchemy dev, deployment, and the offline build adapter.
// Plain Worker mode keeps Hono/runtime code separate from infrastructure.
export const apiConfig = {
  main: './src/index.ts',
  compatibility: { date: '2026-10-07', flags: ['nodejs_compat'] },
  workersDev: true,
  dev: { host: '127.0.0.1', port: 8787, strictPort: true },
  build: { output: { dir: 'dist', entryFileNames: 'index.js' } },
} satisfies Cloudflare.WorkerProps;

export const Api = Cloudflare.Worker('Api', apiConfig);

export default Alchemy.Stack(
  'gq-games-api',
  {
    providers: Cloudflare.providers(),
    // Deliberately no cloud-state bootstrap in this research scaffold.
    state: localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
