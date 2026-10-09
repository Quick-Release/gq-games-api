// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';
import { Catalog, CatalogFailure } from '../src/services/catalog';

const prefix = 'https://catalog.example.invalid/v1/steam/applications';
// Independent public expectations, not projections of a submitted/internal row.
const examples = [
  {
    steam_app_id: 1001,
    metadata: {
      title: 'Synthetic Café Game',
      product_type: 'game',
      base_app_id: null,
      developers: ['Synthetic Developer B', 'Synthetic Developer A'],
      publishers: ['Synthetic Publisher B', 'Synthetic Publisher A'],
      supported_os: ['linux', 'macos', 'windows'],
      release: {
        status: 'upcoming',
        date: { kind: 'exact', date: '2000-02-29' },
      },
    },
    provenance: {
      source_url: 'https://catalog.example.invalid/apps/1001',
      language: 'en',
      observed_at: 100,
    },
  },
  {
    steam_app_id: 1002,
    metadata: {
      title: 'Synthetic Demo',
      product_type: 'demo',
      base_app_id: 4294967295,
      developers: null,
      publishers: [],
      supported_os: [],
      release: {
        status: 'released',
        date: { kind: 'window', window: 'Q4 2030' },
      },
    },
    provenance: {
      source_url: 'https://catalog.example.invalid/apps/1002',
      language: 'en',
      observed_at: 101,
    },
  },
  {
    steam_app_id: 1003,
    metadata: {
      title: 'Synthetic DLC',
      product_type: 'dlc',
      base_app_id: null,
      developers: [],
      publishers: null,
      supported_os: null,
      release: { status: 'unknown', date: { kind: 'unknown' } },
    },
    provenance: {
      source_url: 'https://catalog.example.invalid/apps/1003',
      language: 'en',
      observed_at: 102,
    },
  },
] as const;

const privateFields = {
  event_id: 'synthetic-private-delivery',
  extractor_version: 'synthetic-private-extractor',
  generation: 'synthetic-private-generation',
  publication_generation: 'synthetic-private-generation',
  state: 'withdrawn',
  generation_issued_at: 99,
  publication_state: 'withdrawn',
  publication_timestamp: 99,
  credentials: 'synthetic-private-credential',
  withdrawal_reason: 'synthetic-private-reason',
  sql: 'select private_column from private_table',
  cause: 'synthetic-driver-cause',
};

const unused = {
  changePublication: () => Effect.die('unused'),
  acquireAuthorization: () => Effect.die('unused'),
  inspectPublication: () => Effect.die('unused'),
  submitSnapshot: () => Effect.die('unused'),
};
const fixture = (example: (typeof examples)[number] = examples[0]) => {
  const lookup = vi.fn((id: number) =>
    Effect.succeed({
      ...example,
      steam_app_id: id,
      ...privateFields,
      metadata: {
        ...example.metadata,
        ...privateFields,
        release: {
          ...example.metadata.release,
          ...privateFields,
          date: { ...example.metadata.release.date, ...privateFields },
        },
      },
      provenance: { ...example.provenance, ...privateFields },
    }),
  );
  return {
    lookup,
    app: createApp({
      catalogLayer: Layer.succeed(Catalog, {
        ...unused,
        lookupApplication: lookup,
      }),
    }),
  };
};
const transport = (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const requestId = response.headers.get('x-request-id');
  expect(requestId).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  expect(requestId).not.toBe('caller-owned-id');
  return requestId;
};
const error = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    error: { code, request_id: transport(response) },
  });
};

describe('anonymous Steam Application lookup HTTP boundary', () => {
  it.each(examples)(
    'returns the complete public representation for $metadata.product_type without private fields',
    async (example) => {
      const { app, lookup } = fixture(example);
      const response = await app.request(`${prefix}/${example.steam_app_id}`, {
        headers: { 'X-Request-ID': 'caller-owned-id' },
      });
      expect(response.status).toBe(200);
      transport(response);
      expect(await response.json()).toEqual({ data: example });
      expect(lookup).toHaveBeenCalledExactlyOnceWith(example.steam_app_id);
    },
  );

  it('needs neither private configuration, bearer credential, nor generation and never fetches an upstream', async () => {
    const { app } = fixture();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no source fetch allowed'));
    try {
      for (const headers of [
        new Headers(),
        new Headers({
          Authorization: 'Bearer irrelevant',
          'X-Publication-Generation': 'irrelevant',
        }),
      ]) {
        const response = await app.request(`${prefix}/1001`, { headers }, {});
        expect(response.status).toBe(200);
        transport(response);
        expect(await response.json()).toEqual({ data: examples[0] });
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it.each([
    '0',
    '01',
    '+1',
    '-1',
    '1.0',
    '1e3',
    '0x1',
    '4294967296',
    '1000000000000000000000',
    'NaN',
    'Infinity',
    '%201',
    '1%20',
    '%091',
    '%EF%BC%91',
  ])('rejects malformed identifier %s before calling Catalog', async (id) => {
    const { app, lookup } = fixture();
    await error(await app.request(`${prefix}/${id}`), 400, 'INVALID_APP_ID');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([1, 4294967295])(
    'accepts the canonical boundary identifier %s',
    async (id) => {
      const { app, lookup } = fixture();
      const response = await app.request(`${prefix}/${id}`);
      expect(response.status).toBe(200);
      transport(response);
      expect(await response.json()).toEqual({
        data: { ...examples[0], steam_app_id: id },
      });
      expect(lookup).toHaveBeenCalledExactlyOnceWith(id);
    },
  );

  it.each([
    ['NOT_FOUND', 404],
    ['SERVICE_UNAVAILABLE', 503],
    ['INTERNAL_SERVER_ERROR', 500],
  ] as const)(
    'maps %s without exposing private causes or issues',
    async (code, status) => {
      const failure = Object.assign(
        new CatalogFailure({ code }),
        privateFields,
      );
      const app = createApp({
        catalogLayer: Layer.succeed(Catalog, {
          ...unused,
          lookupApplication: () => Effect.fail(failure),
        }),
      });
      await error(
        await app.request(`${prefix}/1001`, {
          headers: { 'X-Request-ID': 'caller-owned-id' },
        }),
        status,
        code,
      );
    },
  );

  it('sanitizes unexpected defects and thrown operations with fixed diagnostics', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const lookupApplication of [
        () => Effect.die(new Error(JSON.stringify(privateFields))),
        () => Effect.die({ code: 'NOT_FOUND', ...privateFields }),
        () => {
          throw new Error(JSON.stringify(privateFields));
        },
      ]) {
        const app = createApp({
          catalogLayer: Layer.succeed(Catalog, {
            ...unused,
            lookupApplication,
          }),
        });
        await error(
          await app.request(`${prefix}/1001`),
          500,
          'INTERNAL_SERVER_ERROR',
        );
      }
      expect(log.mock.calls).toEqual(
        Array.from({ length: 3 }, () => ['Unhandled API error']),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('returns safe temporary failure when primary D1 is unavailable without requiring private secrets', async () => {
    await error(
      await createApp().request(`${prefix}/1001`, undefined, {}),
      503,
      'SERVICE_UNAVAILABLE',
    );
  });

  it.each([
    ['D1_ERROR: Network connection lost.', 503, 'SERVICE_UNAVAILABLE'],
    [
      'D1_ERROR: D1 DB reset because its code was updated.',
      503,
      'SERVICE_UNAVAILABLE',
    ],
    [
      'D1_ERROR: D1 DB is overloaded. Too many requests queued.',
      503,
      'SERVICE_UNAVAILABLE',
    ],
    [
      'D1_ERROR: no such column: steam_application_snapshot.title: SQLITE_ERROR',
      500,
      'INTERNAL_SERVER_ERROR',
    ],
    ['D1_TYPE_ERROR: private parameter', 500, 'INTERNAL_SERVER_ERROR'],
    ['synthetic unexpected driver failure', 500, 'INTERNAL_SERVER_ERROR'],
  ] as const)(
    'classifies driver failure safely through real Catalog/Database layers: %s',
    async (message, status, code) => {
      // Node checks pinned driver error wrapping, not Cloudflare outage behavior.
      const binding = {
        prepare: vi.fn(() => {
          throw new Error(message);
        }),
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
        withSession: () => {
          throw new Error('Sessions must not be used');
        },
      } satisfies D1Database;
      await error(
        await createApp().request(`${prefix}/1001`, undefined, { DB: binding }),
        status,
        code,
      );
      expect(binding.prepare).toHaveBeenCalledOnce();
    },
  );

  it('uses no-store and distinct server IDs even for unmatched public methods and paths', async () => {
    const { app } = fixture();
    const ids = new Set<string | null>();
    for (const [path, method] of [
      ['', 'GET'],
      ['/1001', 'PUT'],
      ['/1001/missing', 'GET'],
    ]) {
      const response = await app.request(`${prefix}${path}`, { method });
      await error(response, 404, 'NOT_FOUND');
      ids.add(response.headers.get('x-request-id'));
    }
    expect(ids.size).toBe(3);
  });
});
