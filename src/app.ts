// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';
import { Hono } from 'hono';
import {
  catalogError,
  mountCatalog,
  type CatalogHttpEnv,
  type CatalogHttpOptions,
} from './http/catalog';
import { getHealth } from './services/health';

export const createApp = (options: CatalogHttpOptions = {}) => {
  const app = new Hono<CatalogHttpEnv>();

  app.get('/', (c) =>
    c.json({
      service: 'gq-games-api',
      maturity: 'research',
      endpoints: { health: '/health' },
    }),
  );

  app.get('/health', async (c) => c.json(await Effect.runPromise(getHealth)));

  mountCatalog(app, options);

  app.notFound((c) =>
    c.get('catalogRequestId')
      ? catalogError(c, 404, 'NOT_FOUND')
      : c.json({ error: { code: 'NOT_FOUND' } }, 404),
  );
  app.onError((_error, c) => {
    console.error('Unhandled API error');
    return c.get('catalogRequestId')
      ? catalogError(c, 500, 'INTERNAL_SERVER_ERROR')
      : c.json({ error: { code: 'INTERNAL_SERVER_ERROR' } }, 500);
  });

  return app;
};
