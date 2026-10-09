// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Clock, Effect, Layer, Schema } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';
import { Catalog, CatalogFailure } from '../src/services/catalog';
import { validateSnapshot, type Snapshot } from '../src/services/snapshot';

const prefix = 'https://catalog.example.invalid/internal/v1/steam/applications';
const now = 1_700_000_000;
const policy = JSON.stringify([
  {
    source_url: 'https://catalog.example.invalid/apps/1001',
    extractor_version: 'synthetic-v1',
  },
]);
const snapshot = () => ({
  event_id: 'synthetic-delivery',
  metadata: {
    title: 'Synthetic Demo',
    product_type: 'demo',
    base_app_id: 2001,
    developers: ['Synthetic Developer'],
    publishers: null,
    supported_os: ['windows', 'linux'],
    release: {
      status: 'upcoming',
      date: { kind: 'window', window: 'Q4 2030' },
    },
  },
  provenance: {
    source_url: 'https://catalog.example.invalid/apps/1001',
    language: 'en',
    observed_at: now,
    extractor_version: 'synthetic-v1',
  },
});

const fixture = () => {
  const accepted = vi.fn<(value: Snapshot) => void>();
  const env = {
    INGESTION_BEARER_TOKEN: crypto.randomUUID(),
    PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
    APPROVED_SNAPSHOT_SOURCES: policy,
  };
  const catalogLayer = Layer.succeed(Catalog, {
    lookupApplication: () => Effect.die('unused'),
    acquireAuthorization: () => Effect.die('unused'),
    inspectPublication: () => Effect.die('unused'),
    submitSnapshot: (
      id: number,
      generation: unknown,
      input: unknown,
      sources: unknown,
    ) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const decoded = yield* validateSnapshot(
          id,
          generation,
          input,
          sources,
        ).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillisUnsafe: () => now * 1000,
            currentTimeMillis: Effect.succeed(now * 1000),
            currentTimeNanosUnsafe: clock.currentTimeNanosUnsafe.bind(clock),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe:
              clock.monotonicTimeNanosUnsafe.bind(clock),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: clock.sleep.bind(clock),
          }),
        );
        accepted(decoded);
        return {
          steam_app_id: id,
          outcome: 'applied' as const,
          current_observed_at: decoded.provenance.observed_at,
          private_diagnostic: 'never-return-this',
        };
      }),
  });
  const app = createApp({ catalogLayer });
  const put = (
    body: unknown = snapshot(),
    headers: Record<string, string | undefined> = {},
    id = '1001',
    config = env,
  ) => {
    const requestHeaders = new Headers({
      Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Publication-Generation': 'synthetic-generation',
    });
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) requestHeaders.delete(key);
      else requestHeaders.set(key, value);
    }
    return app.request(
      `${prefix}/${id}/snapshot`,
      {
        method: 'PUT',
        headers: requestHeaders,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      config,
    );
  };
  return { app, env, accepted, put };
};

const error = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const requestId = response.headers.get('x-request-id');
  expect(requestId).toBeTruthy();
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
  expect(Object.keys(body.error).sort()).toEqual(
    body.error.issues
      ? ['code', 'issues', 'request_id']
      : ['code', 'request_id'],
  );
  return body.error;
};

describe('complete snapshot HTTP boundary (not D1 atomicity evidence)', () => {
  it('validates the complete snapshot and projects only the committed response', async () => {
    const { put, accepted } = fixture();
    const response = await put(snapshot(), { 'X-Request-ID': 'caller-owned' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).not.toBe('caller-owned');
    expect(await response.json()).toEqual({
      data: {
        steam_app_id: 1001,
        outcome: 'applied',
        current_observed_at: now,
      },
    });
    expect(accepted.mock.calls[0]?.[0].metadata.supported_os).toEqual([
      'linux',
      'windows',
    ]);
  });

  it('enforces ingestion role, secret configuration, HTTPS, and canonical route IDs before reading', async () => {
    const { app, env, accepted } = fixture();
    for (const test of [
      {
        config: {},
        token: env.INGESTION_BEARER_TOKEN,
        protocol: 'https:',
        id: 'bad',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      },
      {
        config: env,
        token: crypto.randomUUID(),
        protocol: 'https:',
        id: 'bad',
        status: 401,
        code: 'UNAUTHORIZED',
      },
      {
        config: env,
        token: env.PUBLICATION_ADMIN_BEARER_TOKEN,
        protocol: 'https:',
        id: 'bad',
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        config: env,
        token: env.INGESTION_BEARER_TOKEN,
        protocol: 'http:',
        id: '1001',
        status: 403,
        code: 'FORBIDDEN',
      },
      ...['0', '01', '+1', '1e3', '1.0', '4294967296', '%201'].map((id) => ({
        config: env,
        token: env.INGESTION_BEARER_TOKEN,
        protocol: 'https:',
        id,
        status: 400,
        code: 'INVALID_APP_ID',
      })),
    ]) {
      const pull = vi.fn(() => {
        throw new Error('must not read submitted secret');
      });
      const body = new ReadableStream<Uint8Array>(
        { pull },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'PUT',
        headers: { Authorization: `Bearer ${test.token}` },
        body,
        duplex: 'half',
      };
      const request = new Request(
        `${prefix.replace('https:', test.protocol)}/${test.id}/snapshot`,
        init,
      );
      await error(
        await app.request(request, undefined, test.config),
        test.status,
        test.code,
      );
      expect(pull).not.toHaveBeenCalled();
      await body.cancel();
    }
    expect(accepted).not.toHaveBeenCalled();
  });

  it('distinguishes media/encoding, malformed JSON, invalid UTF-8, and payload shape', async () => {
    const { put, accepted } = fixture();
    for (const headers of [
      { 'Content-Type': '' },
      { 'Content-Type': 'text/json' },
      { 'Content-Type': 'application/json; charset=iso-8859-1' },
      { 'Content-Encoding': 'gzip' },
      { 'Content-Encoding': 'br' },
    ])
      await error(await put('{', headers), 415, 'UNSUPPORTED_MEDIA_TYPE');
    for (const body of ['', '{', '[', 'true trailing'])
      await error(await put(body), 400, 'INVALID_JSON');
    for (const body of ['null', 'true', '[]', '1', '"string"'])
      await error(await put(body), 422, 'VALIDATION_FAILED');
    const { app, env } = fixture();
    await error(
      await app.request(
        `${prefix}/1001/snapshot`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: new Uint8Array([0xff]),
        },
        env,
      ),
      400,
      'INVALID_JSON',
    );
    expect(accepted).not.toHaveBeenCalled();
  });

  it('bounds actual bytes, not Content-Length, and cancels streamed oversized input', async () => {
    const { put, app, env } = fixture();
    const valid = JSON.stringify(snapshot());
    const exact =
      valid + ' '.repeat(32768 - new TextEncoder().encode(valid).length);
    expect((await put(exact)).status).toBe(200);
    // Even a misleading large length does not replace the actual-byte decision.
    expect((await put(valid, { 'Content-Length': '999999' })).status).toBe(200);
    for (const headers of [{}, { 'Content-Length': '1' }])
      await error(await put(exact + ' ', headers), 413, 'PAYLOAD_TOO_LARGE');
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024).fill(32));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const init = {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': '1',
      },
      body,
      duplex: 'half',
    };
    await error(
      await app.request(
        new Request(`${prefix}/1001/snapshot`, init),
        undefined,
        env,
      ),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    expect(pulls).toBe(33);
    expect(cancel).toHaveBeenCalledOnce();
    const unicode = valid + '😀'.repeat(9000);
    await error(await put(unicode), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('bounds native byte-stream reads to the overflow probe and never awaits or leaks cancellation failures', async () => {
    const { app, env, accepted } = fixture();
    for (const cancellation of ['reject', 'pending'] as const) {
      let consumed = 0;
      const cancel = vi.fn(() =>
        cancellation === 'reject'
          ? Promise.reject(
              new Error(`cancel secret ${env.INGESTION_BEARER_TOKEN}`),
            )
          : new Promise<void>(() => {}),
      );
      const body = new ReadableStream({
        type: 'bytes',
        pull(controller) {
          const request = controller.byobRequest;
          if (!request?.view) throw new Error('Expected a bounded byte reader');
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
          Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        duplex: 'half',
      };
      await error(
        await app.request(
          new Request(`${prefix}/1001/snapshot`, init),
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
    // A code-supplied default stream can deliver one arbitrary-size chunk, but
    // the application must reject it immediately and never retain/copy it.
    const cancel = vi.fn(() =>
      Promise.reject(new Error('cancel source content')),
    );
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const init = {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
      duplex: 'half',
    };
    await error(
      await app.request(
        new Request(`${prefix}/1001/snapshot`, init),
        undefined,
        env,
      ),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
  });

  it('requires every field and explicit nulls, rejecting arbitrary and excluded keys safely at every level', async () => {
    const { put, accepted } = fixture();
    const original = snapshot();
    const objects = [
      original,
      original.metadata,
      original.metadata.release,
      original.metadata.release.date,
      original.provenance,
    ];
    const locations = [
      '',
      'metadata',
      'metadata.release',
      'metadata.release.date',
      'provenance',
    ];
    for (const [index, object] of objects.entries()) {
      const at = (value: Record<string, unknown>) => {
        const result = JSON.parse(JSON.stringify(snapshot()));
        if (!index) return value;
        const keys = locations[index]?.split('.') ?? [];
        let target = result;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys.at(-1) ?? ''] = value;
        return result;
      };
      for (const key of Object.keys(object)) {
        const copy: Record<string, unknown> = { ...object };
        delete copy[key];
        await error(await put(at(copy)), 422, 'VALIDATION_FAILED');
      }
      for (const key of [
        'secret-submitted-key',
        'players',
        'reviews',
        'prices',
        'steam_app_id',
      ]) {
        const result = await error(
          await put(at({ ...object, [key]: 'secret-submitted-value' })),
          422,
          'VALIDATION_FAILED',
        );
        expect(JSON.stringify(result)).not.toMatch(/secret-submitted/);
      }
    }
    const result = await error(
      await put({
        ...snapshot(),
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`private-${i}`, 'secret']),
        ),
      }),
      422,
      'VALIDATION_FAILED',
    );
    expect(result.issues).toBeDefined();
    expect(result.issues?.length).toBeLessThanOrEqual(20);
    const manyIssues = await error(
      await put({
        ...snapshot(),
        metadata: {
          ...snapshot().metadata,
          developers: Array(32).fill(''),
          publishers: Array(32).fill(''),
        },
      }),
      422,
      'VALIDATION_FAILED',
    );
    expect(manyIssues.issues).toHaveLength(20);
    expect(manyIssues.issues?.[0]).toEqual({
      path: 'metadata.developers[0]',
      code: 'BLANK_STRING',
    });
    for (const issue of result.issues ?? [])
      expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('checks Unicode code-point bounds, nonblank strings, ordered exact uniqueness, null/empty, and OS subsets', async () => {
    const { put } = fixture();
    for (const [path, bound] of [
      ['event_id', 128],
      ['metadata.title', 512],
      ['provenance.extractor_version', 128],
      ['metadata.release.date.window', 256],
    ] as const) {
      const value = (text: string) => {
        const result = JSON.parse(JSON.stringify(snapshot()));
        const keys = path.split('.');
        let target = result;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys.at(-1) ?? ''] = text;
        return result;
      };
      for (const text of [
        '',
        ' ',
        '\tvalue',
        'value\n',
        '😀'.repeat(bound + 1),
      ])
        await error(await put(value(text)), 422, 'VALIDATION_FAILED');
      // Extractor strings of a valid length still need separate policy approval.
      expect((await put(value('😀'.repeat(bound)))).status).toBe(
        path.startsWith('provenance') ? 403 : 200,
      );
    }
    for (const key of ['developers', 'publishers'] as const) {
      for (const names of [
        null,
        [],
        ['A', 'a'],
        ['é', 'é'],
        ['😀'.repeat(256)],
        Array.from({ length: 32 }, (_, i) => `Credit ${i}`),
      ])
        expect(
          (
            await put({
              ...snapshot(),
              metadata: { ...snapshot().metadata, [key]: names },
            })
          ).status,
        ).toBe(200);
      for (const names of [
        ['A', 'A'],
        [''],
        [' A'],
        ['😀'.repeat(257)],
        Array.from({ length: 33 }, (_, i) => `Credit ${i}`),
      ])
        await error(
          await put({
            ...snapshot(),
            metadata: { ...snapshot().metadata, [key]: names },
          }),
          422,
          'VALIDATION_FAILED',
        );
    }
    for (const os of [null, [], ['windows', 'macos', 'linux']])
      expect(
        (
          await put({
            ...snapshot(),
            metadata: { ...snapshot().metadata, supported_os: os },
          })
        ).status,
      ).toBe(200);
    for (const os of [
      ['windows', 'windows'],
      ['Windows'],
      ['android'],
      'linux',
    ])
      await error(
        await put({
          ...snapshot(),
          metadata: { ...snapshot().metadata, supported_os: os },
        }),
        422,
        'VALIDATION_FAILED',
      );
  });

  it('validates product/base identity and independent status/date variants with real calendar dates', async () => {
    const { put } = fixture();
    for (const type of ['game', 'demo', 'dlc']) {
      for (const base of [null, 1, 4294967295]) {
        const response = await put({
          ...snapshot(),
          metadata: {
            ...snapshot().metadata,
            product_type: type,
            base_app_id: base,
          },
        });
        expect(response.status).toBe(
          type === 'game' && base !== null ? 422 : 200,
        );
      }
    }
    for (const base of [0, 1001, 4294967296, 1.5, '2001'])
      await error(
        await put({
          ...snapshot(),
          metadata: { ...snapshot().metadata, base_app_id: base },
        }),
        422,
        'VALIDATION_FAILED',
      );
    await error(
      await put({
        ...snapshot(),
        metadata: { ...snapshot().metadata, product_type: 'music' },
      }),
      422,
      'VALIDATION_FAILED',
    );
    for (const status of ['upcoming', 'released', 'unknown']) {
      for (const date of [
        { kind: 'unknown' },
        { kind: 'window', window: 'Q4 2030' },
        { kind: 'exact', date: '2000-02-29' },
        { kind: 'exact', date: '0001-01-01' },
        { kind: 'exact', date: '9999-12-31' },
      ])
        expect(
          (
            await put({
              ...snapshot(),
              metadata: { ...snapshot().metadata, release: { status, date } },
            })
          ).status,
        ).toBe(200);
    }
    for (const date of [
      '1900-02-29',
      '2030-02-29',
      '2030-04-31',
      '2030-13-01',
      '2030-00-01',
      '2030-01-00',
      '2030-1-01',
      '0000-01-01',
      '2030-01-01T00:00:00Z',
    ])
      await error(
        await put({
          ...snapshot(),
          metadata: {
            ...snapshot().metadata,
            release: { status: 'upcoming', date: { kind: 'exact', date } },
          },
        }),
        422,
        'VALIDATION_FAILED',
      );
    for (const date of [
      { kind: 'unknown', date: null },
      { kind: 'exact', window: 'Q4' },
      { kind: 'window', window: 'Q4', date: null },
      { kind: 'other' },
      null,
    ])
      await error(
        await put({
          ...snapshot(),
          metadata: {
            ...snapshot().metadata,
            release: { status: 'upcoming', date },
          },
        }),
        422,
        'VALIDATION_FAILED',
      );
    await error(
      await put({
        ...snapshot(),
        metadata: {
          ...snapshot().metadata,
          release: { status: 'available', date: { kind: 'unknown' } },
        },
      }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('requires en, integer seconds, exact future tolerance, and a bounded opaque generation', async () => {
    const { put } = fixture();
    for (const observed_at of [0, now + 300])
      expect(
        (
          await put({
            ...snapshot(),
            provenance: { ...snapshot().provenance, observed_at },
          })
        ).status,
      ).toBe(200);
    for (const observed_at of [-1, 1.5, now + 301, now * 1000, '1700000000'])
      await error(
        await put({
          ...snapshot(),
          provenance: { ...snapshot().provenance, observed_at },
        }),
        422,
        'VALIDATION_FAILED',
      );
    for (const language of ['EN', 'fr', null])
      await error(
        await put({
          ...snapshot(),
          provenance: { ...snapshot().provenance, language },
        }),
        422,
        'VALIDATION_FAILED',
      );
    for (const generation of [undefined, '', ' '.repeat(2), 'x'.repeat(129)])
      await error(
        await put(snapshot(), { 'X-Publication-Generation': generation }),
        422,
        'VALIDATION_FAILED',
      );
    expect(
      (await put(snapshot(), { 'X-Publication-Generation': 'x'.repeat(128) }))
        .status,
    ).toBe(200);
  });

  it('denies missing/malformed/unmatched or non-synthetic source policies and unsafe URLs without accepting data', async () => {
    const { put, env, accepted } = fixture();
    for (const sources of [
      '',
      'not-json',
      '[]',
      '{}',
      JSON.stringify([
        {
          source_url: snapshot().provenance.source_url,
          extractor_version: 'other',
        },
      ]),
    ])
      await error(
        await put(snapshot(), {}, '1001', {
          ...env,
          APPROVED_SNAPSHOT_SOURCES: sources,
        }),
        403,
        'SOURCE_NOT_APPROVED',
      );
    for (const source_url of [
      'http://catalog.example.invalid/apps/1001',
      'https://user:secret@catalog.example.invalid/apps/1001',
      'https://catalog.example.invalid/apps/1001?token=secret',
      'https://catalog.example.invalid/apps/1001#secret',
      'https://store.steampowered.com/app/1001',
      'https://catalog.example.invalid/apps/1002',
      'https://CATALOG.example.invalid/apps/1001',
    ])
      await error(
        await put({
          ...snapshot(),
          provenance: { ...snapshot().provenance, source_url },
        }),
        403,
        'SOURCE_NOT_APPROVED',
      );
    await error(
      await put({
        ...snapshot(),
        provenance: { ...snapshot().provenance, source_url: 'x'.repeat(2049) },
      }),
      422,
      'VALIDATION_FAILED',
    );
    // Safety must fail even when policy matching would otherwise succeed.
    for (const source_url of [
      'https://user:secret@catalog.example.invalid/apps/1001',
      'https://catalog.example.invalid/apps/1001?token=secret',
      'https://catalog.example.invalid/apps/1001#secret',
      'https://store.steampowered.com/app/1001',
      'http://catalog.example.invalid/apps/1001',
    ]) {
      const unsafe = { source_url, extractor_version: 'synthetic-v1' };
      for (const pairs of [[unsafe], [JSON.parse(policy)[0], unsafe]]) {
        const config = {
          ...env,
          APPROVED_SNAPSHOT_SOURCES: JSON.stringify(pairs),
        };
        await error(
          await put(
            {
              ...snapshot(),
              provenance: { ...snapshot().provenance, source_url },
            },
            {},
            '1001',
            config,
          ),
          403,
          'SOURCE_NOT_APPROVED',
        );
        // A matching safe tuple cannot make a malformed/unsafe policy usable.
        if (pairs.length === 2)
          await error(
            await put(snapshot(), {}, '1001', config),
            403,
            'SOURCE_NOT_APPROVED',
          );
      }
    }
    expect(accepted).not.toHaveBeenCalled();
  });

  it('accepts source/extractor code-point limits only under exact configured approval without fetching sources', async () => {
    const { put, env } = fixture();
    const baseUrl = 'https://catalog.example.invalid/';
    const source_url = baseUrl + 'a'.repeat(2048 - baseUrl.length);
    const extractor_version = '😀'.repeat(128);
    const config = {
      ...env,
      APPROVED_SNAPSHOT_SOURCES: JSON.stringify([
        { source_url, extractor_version },
      ]),
    };
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch sources'));
    try {
      const response = await put(
        {
          ...snapshot(),
          provenance: {
            ...snapshot().provenance,
            source_url,
            extractor_version,
          },
        },
        {},
        '1001',
        config,
      );
      expect(response.status).toBe(200);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('waits for the application operation before returning success and sanitizes defects/read failures', async () => {
    const { env } = fixture();
    let complete: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const started = vi.fn();
    const app = createApp({
      catalogLayer: Layer.succeed(Catalog, {
        lookupApplication: () => Effect.die('unused'),
        acquireAuthorization: () => Effect.die('unused'),
        inspectPublication: () => Effect.die('unused'),
        submitSnapshot: () =>
          Effect.promise(async () => {
            started();
            await committed;
            return {
              steam_app_id: 1001,
              outcome: 'applied' as const,
              current_observed_at: now,
            };
          }),
      }),
    });
    let returned = false;
    const pending = Promise.resolve(
      app.request(
        `${prefix}/1001/snapshot`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
        env,
      ),
    ).then((response) => {
      returned = true;
      return response;
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    complete?.();
    expect((await pending).status).toBe(200);

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = createApp({
        catalogLayer: Layer.succeed(Catalog, {
          lookupApplication: () => Effect.die('unused'),
          acquireAuthorization: () => Effect.die('unused'),
          inspectPublication: () => Effect.die('unused'),
          submitSnapshot: () =>
            Effect.die(
              new Error(
                `SQL parameters source-content ${env.INGESTION_BEARER_TOKEN}`,
              ),
            ),
        }),
      });
      await error(
        await broken.request(
          `${prefix}/1001/snapshot`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
          },
          env,
        ),
        500,
        'INTERNAL_SERVER_ERROR',
      );
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(
              new Error(`secret body ${env.INGESTION_BEARER_TOKEN}`),
            );
          },
        },
        { highWaterMark: 0 },
      );
      const init = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        duplex: 'half',
      };
      await error(
        await app.request(
          new Request(`${prefix}/1001/snapshot`, init),
          undefined,
          env,
        ),
        500,
        'INTERNAL_SERVER_ERROR',
      );
      expect(log.mock.calls).toEqual([
        ['Unhandled API error'],
        ['Unhandled API error'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('maps all captured outcomes/failures, awaiting completion and sanitizing diagnostics', async () => {
    const { env } = fixture();
    for (const outcome of ['applied', 'unchanged', 'ignored_stale'] as const) {
      const app = createApp({
        catalogLayer: Layer.succeed(Catalog, {
          lookupApplication: () => Effect.die('unused'),
          acquireAuthorization: () => Effect.die('unused'),
          inspectPublication: () => Effect.die('unused'),
          submitSnapshot: (id: number) =>
            Effect.succeed({
              steam_app_id: id,
              outcome,
              current_observed_at: 123,
              private: 'secret',
            }),
        }),
      });
      const response = await app.request(
        `${prefix}/1001/snapshot`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
        env,
      );
      expect(await response.json()).toEqual({
        data: { steam_app_id: 1001, outcome, current_observed_at: 123 },
      });
    }
    for (const [code, status] of [
      ['PUBLICATION_WITHDRAWN', 409],
      ['PUBLICATION_GENERATION_MISMATCH', 409],
      ['SNAPSHOT_CONFLICT', 409],
      ['SOURCE_NOT_APPROVED', 403],
      ['VALIDATION_FAILED', 422],
      ['SERVICE_UNAVAILABLE', 503],
      ['INTERNAL_SERVER_ERROR', 500],
    ] as const) {
      const app = createApp({
        catalogLayer: Layer.succeed(Catalog, {
          lookupApplication: () => Effect.die('unused'),
          acquireAuthorization: () => Effect.die('unused'),
          inspectPublication: () => Effect.die('unused'),
          submitSnapshot: () =>
            Effect.fail(
              Object.assign(new CatalogFailure({ code }), {
                cause: new Error(`SQL secret ${env.INGESTION_BEARER_TOKEN}`),
              }),
            ),
        }),
      });
      const response = await app.request(
        `${prefix}/1001/snapshot`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        },
        env,
      );
      await error(response, status, code);
    }
  });
});
