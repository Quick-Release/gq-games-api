// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import * as Alchemy from 'alchemy';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import * as Cloudflare from 'alchemy/Cloudflare';
import { localState } from 'alchemy/State';
import { Effect } from 'effect';
import { apiConfig } from '../alchemy.run.ts';

// This stack is only for local preview of the offline build, never deployment.
export default Alchemy.Stack(
  'gq-games-api-preview',
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    if (!(yield* AlchemyContext).dev) {
      return yield* Effect.die('Preview is local-only. Use pnpm preview.');
    }
    const api = yield* Cloudflare.Worker('Api', {
      ...apiConfig,
      main: `${apiConfig.build.output.dir}/${apiConfig.build.output.entryFileNames}`,
      bundle: false,
    });
    return { url: api.url };
  }),
);
