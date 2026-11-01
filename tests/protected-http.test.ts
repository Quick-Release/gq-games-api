// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect, Layer } from 'effect';
import { Catalog, CatalogFailure } from '../src/services/catalog';
import { expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';

it('requires a customer credential in protected mode before accessing the catalog', async () => {
  const response = await createApp().request(
    'https://example.invalid/v1/steam/applications/1001',
    undefined,
    { CATALOG_ACCESS_MODE: 'protected' },
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: {
      code: 'UNAUTHORIZED',
      request_id: response.headers.get('X-Request-ID'),
    },
  });
});

it('rejects malformed credentials and fails closed for registry outages', async () => {
  for (const [credential, status] of [
    ['Basic anything', 401],
    ['Bearer bad', 401],
    [`Bearer synthetic.${'a'.repeat(64)}.extra`, 401],
    [`Bearer invalid!.${'a'.repeat(64)}`, 401],
    [`Bearer ${'x'.repeat(129)}.${'a'.repeat(64)}`, 401],
    [`Bearer synthetic.${'a'.repeat(64)}`, 503],
  ] as const) {
    const response = await createApp().request(
      'https://example.invalid/v1/steam/applications/1001',
      { headers: { Authorization: credential } },
      { CATALOG_ACCESS_MODE: 'protected' },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: {
        code: status === 401 ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE',
        request_id: response.headers.get('X-Request-ID'),
      },
    });
  }
});

it('checks each registry state through the production consumer route', async () => {
  const secret = 'a'.repeat(64);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  const verifier = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  for (const [state, status] of [
    ['valid', 404],
    ['unknown', 401],
    ['wrong-secret', 401],
    ['expired', 401],
    ['revoked', 401],
    ['wrong-scope', 401],
    ['corrupt-empty', 401],
    ['corrupt-short', 401],
    ['corrupt-odd', 401],
    ['corrupt-hex', 401],
    ['outage', 503],
  ] as const) {
    const raw = vi.fn(async () => {
      if (state === 'outage') throw new Error('synthetic registry outage');
      return state === 'unknown'
        ? []
        : [
            [
              'synthetic',
              state === 'corrupt-empty'
                ? ''
                : state === 'corrupt-short'
                  ? 'abcd'
                  : state === 'corrupt-odd'
                    ? 'a'.repeat(63)
                    : state === 'corrupt-hex'
                      ? 'z'.repeat(64)
                      : verifier,
              'tenant',
              state === 'wrong-scope' ? '[]' : '["catalog:read"]',
              state === 'expired' ? 0 : null,
              state === 'revoked' ? 1 : 0,
            ],
          ];
    });
    // Node adapter supplies synthetic driver rows, not Cloudflare evidence.
    const db = {
      prepare: () => ({ bind: () => ({ raw }) }),
      dump: async () => new ArrayBuffer(0),
      withSession: () => {
        throw new Error('unused');
      },
    };
    const app = createApp({
      catalogLayer: Layer.succeed(Catalog, {
        lookupApplication: () =>
          Effect.fail(new CatalogFailure({ code: 'NOT_FOUND' })),
        changePublication: () => Effect.die('unused'),
        acquireAuthorization: () => Effect.die('unused'),
        inspectPublication: () => Effect.die('unused'),
        submitSnapshot: () => Effect.die('unused'),
      }),
    });
    const response = await app.request(
      'https://example.invalid/v1/steam/applications/1001',
      {
        headers: {
          Authorization: `Bearer synthetic.${state === 'wrong-secret' ? 'b'.repeat(64) : secret}`,
        },
      },
      { CATALOG_ACCESS_MODE: 'protected', DB: db },
    );
    expect(response.status, state).toBe(status);
    expect(raw).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      error: {
        code:
          status === 404
            ? 'NOT_FOUND'
            : status === 503
              ? 'SERVICE_UNAVAILABLE'
              : 'UNAUTHORIZED',
        request_id: response.headers.get('X-Request-ID'),
      },
    });
  }
});

it('explicit anonymous mode ignores a broken registry even with a customer header', async () => {
  const prepare = vi.fn(() => {
    throw new Error('registry must not be read');
  });
  const app = createApp({
    catalogLayer: Layer.succeed(Catalog, {
      lookupApplication: () =>
        Effect.fail(new CatalogFailure({ code: 'NOT_FOUND' })),
      changePublication: () => Effect.die('unused'),
      acquireAuthorization: () => Effect.die('unused'),
      inspectPublication: () => Effect.die('unused'),
      submitSnapshot: () => Effect.die('unused'),
    }),
  });
  const response = await app.request(
    'https://example.invalid/v1/steam/applications/1001',
    {
      headers: { Authorization: `Bearer synthetic.${'a'.repeat(64)}` },
    },
    { CATALOG_ACCESS_MODE: 'anonymous', DB: { prepare } },
  );
  expect(response.status).toBe(404);
  expect(prepare).not.toHaveBeenCalled();
});

it('still cancels a catalog read after successful key verification', async () => {
  const secret = 'a'.repeat(64);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  const verifier = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const db = {
    prepare: () => ({
      bind: () => ({
        raw: async () => [
          ['synthetic', verifier, 'tenant', '["catalog:read"]', null, 0],
        ],
      }),
    }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('unused');
    },
  };
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const app = createApp({
    catalogLayer: Layer.succeed(Catalog, {
      lookupApplication: () =>
        Effect.andThen(Effect.sync(entered), Effect.never),
      changePublication: () => Effect.die('unused'),
      acquireAuthorization: () => Effect.die('unused'),
      inspectPublication: () => Effect.die('unused'),
      submitSnapshot: () => Effect.die('unused'),
    }),
  });
  const controller = new AbortController();
  const pending = app.request(
    'https://example.invalid/v1/steam/applications/1001',
    {
      headers: { Authorization: `Bearer synthetic.${secret}` },
      signal: controller.signal,
    },
    { CATALOG_ACCESS_MODE: 'protected', DB: db },
  );
  await started;
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({
    error: {
      code: 'REQUEST_ABORTED',
      request_id: response.headers.get('X-Request-ID'),
    },
  });
});

it.each([{}, { prepare: 'invalid' }, { prepare: () => ({}) }])(
  'maps malformed DB bindings to sanitized 503: %o',
  async (db) => {
    const response = await createApp().request(
      'https://example.invalid/v1/steam/applications/1001',
      {
        headers: { Authorization: `Bearer synthetic.${'a'.repeat(64)}` },
      },
      { CATALOG_ACCESS_MODE: 'protected', DB: db },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        request_id: response.headers.get('X-Request-ID'),
      },
    });
  },
);

it.each(['', 'unknown', 'PROTECTED', ' protected', 'anonymous '])(
  'fails closed for invalid access mode %j',
  async (mode) => {
    const response = await createApp().request(
      'https://example.invalid/v1/steam/applications/1001',
      undefined,
      { CATALOG_ACCESS_MODE: mode },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        request_id: response.headers.get('X-Request-ID'),
      },
    });
  },
);
