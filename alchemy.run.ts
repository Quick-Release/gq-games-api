// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import * as Alchemy from 'alchemy';
import { AlchemyContext } from 'alchemy/AlchemyContext';
import * as Cloudflare from 'alchemy/Cloudflare';
import {
  InMemoryService,
  localState,
  State,
  type StateService,
} from 'alchemy/State';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';
import drizzleConfig from './drizzle.config.ts';

export const Db = Cloudflare.D1.Database('Database', {
  migrations: drizzleConfig.out,
});

// One configuration for Alchemy dev, deployment, and the offline build adapter.
// Plain Worker mode keeps Hono/runtime code separate from infrastructure.
export const apiConfig = {
  main: './src/index.ts',
  env: {
    DB: Db,
    CATALOG_ACCESS_MODE: Config.String('CATALOG_ACCESS_MODE').pipe(
      Config.withDefault('anonymous'),
    ),
    // Config bindings are Worker secret_text values, never plaintext vars.
    // Blank defaults keep local scaffold/health usable and fail private routes
    // closed until independently rotatable credentials are supplied.
    INGESTION_BEARER_TOKEN: Config.Redacted('INGESTION_BEARER_TOKEN').pipe(
      Config.withDefault(Redacted.make('')),
    ),
    PUBLICATION_ADMIN_BEARER_TOKEN: Config.Redacted(
      'PUBLICATION_ADMIN_BEARER_TOKEN',
    ).pipe(Config.withDefault(Redacted.make(''))),
    REGISTRY_BEARER_TOKEN: Config.Redacted('REGISTRY_BEARER_TOKEN').pipe(
      Config.withDefault(Redacted.make('')),
    ),
    // Exact URL/extractor pairs, each listed individually; empty configuration
    // approves nothing. Real tuples need a recorded rights policy (ADR 0003).
    // This is an enforcement policy, not source-rights approval.
    APPROVED_SNAPSHOT_SOURCES: Config.String('APPROVED_SNAPSHOT_SOURCES').pipe(
      Config.withDefault(''),
    ),
    // Separate artwork enforcement policy; blank approves no source.
    APPROVED_ARTWORK_SOURCES: Config.String('APPROVED_ARTWORK_SOURCES').pipe(
      Config.withDefault(''),
    ),
    // Abuse control for the anonymous public read (ADR 0002), per client IP.
    CATALOG_RATE_LIMIT: Cloudflare.RateLimit('CATALOG_RATE_LIMIT', {
      namespaceId: 1001,
      simple: { limit: 100, period: 60 },
    }),
    // AGPL-3.0 section 13 source offer for the served revision (ADR 0002).
    // Deployed stages require the exact commit; local stages may omit it.
    SOURCE_REPOSITORY: Config.String('SOURCE_REPOSITORY').pipe(
      Config.withDefault('https://github.com/Quick-Release/gq-games-api'),
    ),
    SOURCE_REVISION: Config.String('SOURCE_REVISION').pipe(
      Config.withDefault(''),
    ),
  },
  compatibility: {
    date: '2026-10-07',
    flags: ['nodejs_compat', 'enable_request_signal'],
  },
  workersDev: true,
  dev: { host: '127.0.0.1', port: 8787, strictPort: true },
  build: { output: { dir: 'dist', entryFileNames: 'index.js' } },
} satisfies Cloudflare.WorkerProps;

export const Api = Cloudflare.Worker('Api', apiConfig);

// Pinned Alchemy unwraps Redacted values into JSON state, but D1's random local
// identity MUST survive restart to reopen the same storage. Persist only D1
// identity/migration state; every other resource (including Worker secrets) and
// stack output stays in memory. This is not a database/migration executor.
export const localPublicationState = Layer.effect(
  State,
  Effect.gen(function* () {
    const disk = yield* yield* State;
    const memory = yield* InMemoryService();
    const state = {
      ...disk,
      id: 'local-publication',
      get: (request) =>
        memory
          .get(request)
          .pipe(
            Effect.flatMap((value) =>
              value === undefined ? disk.get(request) : Effect.succeed(value),
            ),
          ),
      set: (request) =>
        'resourceType' in request.value &&
        request.value.resourceType === 'Cloudflare.D1Database'
          ? disk.set(request)
          : memory.set(request),
      list: (request) =>
        Effect.all([disk.list(request), memory.list(request)]).pipe(
          Effect.map(([persisted, ephemeral]) => [
            ...new Set([...persisted, ...ephemeral]),
          ]),
        ),
      getReplacedResources: (request) =>
        Effect.all([
          disk.getReplacedResources(request),
          memory.getReplacedResources(request),
        ]).pipe(
          Effect.map(([persisted, ephemeral]) => [...persisted, ...ephemeral]),
        ),
      delete: (request) =>
        Effect.all([disk.delete(request), memory.delete(request)]).pipe(
          Effect.asVoid,
        ),
      deleteStack: (request) =>
        Effect.all([
          disk.deleteStack(request),
          memory.deleteStack(request),
        ]).pipe(Effect.asVoid),
      getOutput: memory.getOutput.bind(memory),
      setOutput: memory.setOutput.bind(memory),
    } satisfies StateService;
    return Effect.succeed(state);
  }),
).pipe(Layer.provide(localState()));

// Deployed stages keep all state, including resolved Worker secrets, in
// Alchemy's encrypted Cloudflare state store (ADR 0002). The plaintext JSON
// adapter above stays local-only, and no non-dev stage ever uses it.
export const deploymentState = Cloudflare.state();

export const stateFor = (dev: boolean) =>
  dev ? localPublicationState : deploymentState;

export const publicationState = Layer.unwrap(
  Effect.gen(function* () {
    return stateFor((yield* AlchemyContext).dev);
  }),
);

const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Hostname = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  ),
);

// Deployed stages serve only from one reviewed custom hostname, never from
// workers.dev, and must name the exact source revision they serve. Neither the
// hostname nor any account identifier is committed to this public repository.
export const deploymentTarget = Effect.gen(function* () {
  const domain = yield* Config.schema(Hostname, 'API_DOMAIN');
  yield* Config.schema(CommitSha, 'SOURCE_REVISION');
  return { domain, workersDev: false } as const;
});

export default Alchemy.Stack(
  'gq-games-api',
  {
    providers: Cloudflare.providers(),
    state: publicationState,
  },
  Effect.gen(function* () {
    if ((yield* AlchemyContext).dev) {
      const api = yield* Api;
      return { url: api.url };
    }
    const target = yield* deploymentTarget.pipe(Effect.orDie);
    const api = yield* Cloudflare.Worker('Api', { ...apiConfig, ...target });
    return { url: api.url };
  }),
);
