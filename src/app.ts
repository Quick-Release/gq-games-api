// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';
import { Hono } from 'hono';
import {
  catalogError,
  mountCatalog,
  mountApiTransport,
  type CatalogHttpEnv,
} from './http/catalog';
import { mountArtwork, type ArtworkHttpOptions } from './http/artwork';
import { mountRegistry } from './http/registry';
import { getHealth } from './services/health';
import { RequestStopped } from './http/request-lifecycle';

const upstreamRepository = 'https://github.com/Quick-Release/gq-games-api';

export const createApp = (options: ArtworkHttpOptions = {}) => {
  const app = new Hono<CatalogHttpEnv>();

  // AGPL-3.0 section 13 offer for the revision actually being served.
  app.get('/', (c) => {
    const repository = c.env?.SOURCE_REPOSITORY || upstreamRepository;
    const revision = c.env?.SOURCE_REVISION;
    const pinned =
      typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision)
        ? revision
        : null;
    return c.json({
      service: 'gq-games-api',
      maturity: 'research',
      endpoints: {
        health: '/health',
        steam_application: '/v1/steam/applications/{steamAppId}',
      },
      source: {
        license: 'AGPL-3.0-only',
        repository,
        revision: pinned,
        url: pinned ? `${repository}/tree/${pinned}` : repository,
      },
    });
  });

  app.get('/health', async (c) => c.json(await Effect.runPromise(getHealth)));

  mountApiTransport(app, options);
  mountCatalog(app, options);
  mountArtwork(app, options);
  mountRegistry(app, options);

  app.notFound((c) =>
    c.get('catalogRequestId')
      ? catalogError(c, 404, 'NOT_FOUND')
      : c.json({ error: { code: 'NOT_FOUND' } }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof RequestStopped && c.get('catalogRequestId')) {
      return catalogError(c, 408, error.code);
    }
    console.error('Unhandled API error');
    return c.get('catalogRequestId')
      ? catalogError(c, 500, 'INTERNAL_SERVER_ERROR')
      : c.json({ error: { code: 'INTERNAL_SERVER_ERROR' } }, 500);
  });

  return app;
};
