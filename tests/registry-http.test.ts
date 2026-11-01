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

it.each([{}, { prepare: 'invalid' }, { prepare: () => ({}) }])(
  'maps malformed registry DB bindings to sanitized 503: %o',
  async (db) => {
    const registry = randomUUID();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await createApp().request(
        'https://example.invalid/v1/keys/synthetic',
        {
          method,
          headers: {
            Authorization: `Bearer ${registry}`,
            'Content-Type': 'application/json',
          },
          ...(method === 'PUT' ? { body: '{}' } : {}),
        },
        { REGISTRY_BEARER_TOKEN: registry, DB: db },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          request_id: response.headers.get('X-Request-ID'),
        },
      });
    }
  },
);

it.each(['verify', 'GET', 'PUT', 'DELETE'])(
  'cancels during a pending registry operation: %s',
  async (operation) => {
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const pending = new Promise<unknown[][]>((resolve) => {
      release = () => resolve([]);
    });
    let queries = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          raw: () => {
            queries++;
            entered();
            return pending;
          },
        }),
      }),
      dump: async () => new ArrayBuffer(0),
      withSession: () => {
        throw new Error('unused');
      },
    };
    const registry = randomUUID();
    const controller = new AbortController();
    const verify = operation === 'verify';
    const request = createApp().request(
      verify
        ? 'https://example.invalid/v1/steam/applications/1001'
        : 'https://example.invalid/v1/keys/synthetic',
      {
        method: verify ? 'GET' : operation,
        headers: {
          Authorization: `Bearer ${verify ? `synthetic.${'a'.repeat(64)}` : registry}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        ...(operation === 'PUT'
          ? {
              body: JSON.stringify({
                verifier: '0'.repeat(64),
                tenant_id: 'synthetic',
                scopes: ['catalog:read'],
                expires_at: null,
                revoked: false,
              }),
            }
          : {}),
      },
      {
        DB: db,
        CATALOG_ACCESS_MODE: 'protected',
        REGISTRY_BEARER_TOKEN: registry,
      },
    );
    try {
      await started;
      controller.abort();
      const response = await request;
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({
        error: {
          code: 'REQUEST_ABORTED',
          request_id: response.headers.get('X-Request-ID'),
        },
      });
      expect(queries).toBe(1); // Verification never continues to a catalog read.
    } finally {
      release();
    }
  },
);
