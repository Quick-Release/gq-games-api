// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { describe, expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';

describe('research API', () => {
  it('describes the implemented surface without promising a games API', async () => {
    const response = await createApp().request('/');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'gq-games-api',
      maturity: 'research',
      endpoints: {
        health: '/health',
        steam_application: '/v1/steam/applications/{steamAppId}',
      },
      source: {
        license: 'AGPL-3.0-only',
        repository: 'https://github.com/Quick-Release/gq-games-api',
        revision: null,
        url: 'https://github.com/Quick-Release/gq-games-api',
      },
    });
  });

  it('offers the exact served source revision (AGPL-3.0 section 13)', async () => {
    const revision = '0123456789abcdef0123456789abcdef01234567';
    const served = async (env: Record<string, unknown>) => {
      const body = await (
        await createApp().request('/', undefined, env)
      ).json();
      return (body as { source: unknown }).source;
    };

    expect(await served({ SOURCE_REVISION: revision })).toEqual({
      license: 'AGPL-3.0-only',
      repository: 'https://github.com/Quick-Release/gq-games-api',
      revision,
      url: `https://github.com/Quick-Release/gq-games-api/tree/${revision}`,
    });
    expect(
      await served({
        SOURCE_REPOSITORY: 'https://git.example.invalid/fork',
        SOURCE_REVISION: revision,
      }),
    ).toMatchObject({
      repository: 'https://git.example.invalid/fork',
      url: `https://git.example.invalid/fork/tree/${revision}`,
    });
    for (const SOURCE_REVISION of ['', 'main', revision.toUpperCase()]) {
      expect(await served({ SOURCE_REVISION })).toMatchObject({
        revision: null,
      });
    }
  });

  it('runs the Effect health service through Hono', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      service: 'gq-games-api',
      status: 'ok',
      maturity: 'research',
    });
  });

  it('does not pretend ingestion or game endpoints exist', async () => {
    for (const path of ['/v1/games', '/ingest', '/missing']) {
      const response = await createApp().request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('does not accept writes to the health endpoint', async () => {
    const response = await createApp().request('/health', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('does not leak internal errors to clients', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp();
      app.get('/failure', () => {
        throw new Error('private diagnostic');
      });

      const response = await app.request('/failure');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'INTERNAL_SERVER_ERROR' },
      });
      expect(log.mock.calls).toEqual([['Unhandled API error']]);
    } finally {
      log.mockRestore();
    }
  });
});
