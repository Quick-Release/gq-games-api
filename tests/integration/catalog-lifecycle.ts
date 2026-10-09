// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Schema } from 'effect';
import { expect } from 'vite-plus/test';

const strict = { onExcessProperty: 'error' } as const;
const authorization = Schema.Struct({
  steam_app_id: Schema.Number,
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});
const control = Schema.Struct({
  steam_app_id: Schema.Number,
  state: Schema.Literals(['uninitialized', 'eligible', 'withdrawn']),
  generation: Schema.NullOr(Schema.String),
  generation_issued_at: Schema.NullOr(Schema.Number),
});
const changed = Schema.Struct({
  steam_app_id: Schema.Number,
  state: Schema.Literals(['eligible', 'withdrawn']),
  generation: Schema.String,
  generation_issued_at: Schema.Number,
  outcome: Schema.Literals(['applied', 'unchanged']),
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Run inside the existing isolated Alchemy fixture, with no additional storage,
// migration executor, network source, or production fault/coordination hooks.
export const verifyHttpLifecycle = async ({
  url,
  ingestion,
  admin,
  auditSnapshot,
}: {
  url: string;
  ingestion: string;
  admin: string;
  auditSnapshot: (id: number) => Promise<unknown>;
}) => {
  const prefix = '/internal/v1/steam/applications';
  const ids = new Set<string>();
  const performRequest = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Request-ID', 'synthetic-caller-lifecycle-id');
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error(
        `Local lifecycle HTTP request failed: ${init?.method ?? 'GET'} ${path}`,
      );
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    if (!requestId) throw new Error('Missing server request ID');
    expect(ids.has(requestId)).toBe(false);
    ids.add(requestId);
    const text = await response.text();
    for (const marker of [
      ingestion,
      admin,
      'D1_ERROR',
      'catalog_fixture_missing_table',
    ]) {
      expect(
        text.includes(marker),
        'No credential or driver cause in HTTP response',
      ).toBe(false);
    }
    const body: unknown = JSON.parse(text);
    return { status: response.status, requestId, body };
  };
  const request = (path: string, init?: RequestInit) => {
    const pending = performRequest(path, init);
    // Coordinated requests are deliberately awaited later. Attach a rejection
    // observer immediately so a broken gate reports one useful test failure,
    // not an unrelated unhandled-rejection event. Await still throws normally.
    void pending.catch(() => {});
    return pending;
  };
  const privateInit = (
    token: string,
    method: string,
    body?: unknown,
    generation?: string,
    gate?: string,
  ) => {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (generation !== undefined)
      headers.set('X-Publication-Generation', generation);
    if (gate !== undefined) headers.set('X-Fixture-Gate', gate);
    return {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  };
  const acquire = (id: number, gate?: string) =>
    request(
      `${prefix}/${id}/ingestion-authorization`,
      privateInit(ingestion, 'POST', undefined, undefined, gate),
    );
  const inspect = (id: number, gate?: string) =>
    request(
      `${prefix}/${id}/publication`,
      privateInit(admin, 'GET', undefined, undefined, gate),
    );
  const change = (id: number, input: unknown, gate?: string) =>
    request(
      `${prefix}/${id}/publication`,
      privateInit(admin, 'PUT', input, undefined, gate),
    );
  const submit = (
    id: number,
    generation: string,
    snapshot: unknown,
    gate?: string,
  ) =>
    request(
      `${prefix}/${id}/snapshot`,
      privateInit(ingestion, 'PUT', snapshot, generation, gate),
    );
  const lookup = (id: number, gate?: string) =>
    request(
      `/v1/steam/applications/${id}`,
      gate ? { headers: { 'X-Fixture-Gate': gate } } : undefined,
    );
  const decodeData = <A>(
    schema: Schema.Codec<A, unknown>,
    result: Awaited<ReturnType<typeof request>>,
  ) => {
    expect(result.status).toBe(200);
    return Schema.decodeUnknownSync(
      Schema.Struct({ data: schema }),
      strict,
    )(result.body).data;
  };
  const failure = (
    result: Awaited<ReturnType<typeof request>>,
    status: number,
    code: string,
  ) => {
    expect(result.status).toBe(status);
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        error: Schema.Struct({
          code: Schema.String,
          request_id: Schema.String,
          issues: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({ path: Schema.String, code: Schema.String }),
            ),
          ),
        }),
      }),
      strict,
    )(result.body);
    expect(value.error.code).toBe(code);
    expect(value.error.request_id).toBe(result.requestId);
    expect(value.error.issues?.length ?? 0).toBeLessThanOrEqual(20);
    if (code !== 'VALIDATION_FAILED')
      expect(value.error.issues).toBeUndefined();
  };
  const snapshotOutcome = (
    result: Awaited<ReturnType<typeof request>>,
    id: number,
    outcome: string,
    time: number,
  ) => {
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: { steam_app_id: id, outcome, current_observed_at: time },
    });
  };
  const gate = async (key: string, action: string, kind = 'batch') => {
    const response = await fetch(
      `${url}/fixture/http-gates/${key}/${action}?kind=${kind}`,
      {
        method: action === 'arrived' || action === 'committed' ? 'GET' : 'POST',
        signal: AbortSignal.timeout(15_000),
      },
    ).catch(() => {
      throw new Error(`Local lifecycle coordination failed: ${key}/${action}`);
    });
    expect(response.status, 'Local coordination endpoint').toBe(200);
    expect(await response.json()).toEqual({ gate: true });
  };
  const commit = async (key: string) => {
    await gate(key, 'release');
    await gate(key, 'committed');
  };

  let observations = 0;
  const collect = async (floor: number, after = floor) => {
    // This wait is ONLY to create a genuinely later local synthetic observation
    // at integer-second precision. Database races use explicit binding gates,
    // never these sleeps. No timestamp is calculated as floor + 1 or rewritten.
    const deadline = Date.now() + 5_000;
    while (Math.floor(Date.now() / 1000) <= Math.max(floor, after)) {
      if (Date.now() > deadline)
        throw new Error('Synthetic producer clock did not advance');
      await pause(20);
    }
    const observedAt = Math.floor(Date.now() / 1000);
    observations++;
    return {
      event_id: `synthetic-lifecycle-observation-${observations}`,
      metadata: {
        title: `Synthetic Lifecycle Observation ${observations}`,
        product_type: 'demo',
        base_app_id: null,
        developers: ['Synthetic Lifecycle Developer'],
        publishers: [],
        supported_os: ['windows', 'linux', 'macos'],
        release: { status: 'unknown', date: { kind: 'unknown' } },
      },
      provenance: {
        source_url: 'https://catalog.example.invalid/apps/1001',
        language: 'en',
        observed_at: observedAt,
        extractor_version: 'synthetic-v1',
      },
    };
  };
  const expectPublic = async (
    id: number,
    observedAt: number,
    number: number,
  ) => {
    const result = await lookup(id);
    expect(result.status).toBe(200);
    // Independent explicit public projection, including every nested key.
    expect(result.body).toEqual({
      data: {
        steam_app_id: id,
        metadata: {
          title: `Synthetic Lifecycle Observation ${number}`,
          product_type: 'demo',
          base_app_id: null,
          developers: ['Synthetic Lifecycle Developer'],
          publishers: [],
          supported_os: ['linux', 'macos', 'windows'],
          release: { status: 'unknown', date: { kind: 'unknown' } },
        },
        provenance: {
          source_url: 'https://catalog.example.invalid/apps/1001',
          language: 'en',
          observed_at: observedAt,
        },
      },
    });
    return result.body;
  };

  // Acquire -> actually construct a post-floor synthetic observation -> submit
  // -> anonymous lookup. Losing a response retains no response/body archive.
  const permit = decodeData(authorization, await acquire(8001));
  const first = await collect(permit.minimum_observed_at);
  const firstNumber = observations;
  const discard = async (path: string, init: RequestInit) => {
    const response = await fetch(`${url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    // Intentionally do not inspect status or decode the ingestion/admin outcome.
    // Receipt of headers means the server finished; pretend they were lost.
    await response.body?.cancel();
  };
  await discard(
    `${prefix}/8001/snapshot`,
    privateInit(ingestion, 'PUT', first, permit.generation),
  );
  snapshotOutcome(
    await submit(8001, permit.generation, first),
    8001,
    'unchanged',
    first.provenance.observed_at,
  );
  await expectPublic(8001, first.provenance.observed_at, firstNumber);

  // Actual workerd streamed bodies, without Content-Length. Exactly 32 KiB
  // succeeds; one additional byte cannot bypass the Worker reader's bound.
  const encoded = JSON.stringify(first);
  const exactLimit =
    encoded + ' '.repeat(32768 - new TextEncoder().encode(encoded).length);
  snapshotOutcome(
    await request(`${prefix}/8001/snapshot`, {
      ...privateInit(ingestion, 'PUT', first, permit.generation),
      body: exactLimit,
    }),
    8001,
    'unchanged',
    first.provenance.observed_at,
  );
  const oversized = {
    ...privateInit(ingestion, 'PUT', first, permit.generation),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(exactLimit));
        controller.enqueue(new Uint8Array([32]));
        controller.close();
      },
    }),
    duplex: 'half',
  };
  failure(
    await request(`${prefix}/8001/snapshot`, oversized),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  for (const headers of [
    { 'Content-Type': 'text/plain' },
    { 'Content-Type': 'application/json; charset=latin1' },
    { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
  ]) {
    const init = privateInit(ingestion, 'PUT', first, permit.generation);
    for (const [key, value] of Object.entries(headers))
      if (value !== undefined) init.headers.set(key, value);
    failure(
      await request(`${prefix}/8001/snapshot`, init),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
  for (const body of ['{', new Uint8Array([0xff])]) {
    failure(
      await request(`${prefix}/8001/snapshot`, {
        ...privateInit(ingestion, 'PUT', first, permit.generation),
        body,
      }),
      400,
      'INVALID_JSON',
    );
  }
  // Wrong/missing credentials win before malformed IDs/bodies across all four
  // private routes; the public fifth route needs no configuration/credential.
  for (const [suffix, method, other] of [
    ['ingestion-authorization', 'POST', admin],
    ['snapshot', 'PUT', admin],
    ['publication', 'GET', ingestion],
    ['publication', 'PUT', ingestion],
  ] as const) {
    for (const [token, status, code] of [
      ['', 401, 'UNAUTHORIZED'],
      ['synthetic-invalid-token', 401, 'UNAUTHORIZED'],
      [other, 403, 'FORBIDDEN'],
    ] as const) {
      failure(
        await request(`${prefix}/bad/${suffix}`, {
          ...privateInit(token, method),
          ...(method === 'GET' ? {} : { body: '{' }),
        }),
        status,
        code,
      );
    }
  }
  failure(
    await request(`${prefix}/8001/ingestion-authorization`, {
      ...privateInit(ingestion, 'POST'),
      body: ' ',
    }),
    422,
    'VALIDATION_FAILED',
  );
  const newer = await collect(
    permit.minimum_observed_at,
    first.provenance.observed_at,
  );
  const newerNumber = observations;
  snapshotOutcome(
    await submit(8001, permit.generation, newer),
    8001,
    'applied',
    newer.provenance.observed_at,
  );
  snapshotOutcome(
    await submit(8001, permit.generation, first),
    8001,
    'ignored_stale',
    newer.provenance.observed_at,
  );
  await expectPublic(8001, newer.provenance.observed_at, newerNumber);

  // A lookup which already read may finish AFTER withdrawal. Pause the original
  // primary read's result, not a fabricated response or a separately read row.
  await gate('pre-withdrawal-read', 'arm', 'read');
  const inFlight = lookup(8001, 'pre-withdrawal-read');
  await gate('pre-withdrawal-read', 'arrived');
  await commit('pre-withdrawal-read');
  const withdrawalCommand = {
    state: 'withdrawn',
    expected_generation: permit.generation,
  };
  await discard(
    `${prefix}/8001/publication`,
    privateInit(admin, 'PUT', withdrawalCommand),
  );
  const withdrawn = decodeData(control, await inspect(8001));
  expect(withdrawn.state).toBe('withdrawn');
  expect(withdrawn.generation).not.toBe(permit.generation);
  expect(await auditSnapshot(8001)).toBeNull();
  failure(await lookup(8001), 404, 'NOT_FOUND');
  failure(await lookup(8009), 404, 'NOT_FOUND');
  // A second real read is started only after the administrative commit.
  await gate('post-withdrawal-read', 'arm', 'read');
  const afterWithdrawal = lookup(8001, 'post-withdrawal-read');
  await gate('post-withdrawal-read', 'arrived');
  await commit('post-withdrawal-read');
  await gate('post-withdrawal-read', 'respond');
  failure(await afterWithdrawal, 404, 'NOT_FOUND');
  await gate('pre-withdrawal-read', 'respond');
  const earlierRead = await inFlight;
  expect(earlierRead.status).toBe(200);
  expect(earlierRead.body).toEqual(
    expectPublicHeld(newer.provenance.observed_at, newerNumber),
  );

  failure(
    await change(8001, withdrawalCommand),
    409,
    'PUBLICATION_GENERATION_MISMATCH',
  );
  failure(await acquire(8001), 409, 'PUBLICATION_WITHDRAWN');
  failure(
    await submit(8001, permit.generation, first),
    409,
    'PUBLICATION_WITHDRAWN',
  );
  // Reconciliation supplies information for an explicit NEW decision, not an
  // automatic retry that silently replaces the uncertain command's expectation.
  const reinstated = decodeData(
    changed,
    await change(8001, {
      state: 'eligible',
      expected_generation: withdrawn.generation,
    }),
  );
  expect(reinstated.outcome).toBe('applied');
  expect(
    new Set([permit.generation, withdrawn.generation, reinstated.generation])
      .size,
  ).toBe(3);
  expect(await auditSnapshot(8001)).toBeNull();
  failure(await lookup(8001), 404, 'NOT_FOUND');
  expect(decodeData(authorization, await acquire(8001))).toEqual({
    steam_app_id: 8001,
    generation: reinstated.generation,
    minimum_observed_at: reinstated.generation_issued_at,
  });
  // Both stale target states, including already-eligible, must fail.
  for (const state of ['eligible', 'withdrawn']) {
    failure(
      await change(8001, { state, expected_generation: permit.generation }),
      409,
      'PUBLICATION_GENERATION_MISMATCH',
    );
  }
  const fresh = await collect(
    reinstated.generation_issued_at,
    newer.provenance.observed_at,
  );
  const freshNumber = observations;
  failure(
    await submit(8001, permit.generation, fresh),
    409,
    'PUBLICATION_GENERATION_MISMATCH',
  );
  // Deliberately invalid fixture candidate; this is never described as a real
  // observation, accepted, or used as retry/republication evidence.
  failure(
    await submit(8001, reinstated.generation, {
      ...fresh,
      provenance: {
        ...fresh.provenance,
        observed_at: reinstated.generation_issued_at - 1,
      },
    }),
    422,
    'VALIDATION_FAILED',
  );
  expect(await auditSnapshot(8001)).toBeNull();
  snapshotOutcome(
    await submit(8001, reinstated.generation, fresh),
    8001,
    'applied',
    fresh.provenance.observed_at,
  );
  const publicFresh = await expectPublic(
    8001,
    fresh.provenance.observed_at,
    freshNumber,
  );

  // Concurrent first acquisitions traverse real HTTP separately and all reach
  // D1 before any are released. Every response is held until all have committed.
  const keys = Array.from({ length: 6 }, (_, index) => `initial-${index}`);
  for (const key of keys) await gate(key, 'arm');
  const acquisitions = keys.map((key) => acquire(8002, key));
  await Promise.all(keys.map((key) => gate(key, 'arrived')));
  for (const key of keys) await commit(key);
  for (const key of keys) await gate(key, 'respond');
  const acquired = (await Promise.all(acquisitions)).map((result) =>
    decodeData(authorization, result),
  );
  const concurrentPermit = acquired[0];
  if (!concurrentPermit) throw new Error('Missing acquisition result');
  for (const result of acquired) expect(result).toEqual(concurrentPermit);

  // Absent and existing snapshots: delay BOTH captured batch results until both
  // commits. Expected classifications are determined by release order and input
  // observations, never by a post-write read used to construct expectations.
  for (const [id, highFirst] of [
    [8002, false],
    [8003, true],
  ] as const) {
    const current =
      id === 8002
        ? concurrentPermit
        : decodeData(authorization, await acquire(id));
    const low = await collect(current.minimum_observed_at);
    const lowNumber = observations;
    if (highFirst)
      snapshotOutcome(
        await submit(id, current.generation, low),
        id,
        'applied',
        low.provenance.observed_at,
      );
    const high = await collect(
      current.minimum_observed_at,
      low.provenance.observed_at,
    );
    const highNumber = observations;
    const lowKey = `low-${id}`;
    const highKey = `high-${id}`;
    await gate(lowKey, 'arm');
    await gate(highKey, 'arm');
    const lowResponse = submit(id, current.generation, low, lowKey);
    const highResponse = submit(id, current.generation, high, highKey);
    await Promise.all([gate(lowKey, 'arrived'), gate(highKey, 'arrived')]);
    for (const key of highFirst ? [highKey, lowKey] : [lowKey, highKey])
      await commit(key);
    for (const key of [lowKey, highKey]) await gate(key, 'respond');
    snapshotOutcome(
      await highResponse,
      id,
      'applied',
      high.provenance.observed_at,
    );
    snapshotOutcome(
      await lowResponse,
      id,
      highFirst ? 'ignored_stale' : 'applied',
      highFirst ? high.provenance.observed_at : low.provenance.observed_at,
    );
    expect(highNumber).toBeGreaterThan(lowNumber);
    await expectPublic(id, high.provenance.observed_at, highNumber);
  }

  // Both commit orders for HTTP withdrawal versus acquisition/submission. No
  // ordinary role can lift withdrawn control, and even a delayed earlier applied
  // response correctly describes its operation rather than later purged state.
  const raceIds: number[] = [];
  for (const operation of ['acquire', 'submit', 'change'] as const) {
    for (const withdrawalFirst of [false, true]) {
      const id = 8100 + raceIds.length;
      raceIds.push(id);
      const current = decodeData(authorization, await acquire(id));
      const snapshot = await collect(current.minimum_observed_at);
      const withdrawalKey = `withdraw-${id}`;
      const otherKey = `other-${id}`;
      await gate(withdrawalKey, 'arm');
      await gate(otherKey, 'arm');
      const withdrawal = change(
        id,
        { state: 'withdrawn', expected_generation: current.generation },
        withdrawalKey,
      );
      const other =
        operation === 'acquire'
          ? acquire(id, otherKey)
          : operation === 'submit'
            ? submit(id, current.generation, snapshot, otherKey)
            : change(
                id,
                { state: 'eligible', expected_generation: current.generation },
                otherKey,
              );
      await Promise.all([
        gate(withdrawalKey, 'arrived'),
        gate(otherKey, 'arrived'),
      ]);
      for (const key of withdrawalFirst
        ? [withdrawalKey, otherKey]
        : [otherKey, withdrawalKey])
        await commit(key);
      // Admin inspection also crosses the real read boundary after both commits,
      // while the writes' HTTP responses remain in flight.
      const inspectionKey = `inspect-${id}`;
      await gate(inspectionKey, 'arm', 'read');
      const inspection = inspect(id, inspectionKey);
      await gate(inspectionKey, 'arrived');
      await commit(inspectionKey);
      await gate(inspectionKey, 'respond');
      const inspected = decodeData(control, await inspection);
      expect(inspected.state).toBe('withdrawn');
      failure(await lookup(id), 404, 'NOT_FOUND');
      for (const key of [withdrawalKey, otherKey]) await gate(key, 'respond');
      const appliedWithdrawal = decodeData(changed, await withdrawal);
      expect(appliedWithdrawal).toEqual({ ...inspected, outcome: 'applied' });
      if (withdrawalFirst)
        failure(
          await other,
          409,
          operation === 'change'
            ? 'PUBLICATION_GENERATION_MISMATCH'
            : 'PUBLICATION_WITHDRAWN',
        );
      else if (operation === 'acquire')
        expect(decodeData(authorization, await other)).toEqual(current);
      else if (operation === 'change')
        expect(decodeData(changed, await other)).toEqual({
          steam_app_id: id,
          state: 'eligible',
          generation: current.generation,
          generation_issued_at: current.minimum_observed_at,
          outcome: 'unchanged',
        });
      else
        snapshotOutcome(
          await other,
          id,
          'applied',
          snapshot.provenance.observed_at,
        );
      expect(await auditSnapshot(id)).toBeNull();
      for (const state of ['withdrawn', 'eligible']) {
        failure(
          await change(id, { state, expected_generation: current.generation }),
          409,
          'PUBLICATION_GENERATION_MISMATCH',
        );
      }
      expect(decodeData(control, await inspect(id))).toEqual(inspected);
    }
  }

  // A fixture-only later SQL failure goes through Hono/auth/service/native D1.
  // The accepted row/control are audited narrowly, never via an API history log.
  const rollbackPermit = decodeData(authorization, await acquire(8004));
  const rollbackSnapshot = await collect(rollbackPermit.minimum_observed_at);
  failure(
    await request(
      '/fixture/http-snapshot-failure',
      privateInit(
        ingestion,
        'PUT',
        rollbackSnapshot,
        rollbackPermit.generation,
      ),
    ),
    500,
    'INTERNAL_SERVER_ERROR',
  );
  expect(await auditSnapshot(8004)).toBeNull();
  expect(decodeData(control, await inspect(8004))).toEqual({
    steam_app_id: 8004,
    state: 'eligible',
    generation: rollbackPermit.generation,
    generation_issued_at: rollbackPermit.minimum_observed_at,
  });
  snapshotOutcome(
    await submit(8004, rollbackPermit.generation, rollbackSnapshot),
    8004,
    'applied',
    rollbackSnapshot.provenance.observed_at,
  );

  return { ids: [8001, 8002, 8003, 8004, ...raceIds], publicFresh };
};

// Independent full representation for the earlier read allowed to finish after
// withdrawal. It contains no fields taken from a persisted/internal row.
const expectPublicHeld = (observedAt: number, number: number) => ({
  data: {
    steam_app_id: 8001,
    metadata: {
      title: `Synthetic Lifecycle Observation ${number}`,
      product_type: 'demo',
      base_app_id: null,
      developers: ['Synthetic Lifecycle Developer'],
      publishers: [],
      supported_os: ['linux', 'macos', 'windows'],
      release: { status: 'unknown', date: { kind: 'unknown' } },
    },
    provenance: {
      source_url: 'https://catalog.example.invalid/apps/1001',
      language: 'en',
      observed_at: observedAt,
    },
  },
});
