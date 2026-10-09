// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';
import { Catalog, CatalogFailure } from '../src/services/catalog';

const prefix = 'https://catalog.example.invalid/internal/v1/steam/applications';
const command = () => ({ state: 'withdrawn', expected_generation: null });
const unused = {
  lookupApplication: () => Effect.die('unused'),
  acquireAuthorization: () => Effect.die('unused'),
  inspectPublication: () => Effect.die('unused'),
  submitSnapshot: () => Effect.die('unused'),
};
const successfulCatalog = () => {
  const change = vi.fn((id: number, _input: unknown) =>
    Effect.succeed({
      steam_app_id: id,
      state: 'withdrawn' as const,
      generation: 'synthetic-issued-generation',
      generation_issued_at: 100,
      outcome: 'applied' as const,
      private_diagnostic: 'never-return-this',
    }),
  );
  return {
    change,
    layer: Layer.succeed(Catalog, { ...unused, changePublication: change }),
  };
};
const fixture = (catalogLayer = successfulCatalog().layer) => {
  const env = {
    INGESTION_BEARER_TOKEN: crypto.randomUUID(),
    PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
  };
  const app = createApp({ catalogLayer });
  const put = (
    body: unknown = command(),
    headers: Record<string, string | undefined> = {},
    id = '1001',
    config = env,
  ) => {
    const requestHeaders = new Headers({
      Authorization: `Bearer ${config.PUBLICATION_ADMIN_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Request-ID': 'caller-owned-id',
    });
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) requestHeaders.delete(key);
      else requestHeaders.set(key, value);
    }
    return app.request(
      `${prefix}/${id}/publication`,
      {
        method: 'PUT',
        headers: requestHeaders,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      config,
    );
  };
  return { app, env, put };
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
  const requestId = transport(response);
  const body = Schema.decodeUnknownSync(
    Schema.Struct({
      error: Schema.Struct({
        code: Schema.String,
        request_id: Schema.String,
        issues: Schema.optional(
          Schema.Array(
            Schema.Struct({ path: Schema.String, code: Schema.String }),
          ),
        ),
      }),
    }),
    { onExcessProperty: 'error' },
  )(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.request_id).toBe(requestId);
  if (code !== 'VALIDATION_FAILED') expect(body.error.issues).toBeUndefined();
  if (body.error.issues) {
    expect(body.error.issues.length).toBeLessThanOrEqual(20);
    for (const issue of body.error.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
      expect(['body', 'state', 'expected_generation']).toContain(issue.path);
      expect(issue.code).toMatch(/^[A-Z_]+$/);
    }
  }
  return body.error;
};

// Real Catalog and Database layers, deliberately unavailable persistence. This
// checks application validation through HTTP without importing a validator or
// emulating SQL decisions. A valid command reaches this seam and returns 503;
// an invalid command must fail with 422 before any database access. Neither this
// seam nor the scripted Catalog fixtures establishes D1 atomicity/deletion.
const validationFixture = () => {
  const { env } = fixture();
  const binding = {
    prepare: vi.fn(() => {
      throw new Error('D1_ERROR: Network connection lost.');
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => {
      throw new Error('Sessions must not be used');
    },
  } satisfies D1Database;
  const app = createApp();
  const put = (body: unknown) =>
    app.request(
      `${prefix}/1001/publication`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { ...env, DB: binding },
    );
  return { put, binding };
};

describe('publication command HTTP boundary (not D1 atomicity evidence)', () => {
  it('passes the decoded command and canonical numeric ID to Catalog, projecting only committed fields', async () => {
    const { change, layer } = successfulCatalog();
    const { put } = fixture(layer);
    const response = await put(
      { state: 'withdrawn', expected_generation: 'Opaque Fence é' },
      {
        'X-Publication-Generation': 'irrelevant-snapshot-header',
      },
    );
    expect(response.status).toBe(200);
    transport(response);
    expect(await response.json()).toEqual({
      data: {
        steam_app_id: 1001,
        state: 'withdrawn',
        generation: 'synthetic-issued-generation',
        generation_issued_at: 100,
        outcome: 'applied',
      },
    });
    expect(change).toHaveBeenCalledExactlyOnceWith(1001, {
      state: 'withdrawn',
      expected_generation: 'Opaque Fence é',
    });
  });

  it.each(['eligible', 'withdrawn'] as const)(
    'projects applied and unchanged outcomes for %s, without inspecting later state',
    async (state) => {
      for (const outcome of ['applied', 'unchanged'] as const) {
        const inspect = vi.fn(() =>
          Effect.die('must not reclassify using a later read'),
        );
        const layer = Layer.succeed(Catalog, {
          ...unused,
          inspectPublication: inspect,
          changePublication: (id: number, _input: unknown) =>
            Effect.succeed({
              steam_app_id: id,
              state,
              generation: 'captured-generation',
              generation_issued_at: 90,
              outcome,
              event_id: 'private-event',
              metadata: 'private-content',
              cause: 'private-SQL',
            }),
        });
        const { put } = fixture(layer);
        const response = await put({
          state,
          expected_generation: 'current-generation',
        });
        expect(response.status).toBe(200);
        transport(response);
        expect(await response.json()).toEqual({
          data: {
            steam_app_id: 1001,
            state,
            generation: 'captured-generation',
            generation_issued_at: 90,
            outcome,
          },
        });
        expect(inspect).not.toHaveBeenCalled();
      }
    },
  );

  it('checks configuration, credentials, role, TLS, and canonical IDs before reading or invoking Catalog', async () => {
    const { change, layer } = successfulCatalog();
    const { app, env } = fixture(layer);
    const cases = [
      ...[
        {},
        { ...env, INGESTION_BEARER_TOKEN: undefined },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: undefined },
        { ...env, INGESTION_BEARER_TOKEN: '' },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: '' },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: 123 },
        { ...env, INGESTION_BEARER_TOKEN: 123 },
        { ...env, PUBLICATION_ADMIN_BEARER_TOKEN: env.INGESTION_BEARER_TOKEN },
      ].map((config) => ({
        config,
        authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        protocol: 'https:',
        id: 'bad',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      })),
      ...[
        undefined,
        `Bearer ${crypto.randomUUID()}`,
        `Basic ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN} extra`,
        `Bearer  ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
      ].map((authorization) => ({
        config: env,
        authorization,
        protocol: 'https:',
        id: 'bad',
        status: 401,
        code: 'UNAUTHORIZED',
      })),
      {
        config: env,
        authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
        protocol: 'https:',
        id: 'bad',
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        config: env,
        authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        protocol: 'http:',
        id: '1001',
        status: 403,
        code: 'FORBIDDEN',
      },
      ...[
        '0',
        '01',
        '+1',
        '-1',
        '1e3',
        '1.0',
        '0x1',
        '4294967296',
        '1000000000000000000000',
        'NaN',
        'Infinity',
        '%201',
        '1%20',
        '%091',
        '%EF%BC%91',
      ].map((id) => ({
        config: env,
        authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        protocol: 'https:',
        id,
        status: 400,
        code: 'INVALID_APP_ID',
      })),
    ];
    for (const test of cases) {
      const pull = vi.fn(() => {
        throw new Error('must not read submitted secrets');
      });
      const body = new ReadableStream<Uint8Array>(
        { pull },
        { highWaterMark: 0 },
      );
      const headers = new Headers({
        'Content-Type': 'text/plain',
        'Content-Length': '999999',
      });
      if (test.authorization) headers.set('Authorization', test.authorization);
      const init = { method: 'PUT', headers, body, duplex: 'half' };
      try {
        await error(
          await app.request(
            new Request(
              `${prefix.replace('https:', test.protocol)}/${test.id}/publication`,
              init,
            ),
            undefined,
            test.config,
          ),
          test.status,
          test.code,
        );
        expect(pull).not.toHaveBeenCalled();
      } finally {
        await body.cancel();
      }
    }
    expect(change).not.toHaveBeenCalled();
  });

  it.each(['1', '4294967295'])(
    'accepts canonical boundary ID %s',
    async (id) => {
      const { change, layer } = successfulCatalog();
      const { put } = fixture(layer);
      const response = await put(command(), {}, id);
      expect(response.status).toBe(200);
      transport(response);
      expect(change).toHaveBeenCalledExactlyOnceWith(Number(id), command());
      expect(await response.json()).toMatchObject({
        data: { steam_app_id: Number(id) },
      });
    },
  );

  it('allows insecure local transport only through the explicit code-only test option', async () => {
    const { layer } = successfulCatalog();
    const { env } = fixture(layer);
    const url =
      'http://localhost/internal/v1/steam/applications/1001/publication';
    const init = {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command()),
    };
    await error(
      await createApp({ catalogLayer: layer }).request(url, init, {
        ...env,
        ALLOW_INSECURE_LOCAL_TEST: 'true',
        ENVIRONMENT: 'test',
      }),
      403,
      'FORBIDDEN',
    );
    const response = await createApp({
      catalogLayer: layer,
      allowInsecureLocalTest: true,
    }).request(url, init, env);
    expect(response.status).toBe(200);
    transport(response);
  });

  it('rotates admin and ingestion credentials independently on the same app without retaining old credentials', async () => {
    const { put, env } = fixture();
    const before = await put();
    expect(before.status).toBe(200);
    transport(before);
    const adminRotated = {
      ...env,
      PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
    };
    await error(
      await put(
        command(),
        { Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}` },
        '1001',
        adminRotated,
      ),
      401,
      'UNAUTHORIZED',
    );
    expect(
      (
        await put(
          command(),
          {
            Authorization: `bearer ${adminRotated.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          },
          '1001',
          adminRotated,
        )
      ).status,
    ).toBe(200);
    await error(
      await put(
        command(),
        { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
        '1001',
        adminRotated,
      ),
      403,
      'FORBIDDEN',
    );
    const ingestionRotated = {
      ...adminRotated,
      INGESTION_BEARER_TOKEN: crypto.randomUUID(),
    };
    const response = await put(command(), {}, '1001', ingestionRotated);
    expect(response.status).toBe(200);
    transport(response);
    await error(
      await put(
        command(),
        { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
        '1001',
        ingestionRotated,
      ),
      401,
      'UNAUTHORIZED',
    );
    await error(
      await put(
        command(),
        { Authorization: `Bearer ${ingestionRotated.INGESTION_BEARER_TOKEN}` },
        '1001',
        ingestionRotated,
      ),
      403,
      'FORBIDDEN',
    );
  });

  it('fails safely if the database binding is missing', async () => {
    const { env } = fixture();
    await error(
      await createApp().request(
        `${prefix}/1001/publication`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(command()),
        },
        env,
      ),
      503,
      'SERVICE_UNAVAILABLE',
    );
  });

  it('rejects unsupported media and encodings before reading any bytes', async () => {
    const { change, layer } = successfulCatalog();
    const { app, env } = fixture(layer);
    for (const overrides of [
      { 'Content-Type': undefined },
      { 'Content-Type': '' },
      { 'Content-Type': 'text/json' },
      { 'Content-Type': 'application/json; charset=iso-8859-1' },
      { 'Content-Type': 'application/json; profile=secret' },
      { 'Content-Encoding': 'gzip' },
      { 'Content-Encoding': 'br' },
    ]) {
      const headers = new Headers({
        Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      });
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) headers.delete(key);
        else headers.set(key, value);
      }
      const pull = vi.fn(() => {
        throw new Error('unsupported content must not be read');
      });
      const body = new ReadableStream<Uint8Array>(
        { pull },
        { highWaterMark: 0 },
      );
      const init = { method: 'PUT', headers, body, duplex: 'half' };
      try {
        await error(
          await app.request(
            new Request(`${prefix}/1001/publication`, init),
            undefined,
            env,
          ),
          415,
          'UNSUPPORTED_MEDIA_TYPE',
        );
        expect(pull).not.toHaveBeenCalled();
      } finally {
        await body.cancel();
      }
    }
    expect(change).not.toHaveBeenCalled();
  });

  it('accepts UTF-8 JSON media variants and uncompressed identity encoding', async () => {
    const { put } = fixture();
    for (const media of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON; charset="UTF-8"',
    ]) {
      const response = await put(command(), {
        'Content-Type': media,
        'Content-Encoding': 'identity',
      });
      expect(response.status).toBe(200);
      transport(response);
    }
  });

  it('distinguishes malformed JSON and invalid UTF-8 without invoking Catalog', async () => {
    const { change, layer } = successfulCatalog();
    const { app, env, put } = fixture(layer);
    for (const body of ['', '{', '[', 'true trailing'])
      await error(await put(body), 400, 'INVALID_JSON');
    for (const bytes of [
      new Uint8Array([0xff]),
      new Uint8Array([0x22, 0xc3, 0x28, 0x22]),
    ]) {
      await error(
        await app.request(
          `${prefix}/1001/publication`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: bytes,
          },
          env,
        ),
        400,
        'INVALID_JSON',
      );
    }
    expect(change).not.toHaveBeenCalled();
  });

  it('enforces the actual 32 KiB byte limit with absent, understated, and overstated Content-Length', async () => {
    const { change, layer } = successfulCatalog();
    const { put } = fixture(layer);
    const valid = JSON.stringify(command());
    const exact =
      valid + ' '.repeat(32768 - new TextEncoder().encode(valid).length);
    for (const headers of [
      {},
      { 'Content-Length': '1' },
      { 'Content-Length': '999999' },
    ]) {
      const response = await put(exact, headers);
      expect(response.status).toBe(200);
      transport(response);
    }
    expect(change).toHaveBeenCalledTimes(3);
    for (const headers of [{}, { 'Content-Length': '1' }])
      await error(await put(exact + ' ', headers), 413, 'PAYLOAD_TOO_LARGE');
    // UTF-8 byte limits, not JavaScript code-unit or code-point counts.
    await error(await put(valid + '😀'.repeat(9000)), 413, 'PAYLOAD_TOO_LARGE');
    expect(change).toHaveBeenCalledTimes(3);
  });

  it('stops and cancels oversized default streams, including an arbitrary-size first chunk', async () => {
    const { change, layer } = successfulCatalog();
    const { app, env } = fixture(layer);
    for (const chunkSize of [1024, 1024 * 1024]) {
      let pulls = 0;
      const cancel = vi.fn(() =>
        Promise.reject(
          new Error(`cancel secret ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`),
        ),
      );
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(chunkSize).fill(32));
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': '1',
        },
        body,
        duplex: 'half',
      };
      await error(
        await app.request(
          new Request(`${prefix}/1001/publication`, init),
          undefined,
          env,
        ),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      expect(pulls).toBe(chunkSize === 1024 ? 33 : 1);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    }
    expect(change).not.toHaveBeenCalled();
  });

  it('bounds native byte reads to one overflow probe and never waits for or leaks cancellation failure', async () => {
    const { change, layer } = successfulCatalog();
    const { app, env } = fixture(layer);
    for (const cancellation of ['reject', 'pending'] as const) {
      let consumed = 0;
      const cancel = vi.fn(() =>
        cancellation === 'reject'
          ? Promise.reject(
              new Error(
                `cancel SQL secret ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
              ),
            )
          : new Promise<void>(() => {}),
      );
      const body = new ReadableStream({
        type: 'bytes',
        pull(controller) {
          const request = controller.byobRequest;
          if (!request?.view) throw new Error('Expected bounded byte reader');
          const view = new Uint8Array(
            request.view.buffer,
            request.view.byteOffset,
            request.view.byteLength,
          );
          consumed += view.length;
          view.fill(32);
          request.respond(view.length);
        },
        cancel,
      });
      const init = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        duplex: 'half',
      };
      await error(
        await app.request(
          new Request(`${prefix}/1001/publication`, init),
          undefined,
          env,
        ),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      expect(consumed).toBe(32769);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    }
    expect(change).not.toHaveBeenCalled();
  });

  it.each([null, true, [], 1, 'string'])(
    'requires a JSON object through real Catalog validation: %j',
    async (body) => {
      const { put, binding } = validationFixture();
      const result = await error(await put(body), 422, 'VALIDATION_FAILED');
      expect(result.issues).toEqual([{ path: 'body', code: 'INVALID_TYPE' }]);
      expect(binding.prepare).not.toHaveBeenCalled();
    },
  );

  it('requires exactly state and expected_generation, reporting safe paths rather than arbitrary submitted keys or values', async () => {
    const { put, binding } = validationFixture();
    for (const [body, path] of [
      [{ expected_generation: null }, 'state'],
      [{ state: 'eligible' }, 'expected_generation'],
    ] as const) {
      const result = await error(await put(body), 422, 'VALIDATION_FAILED');
      expect(result.issues).toEqual([{ path, code: 'REQUIRED' }]);
    }
    for (const key of [
      'steam_app_id',
      'generation',
      'generation_issued_at',
      'reason',
      'metadata',
      'event_id',
      'players',
      'reviews',
      'prices',
      '__proto__',
      'constructor',
      'secret-submitted-key',
    ]) {
      const result = await error(
        await put({ ...command(), [key]: 'secret-submitted-value' }),
        422,
        'VALIDATION_FAILED',
      );
      expect(result.issues).toEqual([{ path: 'body', code: 'UNKNOWN_FIELD' }]);
      expect(JSON.stringify(result)).not.toContain('secret-submitted');
    }
    const result = await error(
      await put({
        state: 'secret-invalid-state',
        expected_generation: { 'secret-nested-key': 'secret-value' },
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            `secret-key-${i}`,
            'secret-value',
          ]),
        ),
      }),
      422,
      'VALIDATION_FAILED',
    );
    expect(result.issues).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('admits only the two publication states, not uninitialized, coercions, or whitespace normalization', async () => {
    const { put, binding } = validationFixture();
    for (const state of [
      'uninitialized',
      'Eligible',
      'WITHDRAWN',
      ' eligible',
      'withdrawn ',
      '',
      'secret-state',
      null,
      1,
      true,
      {},
      [],
    ]) {
      const result = await error(
        await put({ state, expected_generation: null }),
        422,
        'VALIDATION_FAILED',
      );
      expect(result.issues).toEqual([
        {
          path: 'state',
          code: typeof state === 'string' ? 'INVALID_VALUE' : 'INVALID_TYPE',
        },
      ]);
    }
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('validates expected_generation as null or a nonblank bounded opaque string with stable safe codes', async () => {
    const { put, binding } = validationFixture();
    for (const [expected_generation, code] of [
      ['', 'BLANK_STRING'],
      [' \t\n', 'BLANK_STRING'],
      ['\tvalue', 'EDGE_WHITESPACE'],
      ['value\n', 'EDGE_WHITESPACE'],
      [' value', 'EDGE_WHITESPACE'],
      ['value\u00a0', 'EDGE_WHITESPACE'],
      ['x'.repeat(129), 'STRING_TOO_LONG'],
      ['😀'.repeat(129), 'STRING_TOO_LONG'],
      [1, 'INVALID_TYPE'],
      [true, 'INVALID_TYPE'],
      [[], 'INVALID_TYPE'],
      [{ value: 'secret-generation' }, 'INVALID_TYPE'],
    ] as const) {
      const result = await error(
        await put({ state: 'withdrawn', expected_generation }),
        422,
        'VALIDATION_FAILED',
      );
      expect(result.issues).toEqual([{ path: 'expected_generation', code }]);
      expect(JSON.stringify(result)).not.toContain('secret-generation');
    }
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('accepts null, non-UUID opaque syntax, internal whitespace, Unicode spelling, and exact code-point bounds up to persistence', async () => {
    const { put, binding } = validationFixture();
    for (const state of ['eligible', 'withdrawn']) {
      for (const expected_generation of [
        null,
        'not-a-uuid',
        'Opaque Fence é',
        'é',
        'x'.repeat(128),
        '😀'.repeat(128),
      ]) {
        // Deliberately unavailable database proves this passed real application
        // validation; successful SQL semantics are reserved for workerd tests.
        await error(
          await put({ state, expected_generation }),
          503,
          'SERVICE_UNAVAILABLE',
        );
      }
    }
    expect(binding.prepare).toHaveBeenCalled();
  });

  it('sanitizes permanent and unknown native SQL failures as 500 rather than retryable unavailability', async () => {
    const { env } = fixture();
    for (const diagnostic of [
      'D1_ERROR: no such table: private_table',
      'D1_ERROR: CHECK constraint failed: private_constraint',
      `unknown SQL error ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
    ]) {
      const binding = {
        prepare() {
          throw new Error(diagnostic);
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
        withSession() {
          throw new Error('Sessions must not be used');
        },
      } satisfies D1Database;
      await error(
        await createApp().request(
          `${prefix}/1001/publication`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(command()),
          },
          { ...env, DB: binding },
        ),
        500,
        'INTERNAL_SERVER_ERROR',
      );
    }
  });

  it('maps generation mismatch and safe application failures without disclosing causes or current generations', async () => {
    for (const [code, status] of [
      ['PUBLICATION_GENERATION_MISMATCH', 409],
      ['VALIDATION_FAILED', 422],
      ['SERVICE_UNAVAILABLE', 503],
      ['INTERNAL_SERVER_ERROR', 500],
    ] as const) {
      const { env } = fixture();
      const failure = Object.assign(new CatalogFailure({ code }), {
        cause: new Error(
          `SQL private parameters source-content ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        ),
        generation: 'private-current-generation',
      });
      const { put } = fixture(
        Layer.succeed(Catalog, {
          ...unused,
          changePublication: () => Effect.fail(failure),
        }),
      );
      await error(
        await put({
          state: 'withdrawn',
          expected_generation: 'stale-generation',
        }),
        status,
        code,
      );
    }
  });

  it('waits for the application operation to complete before returning success', async () => {
    let complete: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const started = vi.fn();
    const { put } = fixture(
      Layer.succeed(Catalog, {
        ...unused,
        changePublication: () =>
          Effect.promise(async () => {
            started();
            await committed;
            return {
              steam_app_id: 1001,
              state: 'withdrawn' as const,
              generation: 'committed-generation',
              generation_issued_at: 100,
              outcome: 'applied' as const,
            };
          }),
      }),
    );
    let returned = false;
    const pending = Promise.resolve(put()).then((response) => {
      returned = true;
      return response;
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    complete?.();
    const response = await pending;
    expect(response.status).toBe(200);
    transport(response);
  });

  it('sanitizes defects, thrown service calls, and request-read failures with fixed diagnostics', async () => {
    const { env } = fixture();
    const diagnostic = `SQL parameters source-content ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const changePublication of [
        () => Effect.die(new Error(diagnostic)),
        () => Effect.die({ code: 'SERVICE_UNAVAILABLE', diagnostic }),
        () => {
          throw new Error(diagnostic);
        },
      ]) {
        const { put } = fixture(
          Layer.succeed(Catalog, { ...unused, changePublication }),
        );
        await error(await put(), 500, 'INTERNAL_SERVER_ERROR');
      }
      const { change, layer } = successfulCatalog();
      const app = createApp({ catalogLayer: layer });
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(new Error(diagnostic));
          },
        },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        duplex: 'half',
      };
      await error(
        await app.request(
          new Request(`${prefix}/1001/publication`, init),
          undefined,
          env,
        ),
        500,
        'INTERNAL_SERVER_ERROR',
      );
      expect(change).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual(
        Array.from({ length: 4 }, () => ['Unhandled API error']),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('reconciles a simulated lost successful response through admin GET rather than blindly adopting its generation', async () => {
    // Script the application decision, not a second implementation of its
    // state machine. Workerd tests own actual fencing and persistent state.
    const committed = {
      steam_app_id: 1001,
      state: 'withdrawn' as const,
      generation: 'generation-after-withdrawal',
      generation_issued_at: 100,
    };
    const change = vi
      .fn<
        (
          id: number,
          input: unknown,
        ) => Effect.Effect<
          typeof committed & { outcome: 'applied' | 'unchanged' },
          CatalogFailure
        >
      >()
      .mockReturnValueOnce(Effect.succeed({ ...committed, outcome: 'applied' }))
      .mockReturnValueOnce(
        Effect.fail(
          new CatalogFailure({ code: 'PUBLICATION_GENERATION_MISMATCH' }),
        ),
      );
    const inspect = vi.fn(() =>
      Effect.succeed({ ...committed, private_diagnostic: 'private-content' }),
    );
    const { put, app, env } = fixture(
      Layer.succeed(Catalog, {
        ...unused,
        inspectPublication: inspect,
        changePublication: change,
      }),
    );
    const original = {
      state: 'withdrawn',
      expected_generation: 'generation-before-withdrawal',
    };
    const loseResponse = async () => {
      const response = await put(original);
      expect(response.status).toBe(200);
      // The client never receives/decodes the committed response.
      throw new Error('synthetic transport disconnected after commit');
    };
    await expect(loseResponse()).rejects.toThrow(
      'synthetic transport disconnected after commit',
    );
    const response = await app.request(
      `${prefix}/1001/publication`,
      {
        headers: {
          Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
          'X-Request-ID': 'caller-owned-id',
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    transport(response);
    expect(await response.json()).toEqual({
      data: {
        steam_app_id: 1001,
        state: 'withdrawn',
        generation: 'generation-after-withdrawal',
        generation_issued_at: 100,
      },
    });
    expect(change).toHaveBeenCalledOnce();
    // Replaying the OLD expectation is a conflict even though desired state
    // now matches. Inspection is not permission to silently rebase a command.
    await error(await put(original), 409, 'PUBLICATION_GENERATION_MISMATCH');
    expect(change).toHaveBeenNthCalledWith(1, 1001, original);
    expect(change).toHaveBeenNthCalledWith(2, 1001, original);
    expect(inspect).toHaveBeenCalledOnce();
  });
});
