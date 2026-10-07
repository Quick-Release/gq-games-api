// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';
import { Hono } from 'hono';
import type { WorkerEnv } from './env';
import { getHealth } from './services/health';

export const createApp = () => {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  app.get('/', (c) =>
    c.json({
      service: 'gq-games-api',
      maturity: 'research',
      endpoints: { health: '/health' },
    }),
  );

  app.get('/health', async (c) => c.json(await Effect.runPromise(getHealth)));

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND' } }, 404));
  app.onError((error, c) => {
    console.error('Unhandled API error', error);
    return c.json({ error: { code: 'INTERNAL_SERVER_ERROR' } }, 500);
  });

  return app;
};
