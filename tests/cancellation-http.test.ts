// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect, Layer } from 'effect';
import { expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';
import { Catalog } from '../src/services/catalog';

const url =
  'https://catalog.example.invalid/internal/v1/steam/applications/1001/ingestion-authorization';
const unused = {
  lookupApplication: () => Effect.die('unused'),
  inspectPublication: () => Effect.die('unused'),
  acquireAuthorization: () => Effect.die('unused'),
  changePublication: () => Effect.die('unused'),
  submitSnapshot: () => Effect.die('unused'),
};
const env = {
  INGESTION_BEARER_TOKEN: 'synthetic-ingestion',
  PUBLICATION_ADMIN_BEARER_TOKEN: 'synthetic-admin',
};

it('rejects an already-aborted authorization before executing its catalog operation', async () => {
  const execute = vi.fn(() => ({
    steam_app_id: 1001,
    generation: 'synthetic',
    minimum_observed_at: 90,
  }));
  const app = createApp({
    catalogLayer: Layer.succeed(Catalog, {
      acquireAuthorization: () => Effect.sync(execute),
      lookupApplication: () => Effect.die('unused'),
      inspectPublication: () => Effect.die('unused'),
      changePublication: () => Effect.die('unused'),
      submitSnapshot: () => Effect.die('unused'),
    }),
  });
  const response = await app.request(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
      signal: AbortSignal.abort('private diagnostic'),
    },
    env,
  );
  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({
    error: {
      code: 'REQUEST_ABORTED',
      request_id: response.headers.get('x-request-id'),
    },
  });
  expect(execute).not.toHaveBeenCalled();
});

it('interrupts a pending publication read without continuing its business logic and completes release', async () => {
  const started = Promise.withResolvers<void>();
  const producer = Promise.withResolvers<void>();
  const continuation = vi.fn(() => ({
    steam_app_id: 1001,
    state: 'uninitialized' as const,
    generation: null,
    generation_issued_at: null,
  }));
  const released = vi.fn();
  const controller = new AbortController();
  const events: string[] = [];
  const app = createApp({
    observeLifecycle: (event) =>
      events.push(`${event.event}:${event.outcome ?? ''}`),
    catalogLayer: Layer.succeed(Catalog, {
      ...unused,
      inspectPublication: () =>
        Effect.promise(() => {
          started.resolve();
          return producer.promise;
        }).pipe(
          Effect.andThen(Effect.sync(continuation)),
          Effect.ensuring(Effect.sync(released)),
        ),
    }),
  });
  const pending = app.request(
    url.replace('ingestion-authorization', 'publication'),
    {
      headers: {
        Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
      },
      signal: controller.signal,
    },
    env,
  );
  await started.promise;
  controller.abort('private driver diagnostic');
  producer.resolve();
  const response = await pending;
  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({
    error: {
      code: 'REQUEST_ABORTED',
      request_id: response.headers.get('x-request-id'),
    },
  });
  expect(continuation).not.toHaveBeenCalled();
  expect(released).toHaveBeenCalledOnce();
  expect(events).toContain('effect_exit:interrupted');
});

it('times out a connected stalled JSON upload after ten seconds without awaiting producer cancellation', async () => {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
      pull() {
        entered.resolve();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const execute = vi.fn();
  const app = createApp({
    observeLifecycle: () => {},
    catalogLayer: Layer.succeed(Catalog, {
      ...unused,
      changePublication: () => Effect.sync(execute),
    }),
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
  let settled = false;
  const pending = Promise.resolve(
    app.request(
      url.replace('ingestion-authorization', 'publication'),
      init,
      env,
    ),
  ).then((response) => {
    settled = true;
    return response;
  });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({
      error: {
        code: 'BODY_READ_TIMEOUT',
        request_id: response.headers.get('x-request-id'),
      },
    });
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    try {
      streamController?.close();
    } catch {
      /* Already canceled. */
    }
    vi.useRealTimers();
  }
});

it.each(['reject', 'pending'] as const)(
  'aborts a pending native-byte upload and releases its lock despite %s cancellation',
  async (cancellation) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const events: string[] = [];
    const cancel = vi.fn(() =>
      cancellation === 'reject'
        ? Promise.reject(new Error('private token'))
        : new Promise<void>(() => {}),
    );
    const body = new ReadableStream({
      type: 'bytes',
      pull() {
        entered.resolve();
      },
      cancel,
    });
    const app = createApp({
      observeLifecycle: (event) => events.push(event.event),
      catalogLayer: Layer.succeed(Catalog, unused),
    });
    const init = {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
      duplex: 'half',
      signal: controller.signal,
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pending = app.request(
        url.replace('ingestion-authorization', 'publication'),
        init,
        env,
      );
      await entered.promise;
      controller.abort('private token');
      const response = await pending;
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({
        error: {
          code: 'REQUEST_ABORTED',
          request_id: response.headers.get('x-request-id'),
        },
      });
      expect(body.locked).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
      expect(events).toEqual([
        'body_reader_acquired',
        'request_aborted',
        'body_reader_released',
        'cleanup_complete',
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  },
);

it('preserves a selected oversized-body error when producer cancellation triggers a later abort', async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        stream.enqueue(new Uint8Array(32 * 1024 + 1));
      },
      cancel() {
        controller.abort();
      },
    },
    { highWaterMark: 0 },
  );
  const app = createApp({
    observeLifecycle: () => {},
    catalogLayer: Layer.succeed(Catalog, unused),
  });
  const init = {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
    duplex: 'half',
    signal: controller.signal,
  };
  const response = await app.request(
    url.replace('ingestion-authorization', 'publication'),
    init,
    env,
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: {
      code: 'PAYLOAD_TOO_LARGE',
      request_id: response.headers.get('x-request-id'),
    },
  });
});

it('lets an earlier abort win over a subsequently delivered overflowing chunk', async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        controller.abort();
        stream.enqueue(new Uint8Array(32 * 1024 + 1));
      },
    },
    { highWaterMark: 0 },
  );
  const app = createApp({
    observeLifecycle: () => {},
    catalogLayer: Layer.succeed(Catalog, unused),
  });
  const init = {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
    duplex: 'half',
    signal: controller.signal,
  };
  const response = await app.request(
    url.replace('ingestion-authorization', 'publication'),
    init,
    env,
  );
  expect(response.status).toBe(408);
  expect(await response.json()).toEqual({
    error: {
      code: 'REQUEST_ABORTED',
      request_id: response.headers.get('x-request-id'),
    },
  });
});

it('applies the absolute reading deadline to acquisition body-rejection too', async () => {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const app = createApp({
    observeLifecycle: () => {},
    catalogLayer: Layer.succeed(Catalog, unused),
  });
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGESTION_BEARER_TOKEN}` },
    body,
    duplex: 'half',
  };
  try {
    const pending = app.request(url, init, env);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({
      error: {
        code: 'BODY_READ_TIMEOUT',
        request_id: response.headers.get('x-request-id'),
      },
    });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the selected deadline error when producer cancellation then aborts the request', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered.resolve();
      },
      cancel() {
        controller.abort();
      },
    },
    { highWaterMark: 0 },
  );
  const app = createApp({
    observeLifecycle: () => {},
    catalogLayer: Layer.succeed(Catalog, unused),
  });
  const init = {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.PUBLICATION_ADMIN_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
    duplex: 'half',
    signal: controller.signal,
  };
  try {
    const pending = app.request(
      url.replace('ingestion-authorization', 'publication'),
      init,
      env,
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({
      error: {
        code: 'BODY_READ_TIMEOUT',
        request_id: response.headers.get('x-request-id'),
      },
    });
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('does not reset the absolute deadline when a connected upload sends another chunk', async () => {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stream = controller;
      },
      pull() {
        entered.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const app = createApp({
    observeLifecycle: () => {},
    catalogLayer: Layer.succeed(Catalog, unused),
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
  try {
    const pending = app.request(
      url.replace('ingestion-authorization', 'publication'),
      init,
      env,
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(9_000);
    stream?.enqueue(new TextEncoder().encode(' '));
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
