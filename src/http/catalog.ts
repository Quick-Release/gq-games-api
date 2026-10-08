// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Cause, Effect, Exit, Layer, Option } from 'effect';
import type { Context, Hono } from 'hono';
import { Database } from '../db/database';
import type { WorkerEnv } from '../env';
import { Catalog, CatalogFailure } from '../services/catalog';

export type CatalogHttpEnv = {
  Bindings: WorkerEnv;
  Variables: { catalogRequestId: string };
};

export type CatalogHttpOptions = {
  catalogLayer?: Layer.Layer<Catalog>;
  // Code-only test seam. Never derive this from a Worker binding or environment.
  allowInsecureLocalTest?: boolean;
};

const prefix = '/internal/v1/steam/applications';
const maximumBodyBytes = 32 * 1024;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
type ErrorCode =
  | 'INVALID_APP_ID'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PUBLICATION_WITHDRAWN'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'INTERNAL_SERVER_ERROR'
  | 'SERVICE_UNAVAILABLE';

export const catalogError = (
  c: Context<CatalogHttpEnv>,
  status: ErrorStatus,
  code: ErrorCode,
  issues?: { path: 'body'; code: 'BODY_NOT_ALLOWED' }[],
) =>
  c.json(
    {
      error: {
        code,
        request_id: c.get('catalogRequestId'),
        ...(issues ? { issues } : {}),
      },
    },
    status,
  );

const authenticate = (
  c: Context<CatalogHttpEnv>,
  role: 'ingestion' | 'admin',
  options: CatalogHttpOptions,
) => {
  const ingestion = c.env?.INGESTION_BEARER_TOKEN;
  const admin = c.env?.PUBLICATION_ADMIN_BEARER_TOKEN;
  if (
    typeof ingestion !== 'string' ||
    typeof admin !== 'string' ||
    ingestion.length === 0 ||
    admin.length === 0 ||
    ingestion === admin
  ) {
    return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
  }

  const header = c.req.header('Authorization');
  // Scheme names are case-insensitive; credentials are opaque and exact.
  const credential = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (credential !== ingestion && credential !== admin) {
    return catalogError(c, 401, 'UNAUTHORIZED');
  }
  if (credential !== (role === 'ingestion' ? ingestion : admin)) {
    return catalogError(c, 403, 'FORBIDDEN');
  }
  if (
    new URL(c.req.url).protocol !== 'https:' &&
    !options.allowInsecureLocalTest
  ) {
    return catalogError(c, 403, 'FORBIDDEN');
  }
};

const parseAppId = (value: string) =>
  /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 4294967295
    ? Number(value)
    : undefined;

const rejectBody = async (c: Context<CatalogHttpEnv>) => {
  if (Number(c.req.header('Content-Length')) > maximumBodyBytes) {
    return catalogError(c, 413, 'PAYLOAD_TOO_LARGE');
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return;

  try {
    // No JSON parsing or full buffering: stop at the first nonempty chunk.
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength === 0) continue;
      if (value.byteLength > maximumBodyBytes) {
        return catalogError(c, 413, 'PAYLOAD_TOO_LARGE');
      }
      return catalogError(c, 422, 'VALIDATION_FAILED', [
        { path: 'body', code: 'BODY_NOT_ALLOWED' },
      ]);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

const runCatalog = async <A>(
  c: Context<CatalogHttpEnv>,
  options: CatalogHttpOptions,
  operation: Effect.Effect<A, CatalogFailure, Catalog>,
) => {
  // Construct/provide the production layers per request, never in the bundle's
  // global scope. Overrides bypass D1 entirely for Node HTTP boundary tests.
  const layer =
    options.catalogLayer ??
    Catalog.layer.pipe(Layer.provide(Database.layer(c.env.DB)));
  const exit = await Effect.runPromiseExit(
    operation.pipe(Effect.provide(layer)),
  );
  if (Exit.isSuccess(exit)) return c.json({ data: exit.value });

  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof CatalogFailure) {
    switch (failure.value.code) {
      case 'PUBLICATION_WITHDRAWN':
        return catalogError(c, 409, 'PUBLICATION_WITHDRAWN');
      case 'SERVICE_UNAVAILABLE':
        return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
      case 'INTERNAL_SERVER_ERROR':
        return catalogError(c, 500, 'INTERNAL_SERVER_ERROR');
    }
  }
  console.error('Unhandled API error');
  return catalogError(c, 500, 'INTERNAL_SERVER_ERROR');
};

export const mountCatalog = (
  app: Hono<CatalogHttpEnv>,
  options: CatalogHttpOptions,
) => {
  const transport = async (
    c: Context<CatalogHttpEnv>,
    next: () => Promise<void>,
  ) => {
    const requestId = crypto.randomUUID();
    c.set('catalogRequestId', requestId);
    c.header('X-Request-ID', requestId);
    c.header('Cache-Control', 'no-store');
    await next();
  };
  app.use(prefix, transport);
  app.use(`${prefix}/*`, transport);

  app.post(`${prefix}/:steamAppId/ingestion-authorization`, async (c) => {
    const denied = authenticate(c, 'ingestion', options);
    if (denied) return denied;
    const steamAppId = parseAppId(c.req.param('steamAppId'));
    if (steamAppId === undefined) return catalogError(c, 400, 'INVALID_APP_ID');
    const bodyError = await rejectBody(c);
    if (bodyError) return bodyError;

    return runCatalog(
      c,
      options,
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const { steam_app_id, generation, minimum_observed_at } =
          yield* catalog.acquireAuthorization(steamAppId);
        return { steam_app_id, generation, minimum_observed_at };
      }),
    );
  });

  app.get(`${prefix}/:steamAppId/publication`, async (c) => {
    const denied = authenticate(c, 'admin', options);
    if (denied) return denied;
    const steamAppId = parseAppId(c.req.param('steamAppId'));
    if (steamAppId === undefined) return catalogError(c, 400, 'INVALID_APP_ID');

    return runCatalog(
      c,
      options,
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const { steam_app_id, state, generation, generation_issued_at } =
          yield* catalog.inspectPublication(steamAppId);
        return { steam_app_id, state, generation, generation_issued_at };
      }),
    );
  });
};
