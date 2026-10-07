// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { NodeServices } from '@effect/platform-node';
import {
  Artifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from 'alchemy/Artifacts';
import { makeSourceContext, resolveSource } from 'alchemy/Cloudflare';
import { Effect, FileSystem } from 'effect';
import { apiConfig } from '../alchemy.run.ts';

// Alchemy beta.81 has no build-only CLI. Use its exported source-provider API,
// without evaluating the stack, loading state, or resolving cloud credentials.
const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(apiConfig.build.output.dir, {
    recursive: true,
    force: true,
  });
  const source = yield* resolveSource(apiConfig);
  const output = yield* source.build(
    makeSourceContext({
      id: 'Api',
      fqn: 'Api',
      workerName: 'gq-games-api',
      props: { ...apiConfig, isExternal: true },
      compatibility: apiConfig.compatibility,
      stack: { name: 'gq-games-api', stage: 'build' },
    }),
  );
  if (!output.bundle) {
    return yield* Effect.die('Expected a Worker bundle from the API source.');
  }
  console.log(
    `Built Worker: ${apiConfig.build.output.dir}/${output.bundle.files[0].path}`,
  );
}).pipe(
  Effect.provideService(
    Artifacts,
    makeScopedArtifacts(createArtifactStore(), 'Api'),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
);

await Effect.runPromise(build);
