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
const publicPrefix = '/v1/steam/applications';
const maximumBodyBytes = 32 * 1024;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 503;
type ErrorCode =
  | 'INVALID_APP_ID'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PUBLICATION_WITHDRAWN'
  | 'PUBLICATION_GENERATION_MISMATCH'
  | 'SNAPSHOT_CONFLICT'
  | 'SOURCE_NOT_APPROVED'
  | 'INVALID_JSON'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'INTERNAL_SERVER_ERROR'
  | 'SERVICE_UNAVAILABLE';

export const catalogError = (
  c: Context<CatalogHttpEnv>,
  status: ErrorStatus,
  code: ErrorCode,
  issues?: { path: string; code: string }[],
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

const releaseBodyReader = (
  reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader,
) => {
  // Cancellation is advisory: hostile/test producers must not replace a chosen
  // 413 with a rejection or delay it forever. Never log cancellation causes.
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // A nonstandard producer can throw synchronously as well.
  } finally {
    reader.releaseLock();
  }
};

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
    releaseBodyReader(reader);
  }
};

// Never trust Content-Length to establish either size or completeness. Decode
// only after collecting at most the actual 32 KiB limit, rejecting invalid UTF-8.
const readSnapshotBody = async (c: Context<CatalogHttpEnv>) => {
  const media = c.req.header('Content-Type') ?? '';
  const encoding = c.req.header('Content-Encoding');
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
      media,
    ) ||
    (encoding !== undefined && encoding.toLowerCase() !== 'identity')
  ) {
    return { error: catalogError(c, 415, 'UNSUPPORTED_MEDIA_TYPE') };
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const stream = c.req.raw.body;
  // Native HTTP byte streams support bounded BYOB reads. Default streams from
  // code-only adapters cannot control producer chunk size; reject their first
  // overflowing chunk without copying/retaining it, rather than buffering it.
  const byob = (() => {
    try {
      return stream?.getReader({ mode: 'byob' });
    } catch {
      return undefined;
    }
  })();
  const reader = byob ? undefined : stream?.getReader();
  // One extra byte is the necessary overflow probe at the exact limit.
  const read = byob
    ? () =>
        byob.read(new Uint8Array(Math.min(8192, maximumBodyBytes + 1 - length)))
    : reader
      ? () => reader.read()
      : undefined;
  if (read) {
    try {
      while (true) {
        const { done, value } = await read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumBodyBytes) {
          return { error: catalogError(c, 413, 'PAYLOAD_TOO_LARGE') };
        }
        if (value.byteLength > 0) chunks.push(value);
      }
    } finally {
      if (byob) releaseBodyReader(byob);
      if (reader) releaseBodyReader(reader);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const input: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return { input };
  } catch {
    return { error: catalogError(c, 400, 'INVALID_JSON') };
  }
};

const runCatalog = async <A>(
  c: Context<CatalogHttpEnv>,
  options: CatalogHttpOptions,
  operation: Effect.Effect<A, CatalogFailure, Catalog>,
) => {
  // Construct/provide the production layers per request, never in the bundle's
  // global scope. Overrides bypass D1 entirely for Node HTTP boundary tests.
  if (!options.catalogLayer && !c.env?.DB) {
    return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
  }
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
      case 'NOT_FOUND':
        return catalogError(c, 404, 'NOT_FOUND');
      case 'PUBLICATION_WITHDRAWN':
      case 'PUBLICATION_GENERATION_MISMATCH':
      case 'SNAPSHOT_CONFLICT':
        return catalogError(c, 409, failure.value.code);
      case 'SOURCE_NOT_APPROVED':
        return catalogError(c, 403, failure.value.code);
      case 'VALIDATION_FAILED':
        return catalogError(c, 422, failure.value.code, failure.value.issues);
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
  for (const path of [prefix, publicPrefix]) {
    app.use(path, transport);
    app.use(`${path}/*`, transport);
  }

  app.get(`${publicPrefix}/:steamAppId`, async (c) => {
    const steamAppId = parseAppId(c.req.param('steamAppId'));
    if (steamAppId === undefined) return catalogError(c, 400, 'INVALID_APP_ID');

    return runCatalog(
      c,
      options,
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const { steam_app_id, metadata, provenance } =
          yield* catalog.lookupApplication(steamAppId);
        // Whitelist at every public object boundary, not just the database row.
        // Private delivery/control fields never belong in this representation.
        const date = metadata.release.date;
        return {
          steam_app_id,
          metadata: {
            title: metadata.title,
            product_type: metadata.product_type,
            base_app_id: metadata.base_app_id,
            developers: metadata.developers,
            publishers: metadata.publishers,
            supported_os: metadata.supported_os,
            release: {
              status: metadata.release.status,
              date:
                date.kind === 'exact'
                  ? { kind: date.kind, date: date.date }
                  : date.kind === 'window'
                    ? { kind: date.kind, window: date.window }
                    : { kind: date.kind },
            },
          },
          provenance: {
            source_url: provenance.source_url,
            language: provenance.language,
            observed_at: provenance.observed_at,
          },
        };
      }),
    );
  });

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

  app.put(`${prefix}/:steamAppId/snapshot`, async (c) => {
    const denied = authenticate(c, 'ingestion', options);
    if (denied) return denied;
    const steamAppId = parseAppId(c.req.param('steamAppId'));
    if (steamAppId === undefined) return catalogError(c, 400, 'INVALID_APP_ID');
    const body = await readSnapshotBody(c);
    if (body.error) return body.error;

    return runCatalog(
      c,
      options,
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        const { steam_app_id, outcome, current_observed_at } =
          yield* catalog.submitSnapshot(
            steamAppId,
            c.req.header('X-Publication-Generation'),
            body.input,
            c.env.APPROVED_SNAPSHOT_SOURCES,
          );
        return { steam_app_id, outcome, current_observed_at };
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
