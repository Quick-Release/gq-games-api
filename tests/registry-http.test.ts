// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vite-plus/test';
import { createApp } from '../src/app';

it('fails closed before accessing D1 for absent, wrong, or reused registry credentials', async () => {
  const app = createApp();
  const registry = randomUUID();
  for (const method of ['PUT', 'GET', 'DELETE']) {
    for (const configured of ['', registry]) {
      const response = await app.request(
        'https://example.invalid/v1/keys/synthetic',
        {
          method,
          headers: { Authorization: `Bearer ${randomUUID()}` },
        },
        { REGISTRY_BEARER_TOKEN: configured },
      );
      expect(response.status).toBe(configured ? 401 : 503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).not.toContain(registry);
    }
    const response = await app.request(
      'https://example.invalid/v1/keys/synthetic',
      {
        method,
        headers: { Authorization: `Bearer ${registry}` },
      },
      { REGISTRY_BEARER_TOKEN: registry, INGESTION_BEARER_TOKEN: registry },
    );
    expect(response.status).toBe(503);
  }
});

it('requires HTTPS and an independent publication-admin credential', async () => {
  const registry = randomUUID();
  const app = createApp();
  for (const [url, env, expected] of [
    [
      'http://example.invalid/v1/keys/synthetic',
      { REGISTRY_BEARER_TOKEN: registry },
      403,
    ],
    [
      'https://example.invalid/v1/keys/synthetic',
      {
        REGISTRY_BEARER_TOKEN: registry,
        PUBLICATION_ADMIN_BEARER_TOKEN: registry,
      },
      503,
    ],
  ] as const) {
    const response = await app.request(
      url,
      { headers: { Authorization: `Bearer ${registry}` } },
      env,
    );
    expect(response.status).toBe(expected);
  }
});
