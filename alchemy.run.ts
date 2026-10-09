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
import { Config, Effect, Layer, Redacted } from 'effect';
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
    // Config bindings are Worker secret_text values, never plaintext vars.
    // Blank defaults keep local scaffold/health usable and fail private routes
    // closed until independently rotatable credentials are supplied.
    INGESTION_BEARER_TOKEN: Config.Redacted('INGESTION_BEARER_TOKEN').pipe(
      Config.withDefault(Redacted.make('')),
    ),
    PUBLICATION_ADMIN_BEARER_TOKEN: Config.Redacted(
      'PUBLICATION_ADMIN_BEARER_TOKEN',
    ).pipe(Config.withDefault(Redacted.make(''))),
    // Exact synthetic URL/extractor pairs; empty configuration approves nothing.
    // This is an enforcement policy, not source-rights approval.
    APPROVED_SNAPSHOT_SOURCES: Config.String('APPROVED_SNAPSHOT_SOURCES').pipe(
      Config.withDefault(''),
    ),
  },
  compatibility: { date: '2026-10-07', flags: ['nodejs_compat'] },
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

// Never use ephemeral Worker state to manage cloud infrastructure. Keep the
// original credential-free scaffold state, and block secret-bearing non-dev
// runs until an independently approved protected state/rollout plan exists.
export const publicationState = Layer.unwrap(
  Effect.gen(function* () {
    if ((yield* AlchemyContext).dev) return localPublicationState;
    const ingestion = yield* apiConfig.env.INGESTION_BEARER_TOKEN;
    const admin = yield* apiConfig.env.PUBLICATION_ADMIN_BEARER_TOKEN;
    if (Redacted.value(ingestion) || Redacted.value(admin)) {
      return yield* Effect.die(
        'Configured publication secrets require an approved protected deployment state store. This capability is local-only.',
      );
    }
    // Preserve the original credential-free scaffold's durable state. A real
    // secret-bearing deployment needs a separately approved state/rollout plan.
    return localState();
  }).pipe(Effect.orDie),
);

export default Alchemy.Stack(
  'gq-games-api',
  {
    providers: Cloudflare.providers(),
    // Deliberately no cloud-state bootstrap or secret persistence.
    state: publicationState,
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
