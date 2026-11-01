// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Cause, Effect, Exit, Option } from 'effect';
import type { Hono } from 'hono';
import { Database } from '../db/database';
import { manageRegistry, registryId } from '../services/registry';
import { CatalogFailure } from '../services/catalog-failure';
import {
  catalogError,
  readJsonBody,
  type CatalogHttpEnv,
  type CatalogHttpOptions,
} from './catalog';

export const mountRegistry = (
  app: Hono<CatalogHttpEnv>,
  options: CatalogHttpOptions,
) => {
  app.on(['PUT', 'GET', 'DELETE'], '/v1/keys/:keyId', async (c) => {
    const token = c.env?.REGISTRY_BEARER_TOKEN;
    if (
      typeof token !== 'string' ||
      !token ||
      /\s/.test(token) ||
      token === c.env?.INGESTION_BEARER_TOKEN ||
      token === c.env?.PUBLICATION_ADMIN_BEARER_TOKEN
    ) {
      return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
    }
    const credential = c.req
      .header('Authorization')
      ?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (credential !== token) return catalogError(c, 401, 'UNAUTHORIZED');
    if (
      new URL(c.req.url).protocol !== 'https:' &&
      !options.allowInsecureLocalTest
    )
      return catalogError(c, 403, 'FORBIDDEN');
    const keyId = c.req.param('keyId');
    if (!registryId.test(keyId))
      return catalogError(c, 422, 'VALIDATION_FAILED');
    let input: unknown;
    if (c.req.method === 'PUT') {
      const body = await readJsonBody(c);
      if (body.error) return body.error;
      input = body.input;
    }
    if (!c.env?.DB) return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
    const lifecycle = c.get('requestLifecycle');
    const result = await lifecycle.run(
      manageRegistry(
        keyId,
        c.req.method === 'PUT'
          ? 'upsert'
          : c.req.method === 'DELETE'
            ? 'revoke'
            : 'inspect',
        input,
      ).pipe(Effect.provide(Database.layer(lifecycle.database(c.env.DB)))),
      c.req.method === 'GET' ? 'read' : 'mutation',
    );
    if (Exit.isSuccess(result)) return c.json({ data: result.value });
    if (Cause.hasInterruptsOnly(result.cause) && c.req.raw.signal.aborted)
      return catalogError(c, 408, 'REQUEST_ABORTED');
    const error = Cause.findErrorOption(result.cause);
    if (Option.isSome(error) && error.value instanceof CatalogFailure) {
      const code = error.value.code;
      if (code === 'NOT_FOUND') return catalogError(c, 404, code);
      if (code === 'VALIDATION_FAILED') return catalogError(c, 422, code);
    }
    return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
  });
};
