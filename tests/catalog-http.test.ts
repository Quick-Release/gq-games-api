// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';
import { Catalog, CatalogFailure } from '../src/services/catalog';

const prefix = 'https://catalog.example.invalid/internal/v1/steam/applications';

const successfulCatalog = () =>
  Layer.succeed(Catalog, {
    submitSnapshot: () => Effect.die('not used'),
    acquireAuthorization: (steamAppId: number) =>
      Effect.succeed({
        steam_app_id: steamAppId,
        generation: 'synthetic-generation',
        minimum_observed_at: 90,
        private_diagnostic: 'synthetic-private-diagnostic',
      }),
    inspectPublication: (steamAppId: number) =>
      Effect.succeed({
        steam_app_id: steamAppId,
        state: 'uninitialized' as const,
        generation: null,
        generation_issued_at: null,
        private_diagnostic: 'synthetic-private-diagnostic',
      }),
  });

const fixture = (catalogLayer = successfulCatalog()) => {
  const env = {
    INGESTION_BEARER_TOKEN: crypto.randomUUID(),
    PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
  };
  return { env, catalogLayer, app: createApp({ catalogLayer }) };
};

const expectTransport = (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const id = response.headers.get('x-request-id');
  expect(id).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  return id;
};

const expectError = async (
  response: Response,
  status: number,
  code: string,
) => {
  expect(response.status).toBe(status);
  const requestId = expectTransport(response);
  expect(await response.json()).toEqual({
    error: { code, request_id: requestId },
  });
};

const routes = [
  {
    suffix: 'ingestion-authorization',
    method: 'POST',
    role: 'INGESTION_BEARER_TOKEN',
  },
  {
    suffix: 'publication',
    method: 'GET',
    role: 'PUBLICATION_ADMIN_BEARER_TOKEN',
  },
] as const;

describe('catalog HTTP boundary', () => {
  it('acquires authorization with the ingestion role and a server-owned request ID', async () => {
    const { app, env } = fixture();
    const response = await app.request(
      `${prefix}/1001/ingestion-authorization`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
          'X-Request-ID': 'caller-owned-id',
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    expectTransport(response);
    expect(response.headers.get('x-request-id')).not.toBe('caller-owned-id');
    expect(await response.json()).toEqual({
      data: {
        steam_app_id: 1001,
        generation: 'synthetic-generation',
        minimum_observed_at: 90,
      },
    });
  });

  it('returns uninitialized publication control with explicit nulls only to admin', async () => {
    const { app, env } = fixture();
    const response = await app.request(
      `${prefix}/1001/publication`,
      {
        headers: {
          Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    expectTransport(response);
    expect(await response.json()).toEqual({
      data: {
        steam_app_id: 1001,
        state: 'uninitialized',
        generation: null,
        generation_issued_at: null,
      },
    });
  });

  it.each(routes)(
    'separates roles on $method $suffix',
    async ({ suffix, method, role }) => {
      const { app, env } = fixture();
      const otherRole =
        role === 'INGESTION_BEARER_TOKEN'
          ? 'PUBLICATION_ADMIN_BEARER_TOKEN'
          : 'INGESTION_BEARER_TOKEN';
      const response = await app.request(
        `${prefix}/not-an-id/${suffix}`,
        { method, headers: { Authorization: `Bearer ${env[otherRole]}` } },
        env,
      );
      await expectError(response, 403, 'FORBIDDEN');
    },
  );

  it.each(routes)(
    'rejects missing, unknown, and malformed credentials on $suffix',
    async ({ suffix, method, role }) => {
      const { app, env } = fixture();
      for (const credential of [
        undefined,
        `Bearer ${crypto.randomUUID()}`,
        `Basic ${env[role]}`,
        `Bearer ${env[role]} extra`,
        `Bearer  ${env[role]}`,
      ]) {
        const response = await app.request(
          `${prefix}/not-an-id/${suffix}`,
          { method, headers: credential ? { Authorization: credential } : {} },
          env,
        );
        await expectError(response, 401, 'UNAUTHORIZED');
      }
    },
  );

  it('rotates each role independently without retaining a previous request credential', async () => {
    const { app, env } = fixture();
    let current = env;
    for (const { suffix, method, role } of routes) {
      const rotated = { ...current, [role]: crypto.randomUUID() };
      await expectError(
        await app.request(
          `${prefix}/1001/${suffix}`,
          { method, headers: { Authorization: `Bearer ${current[role]}` } },
          rotated,
        ),
        401,
        'UNAUTHORIZED',
      );
      const response = await app.request(
        `${prefix}/1001/${suffix}`,
        { method, headers: { Authorization: `Bearer ${rotated[role]}` } },
        rotated,
      );
      expect(response.status).toBe(200);
      expectTransport(response);
      const other = role === 'INGESTION_BEARER_TOKEN' ? routes[1] : routes[0];
      const otherResponse = await app.request(
        `${prefix}/1001/${other.suffix}`,
        {
          method: other.method,
          headers: { Authorization: `Bearer ${current[other.role]}` },
        },
        rotated,
      );
      expect(otherResponse.status).toBe(200);
      expectTransport(otherResponse);
      current = rotated;
    }
  });

  it.each(routes)(
    'requires HTTPS with no environment-based bypass on $suffix',
    async ({ suffix, method, role }) => {
      const { app, env, catalogLayer } = fixture();
      const url = `http://localhost/internal/v1/steam/applications/1001/${suffix}`;
      const init = {
        method,
        headers: { Authorization: `Bearer ${env[role]}` },
      };
      for (const config of [
        env,
        { ...env, ALLOW_INSECURE_LOCAL_TEST: 'true', ENVIRONMENT: 'test' },
      ]) {
        await expectError(
          await app.request(url, init, config),
          403,
          'FORBIDDEN',
        );
      }
      const localApp = createApp({
        catalogLayer,
        allowInsecureLocalTest: true,
      });
      const response = await localApp.request(url, init, env);
      expect(response.status).toBe(200);
      expectTransport(response);
    },
  );

  it.each(routes)(
    'validates canonical decimal App IDs on $suffix',
    async ({ suffix, method, role }) => {
      const { app, env } = fixture();
      for (const id of [
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
      ]) {
        const response = await app.request(
          `${prefix}/${id}/${suffix}`,
          { method, headers: { Authorization: `Bearer ${env[role]}` } },
          env,
        );
        await expectError(response, 400, 'INVALID_APP_ID');
      }
      for (const id of ['1', '4294967295']) {
        const response = await app.request(
          `${prefix}/${id}/${suffix}`,
          { method, headers: { Authorization: `Bearer ${env[role]}` } },
          env,
        );
        expect(response.status).toBe(200);
        expectTransport(response);
        expect(await response.json()).toMatchObject({
          data: { steam_app_id: Number(id) },
        });
      }
    },
  );

  it.each(routes)(
    'fails closed with missing, empty, or identical secrets on $suffix',
    async ({ suffix, method, role }) => {
      const { app, env } = fixture();
      const configs = [
        {},
        { ...env, INGESTION_BEARER_TOKEN: undefined },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: undefined },
        { ...env, INGESTION_BEARER_TOKEN: '' },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: '' },
        { ...env, INGESTION_BEARER_TOKEN: 123 },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: env.INGESTION_BEARER_TOKEN },
      ];
      for (const config of configs) {
        const response = await app.request(
          `${prefix}/not-an-id/${suffix}`,
          { method, headers: { Authorization: `Bearer ${env[role]}` } },
          config,
        );
        await expectError(response, 503, 'SERVICE_UNAVAILABLE');
      }
    },
  );

  it.each(routes)(
    'fails closed if the required database binding is missing on $suffix',
    async ({ suffix, method, role }) => {
      const { env } = fixture();
      const response = await createApp().request(
        `${prefix}/1001/${suffix}`,
        { method, headers: { Authorization: `Bearer ${env[role]}` } },
        env,
      );
      await expectError(response, 503, 'SERVICE_UNAVAILABLE');
    },
  );

  it('rejects even whitespace or malformed JSON bodies with a safe bodyless issue', async () => {
    const { app, env } = fixture();
    for (const body of [
      ' ',
      '{',
      JSON.stringify({ token: env.INGESTION_BEARER_TOKEN }),
    ]) {
      const response = await app.request(
        `${prefix}/1001/ingestion-authorization`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
          body,
        },
        env,
      );
      expect(response.status).toBe(422);
      const requestId = expectTransport(response);
      expect(await response.json()).toEqual({
        error: {
          code: 'VALIDATION_FAILED',
          request_id: requestId,
          issues: [{ path: 'body', code: 'BODY_NOT_ALLOWED' }],
        },
      });
    }
  });

  it('accepts an empty body without requiring JSON media headers', async () => {
    const { app, env } = fixture();
    const response = await app.request(
      `${prefix}/1001/ingestion-authorization`,
      {
        method: 'POST',
        headers: { Authorization: `bearer ${env.INGESTION_BEARER_TOKEN}` },
        body: '',
      },
      env,
    );
    expect(response.status).toBe(200);
    expectTransport(response);
  });

  it('cancels after the first nonempty chunk rather than buffering an arbitrary body', async () => {
    const { app, env } = fixture();
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(
          new TextEncoder().encode(env.INGESTION_BEARER_TOKEN),
        );
      },
    );
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
      body,
      duplex: 'half',
    };
    const response = await app.request(
      new Request(`${prefix}/1001/ingestion-authorization`, init),
      undefined,
      env,
    );
    expect(response.status).toBe(422);
    expectTransport(response);
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await response.text()).not.toContain(env.INGESTION_BEARER_TOKEN);
  });

  it('bounds oversized bodies without trusting Content-Length', async () => {
    const { app, env } = fixture();
    for (const contentLength of [undefined, '1']) {
      const headers = new Headers({
        Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
      });
      if (contentLength) headers.set('Content-Length', contentLength);
      const response = await app.request(
        `${prefix}/1001/ingestion-authorization`,
        {
          method: 'POST',
          headers,
          body: new Uint8Array(32 * 1024 + 1),
        },
        env,
      );
      await expectError(response, 413, 'PAYLOAD_TOO_LARGE');
    }
  });

  it('authenticates and checks TLS and IDs before reading any body bytes', async () => {
    const { app, env } = fixture();
    const cases = [
      {
        config: {},
        authorization: env.INGESTION_BEARER_TOKEN,
        id: '1001',
        protocol: 'https:',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      },
      {
        config: env,
        authorization: crypto.randomUUID(),
        id: 'bad',
        protocol: 'https:',
        status: 401,
        code: 'UNAUTHORIZED',
      },
      {
        config: env,
        authorization: env.PUBLICATION_ADMIN_BEARER_TOKEN,
        id: 'bad',
        protocol: 'https:',
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        config: env,
        authorization: env.INGESTION_BEARER_TOKEN,
        id: '1001',
        protocol: 'http:',
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        config: env,
        authorization: env.INGESTION_BEARER_TOKEN,
        id: 'bad',
        protocol: 'https:',
        status: 400,
        code: 'INVALID_APP_ID',
      },
    ];
    for (const testCase of cases) {
      const pull = vi.fn(() => {
        throw new Error('body must not be read');
      });
      const body = new ReadableStream<Uint8Array>(
        { pull },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testCase.authorization}`,
          'Content-Length': '999999',
        },
        body,
        duplex: 'half',
      };
      const request = new Request(
        `${prefix.replace('https:', testCase.protocol)}/${testCase.id}/ingestion-authorization`,
        init,
      );
      await expectError(
        await app.request(request, undefined, testCase.config),
        testCase.status,
        testCase.code,
      );
      expect(pull).not.toHaveBeenCalled();
      await body.cancel();
    }
  });

  it.each(['eligible', 'withdrawn'] as const)(
    'projects only the publication response fields for $0 control',
    async (state) => {
      const catalogLayer = Layer.succeed(Catalog, {
        submitSnapshot: () => Effect.die('not used'),
        acquireAuthorization: () => Effect.die('not used'),
        inspectPublication: (steamAppId: number) =>
          Effect.succeed({
            steam_app_id: steamAppId,
            state,
            generation: 'synthetic-generation',
            generation_issued_at: 90,
            private_diagnostic: 'synthetic-private-diagnostic',
          }),
      });
      const { app, env } = fixture(catalogLayer);
      const response = await app.request(
        `${prefix}/1001/publication`,
        {
          headers: {
            Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          },
        },
        env,
      );
      expect(response.status).toBe(200);
      expectTransport(response);
      expect(await response.json()).toEqual({
        data: {
          steam_app_id: 1001,
          state,
          generation: 'synthetic-generation',
          generation_issued_at: 90,
        },
      });
    },
  );

  it.each(routes)(
    'maps typed failures to safe envelopes on $suffix',
    async ({ suffix, method, role }) => {
      for (const { code, status } of [
        { code: 'PUBLICATION_WITHDRAWN', status: 409 },
        { code: 'SERVICE_UNAVAILABLE', status: 503 },
        { code: 'INTERNAL_SERVER_ERROR', status: 500 },
      ] as const) {
        const failure = Object.assign(new CatalogFailure({ code }), {
          cause: new Error(
            'SQL select private_parameter from synthetic_source',
          ),
        });
        const catalogLayer = Layer.succeed(Catalog, {
          submitSnapshot: () => Effect.die('not used'),
          acquireAuthorization: () => Effect.fail(failure),
          inspectPublication: () => Effect.fail(failure),
        });
        const { app, env } = fixture(catalogLayer);
        const response = await app.request(
          `${prefix}/1001/${suffix}`,
          { method, headers: { Authorization: `Bearer ${env[role]}` } },
          env,
        );
        await expectError(response, status, code);
      }
    },
  );

  it.each(routes)(
    'sanitizes unexpected defects and logs only a fixed diagnostic on $suffix',
    async ({ suffix, method, role }) => {
      const { env } = fixture();
      const diagnostic = `select * from private_table secret=${env[role]} source-content`;
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const defect of [
          new Error(diagnostic),
          { code: 'SERVICE_UNAVAILABLE', diagnostic },
        ]) {
          const catalogLayer = Layer.succeed(Catalog, {
            submitSnapshot: () => Effect.die('not used'),
            acquireAuthorization: () => Effect.die(defect),
            inspectPublication: () => Effect.die(defect),
          });
          const app = createApp({ catalogLayer });
          const response = await app.request(
            `${prefix}/1001/${suffix}`,
            { method, headers: { Authorization: `Bearer ${env[role]}` } },
            env,
          );
          await expectError(response, 500, 'INTERNAL_SERVER_ERROR');
        }
        expect(log.mock.calls).toEqual([
          ['Unhandled API error'],
          ['Unhandled API error'],
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('sanitizes errors thrown while reading the request body', async () => {
    const { app, env } = fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(
              new Error(`private body ${env.INGESTION_BEARER_TOKEN}`),
            );
          },
        },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
        body,
        duplex: 'half',
      };
      const response = await app.request(
        new Request(`${prefix}/1001/ingestion-authorization`, init),
        undefined,
        env,
      );
      await expectError(response, 500, 'INTERNAL_SERVER_ERROR');
      expect(log.mock.calls).toEqual([['Unhandled API error']]);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps unmatched catalog methods and paths no-store with correlated 404s', async () => {
    const { app, env } = fixture();
    const ids = new Set<string | null>();
    for (const { path, method } of [
      { path: '/1001/publication', method: 'PUT' },
      { path: '/1001/ingestion-authorization', method: 'GET' },
      { path: '/1001/snapshot', method: 'GET' },
      { path: '/1001/missing', method: 'GET' },
      { path: '', method: 'GET' },
    ]) {
      const response = await app.request(`${prefix}${path}`, { method }, env);
      await expectError(response, 404, 'NOT_FOUND');
      ids.add(response.headers.get('x-request-id'));
    }
    expect(ids.size).toBe(5);
  });
});
