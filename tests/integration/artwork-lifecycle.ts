// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Schema } from 'effect';
import { expect } from 'vite-plus/test';
import { syntheticArtworkObservation } from '../fixtures/artwork';

const authorization = Schema.Struct({
  generation: Schema.String,
  minimum_observed_at: Schema.Number,
});
const assetAuthorization = Schema.Struct({
  provider: Schema.String,
  asset_id: Schema.String,
  ...authorization.fields,
});
const applicationAuthorization = Schema.Struct({
  steam_app_id: Schema.Number,
  ...authorization.fields,
});
const applicationPublication = Schema.Struct({
  steam_app_id: Schema.Number,
  state: Schema.Literals(['uninitialized', 'eligible', 'withdrawn']),
  generation: Schema.NullOr(Schema.String),
  generation_issued_at: Schema.NullOr(Schema.Number),
});
const publication = Schema.Struct({
  provider: Schema.String,
  asset_id: Schema.String,
  state: Schema.Literals(['uninitialized', 'eligible', 'withdrawn']),
  generation: Schema.NullOr(Schema.String),
  generation_issued_at: Schema.NullOr(Schema.Number),
});
const changed = Schema.Struct({
  ...publication.fields,
  outcome: Schema.Literals(['applied', 'unchanged']),
});
const asset = Schema.Struct({
  provider: Schema.String,
  asset_id: Schema.String,
  revision: Schema.String,
  observed_at: Schema.Number,
  renditions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      mime: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  provenance: Schema.Struct({
    source_url: Schema.String,
    extractor_version: Schema.String,
  }),
  rights: Schema.Struct({
    holder: Schema.String,
    permission: Schema.String,
    attribution: Schema.String,
  }),
});
const pageSchema = Schema.Struct({
  items: Schema.Array(asset),
  next_cursor: Schema.NullOr(Schema.String),
});
const strict = { onExcessProperty: 'error' } as const;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The existing Alchemy fixture owns startup, migrations, real D1 and shutdown.
// These checks use only HTTP interfaces and synthetic records, never source bytes.
export const verifyArtworkLifecycle = async ({
  url,
  ingestion,
  admin,
  registry,
}: {
  url: string;
  ingestion: string;
  admin: string;
  registry: string;
}) => {
  const secret = 'c'.repeat(64);
  const keyId = 'synthetic-artwork-reader';
  const reader = `${keyId}.${secret}`;
  const verifier = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const seenIds = new Set<string>();
  const request = async (
    path: string,
    token?: string,
    method = 'GET',
    input?: unknown,
    generation?: string,
    extra?: Record<string, string>,
  ) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(generation === undefined
          ? {}
          : { 'X-Publication-Generation': generation }),
        'X-Request-ID': 'synthetic-artwork-caller-id',
        ...extra,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const requestId = response.headers.get('X-Request-ID');
    expect(requestId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    if (!requestId) throw new Error('No artwork request ID');
    expect(seenIds.has(requestId)).toBe(false);
    seenIds.add(requestId);
    const text = await response.text();
    for (const value of [
      secret,
      ingestion,
      admin,
      registry,
      'D1_ERROR',
      'SqlError',
      'catalog_fixture_missing_table',
    ])
      expect(
        text.includes(value),
        'No credentials or driver causes in artwork response',
      ).toBe(false);
    const body: unknown = JSON.parse(text);
    return { status: response.status, body, requestId };
  };
  const data = <A>(
    schema: Schema.Codec<A, unknown>,
    result: Awaited<ReturnType<typeof request>>,
  ) => {
    expect(result.status, JSON.stringify(result.body)).toBe(200);
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
    expect(result.status, JSON.stringify(result.body)).toBe(status);
    const body = Schema.decodeUnknownSync(
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
    expect(body.error.code).toBe(code);
    expect(body.error.request_id).toBe(result.requestId);
  };
  const register = (
    scopes: string[],
    expires_at: number | null = null,
    revoked = false,
  ) =>
    request(`/v1/keys/${keyId}`, registry, 'PUT', {
      verifier,
      tenant_id: 'synthetic-artwork-tenant',
      scopes,
      expires_at,
      revoked,
    });
  const path = (id: string, tail = '', provider = 'synthetic') =>
    `/internal/v1/assets/${provider}/${id}${tail}`;
  const acquireAsset = async (id: string, provider = 'synthetic') =>
    data(
      assetAuthorization,
      await request(
        path(id, '/ingestion-authorization', provider),
        ingestion,
        'POST',
      ),
    );
  const acquireApp = async (id: number) =>
    data(
      applicationAuthorization,
      await request(
        `/internal/v1/steam/applications/${id}/ingestion-authorization`,
        ingestion,
        'POST',
      ),
    );
  const inspect = async (id: string) =>
    data(publication, await request(path(id, '/publication'), admin));
  const change = (
    id: string,
    state: string,
    generation: string | null,
    extra?: Record<string, string>,
  ) =>
    request(
      path(id, '/publication'),
      admin,
      'PUT',
      { state, expected_generation: generation },
      undefined,
      extra,
    );
  const changeApp = (
    id: number,
    state: string,
    generation: string | null,
    extra?: Record<string, string>,
  ) =>
    request(
      `/internal/v1/steam/applications/${id}/publication`,
      admin,
      'PUT',
      { state, expected_generation: generation },
      undefined,
      extra,
    );
  const resolve = (
    id: string,
    provider = 'synthetic',
    extra?: Record<string, string>,
  ) =>
    request(
      `/v1/assets/${provider}/${id}`,
      reader,
      'GET',
      undefined,
      undefined,
      extra,
    );
  const submit = (
    id: string,
    generation: string,
    input: unknown,
    extra?: Record<string, string>,
    provider = 'synthetic',
  ) =>
    request(
      path(id, '/observation', provider),
      ingestion,
      'PUT',
      input,
      generation,
      extra,
    );
  const enumerate = (id: number, query = '', extra?: Record<string, string>) =>
    request(
      `/v1/steam/applications/${id}/assets${query}`,
      reader,
      'GET',
      undefined,
      undefined,
      extra,
    );
  const after = async (floor: number) => {
    const deadline = Date.now() + 5_000;
    while (Math.floor(Date.now() / 1000) <= floor) {
      if (Date.now() > deadline)
        throw new Error('Synthetic artwork clock did not advance');
      await pause(20);
    }
    return Math.floor(Date.now() / 1000);
  };
  const outcome = (
    result: Awaited<ReturnType<typeof request>>,
    expected: string,
  ) => {
    const value = data(
      Schema.Struct({
        provider: Schema.String,
        asset_id: Schema.String,
        outcome: Schema.String,
        current_observed_at: Schema.Number,
      }),
      result,
    );
    expect(value.outcome).toBe(expected);
    return value;
  };

  // #20: the real role/registry/write/read path, no direct D1 seeding.
  failure(await request('/v1/assets/synthetic/artwork-1'), 401, 'UNAUTHORIZED');
  failure(
    await request('/v1/steam/applications/9101/assets'),
    401,
    'UNAUTHORIZED',
  );
  expect((await register(['catalog:read'])).status).toBe(200);
  failure(await resolve('artwork-1'), 401, 'UNAUTHORIZED');
  failure(await enumerate(9101), 401, 'UNAUTHORIZED');
  expect((await register(['assets:read'])).status).toBe(200);
  const priorKey = (await request(`/v1/keys/${keyId}`, registry)).body;
  for (const scopes of [
    ['assets:read', 'assets:read'],
    ['catalog:read', 'catalog:read'],
    ['assets:read', 'catalog:read', 'assets:read'],
  ]) {
    failure(await register(scopes), 422, 'VALIDATION_FAILED');
    expect((await request(`/v1/keys/${keyId}`, registry)).body).toEqual(
      priorKey,
    );
  }
  failure(await resolve('unknown'), 404, 'NOT_FOUND');
  const auth = await acquireAsset('artwork-1');
  const a = await acquireApp(9101);
  const b = await acquireApp(9102);
  const applications = [a, b].map(({ steam_app_id, generation }) => ({
    steam_app_id,
    generation,
  }));
  const timestamp = await after(
    Math.max(
      auth.minimum_observed_at,
      a.minimum_observed_at,
      b.minimum_observed_at,
    ),
  );
  const observation = syntheticArtworkObservation(applications, timestamp);
  outcome(await submit('artwork-1', auth.generation, observation), 'applied');
  const expectedAsset = {
    provider: 'synthetic',
    asset_id: 'artwork-1',
    revision: 'synthetic-revision-1',
    observed_at: timestamp,
    renditions: observation.renditions,
    provenance: observation.provenance,
    rights: observation.rights,
  };
  expect(data(asset, await resolve('artwork-1'))).toEqual(expectedAsset);
  for (const observed_at of [
    Math.floor(Date.now() / 1000) + 3600,
    Date.now(),
  ]) {
    failure(
      await submit('artwork-1', auth.generation, {
        ...observation,
        revision: 'future-observation',
        observed_at,
      }),
      422,
      'VALIDATION_FAILED',
    );
    expect(data(asset, await resolve('artwork-1'))).toEqual(expectedAsset);
  }
  outcome(await submit('artwork-1', auth.generation, observation), 'unchanged');
  outcome(
    await submit('artwork-1', auth.generation, {
      ...observation,
      applications: [...observation.applications].reverse(),
    }),
    'unchanged',
  );
  for (const policy of ['missing', 'malformed', 'partially-invalid']) {
    failure(
      await submit('artwork-1', auth.generation, observation, {
        'X-Fixture-Artwork-Policy': policy,
      }),
      403,
      'SOURCE_NOT_APPROVED',
    );
  }
  failure(
    await submit('artwork-1', auth.generation, {
      ...observation,
      revision: 'conflict',
    }),
    409,
    'SNAPSHOT_CONFLICT',
  );
  outcome(
    await submit('artwork-1', auth.generation, {
      ...observation,
      observed_at: timestamp - 1,
      revision: 'stale',
    }),
    'ignored_stale',
  );
  for (const invalid of [
    { ...observation, revision: ' padded ' },
    {
      ...observation,
      applications: [{ ...applications[0]!, generation: ' padded ' }],
    },
    { ...observation, unknown: 'not allowed' },
    { ...observation, renditions: [] },
    {
      ...observation,
      renditions: [{ ...observation.renditions[0], mime: 'text/html' }],
    },
    {
      ...observation,
      rights: { ...observation.rights, unknown: 'not allowed' },
    },
    { ...observation, applications: [applications[0], applications[0]] },
  ])
    failure(
      await submit('artwork-1', auth.generation, invalid),
      422,
      'VALIDATION_FAILED',
    );
  for (const unapproved of [
    {
      ...observation,
      rights: { ...observation.rights, permission: 'not approved' },
    },
    {
      ...observation,
      provenance: {
        ...observation.provenance,
        source_url: 'https://unapproved.example.invalid/source',
      },
    },
    {
      ...observation,
      renditions: [
        {
          ...observation.renditions[0],
          url: 'https://unapproved.example.invalid/image.png',
        },
      ],
    },
  ])
    failure(
      await submit('artwork-1', auth.generation, unapproved),
      403,
      'SOURCE_NOT_APPROVED',
    );
  expect(data(asset, await resolve('artwork-1'))).toEqual(expectedAsset);
  failure(
    await request(
      path('artwork-1', '/observation'),
      admin,
      'PUT',
      observation,
      auth.generation,
    ),
    403,
    'FORBIDDEN',
  );
  failure(
    await request(path('artwork-1', '/publication'), ingestion),
    403,
    'FORBIDDEN',
  );
  failure(
    await request(
      path('artwork-1', '/ingestion-authorization'),
      ingestion,
      'POST',
      {},
    ),
    422,
    'VALIDATION_FAILED',
  );

  // #21: namespace isolation, real page boundaries and documented churn.
  const other = await acquireAsset('artwork-1', 'second-provider');
  outcome(
    await submit(
      'artwork-1',
      other.generation,
      syntheticArtworkObservation(applications, Math.floor(Date.now() / 1000)),
      undefined,
      'second-provider',
    ),
    'applied',
  );
  const listed = data(pageSchema, await enumerate(9101, '?limit=1'));
  expect(
    listed.items.map((item) => `${item.provider}:${item.asset_id}`),
  ).toEqual(['second-provider:artwork-1']);
  expect(listed.next_cursor).not.toBeNull();
  const second = data(
    pageSchema,
    await enumerate(
      9101,
      `?limit=1&cursor=${encodeURIComponent(listed.next_cursor!)}`,
    ),
  );
  expect(second.items).toEqual([expectedAsset]);
  expect(second.next_cursor).toBeNull();
  for (const query of [
    '?limit=0',
    '?limit=101',
    '?limit=01',
    '?limit=1&limit=2',
    '?cursor=bad',
    '?cursor=%ZZ',
    '?search=art',
  ])
    failure(await enumerate(9101, query), 422, 'VALIDATION_FAILED');
  expect(data(pageSchema, await enumerate(99999999))).toEqual({
    items: [],
    next_cursor: null,
  });

  // #22: revisions do not replace identity; failed batches preserve old state.
  const newer = {
    ...observation,
    revision: 'synthetic-revision-2',
    observed_at: await after(timestamp),
    renditions: [
      {
        ...observation.renditions[0]!,
        url: 'https://artwork.example.invalid/synthetic-updated.png',
      },
    ],
  };
  outcome(await submit('artwork-1', auth.generation, newer), 'applied');
  const updated = data(asset, await resolve('artwork-1'));
  expect(updated.asset_id).toBe('artwork-1');
  expect(updated.revision).toBe('synthetic-revision-2');
  expect(updated.renditions[0]?.url).toBe(
    'https://artwork.example.invalid/synthetic-updated.png',
  );
  const currentControl = await inspect('artwork-1');
  failure(
    await change('artwork-1', 'withdrawn', auth.generation, {
      'X-Fixture-DB-Failure': 'batch',
    }),
    500,
    'INTERNAL_SERVER_ERROR',
  );
  expect(await inspect('artwork-1')).toEqual(currentControl);
  expect(data(asset, await resolve('artwork-1'))).toEqual(updated);
  failure(
    await submit(
      'artwork-1',
      auth.generation,
      {
        ...newer,
        revision: 'must-roll-back',
        observed_at: await after(newer.observed_at),
      },
      { 'X-Fixture-DB-Failure': 'batch' },
    ),
    500,
    'INTERNAL_SERVER_ERROR',
  );
  expect(await inspect('artwork-1')).toEqual(currentControl);
  expect(data(asset, await resolve('artwork-1'))).toEqual(updated);
  data(Schema.Unknown, await changeApp(9101, 'withdrawn', a.generation));
  expect(data(pageSchema, await enumerate(9101))).toEqual({
    items: [],
    next_cursor: null,
  });
  expect(data(asset, await resolve('artwork-1'))).toEqual(updated);
  data(
    Schema.Unknown,
    await changeApp(
      9101,
      'eligible',
      data(
        applicationPublication,
        await request(
          '/internal/v1/steam/applications/9101/publication',
          admin,
        ),
      ).generation,
    ),
  );
  expect(data(pageSchema, await enumerate(9101))).toEqual({
    items: [],
    next_cursor: null,
  });
  data(Schema.Unknown, await changeApp(9102, 'withdrawn', b.generation));
  failure(await resolve('artwork-1'), 404, 'NOT_FOUND');
  expect(data(pageSchema, await enumerate(9102))).toEqual({
    items: [],
    next_cursor: null,
  });
  const withdrawn = data(
    changed,
    await change('artwork-1', 'withdrawn', auth.generation),
  );
  failure(
    await request(
      path('artwork-1', '/ingestion-authorization'),
      ingestion,
      'POST',
    ),
    409,
    'PUBLICATION_WITHDRAWN',
  );
  expect(await inspect('artwork-1')).toEqual({
    provider: withdrawn.provider,
    asset_id: withdrawn.asset_id,
    state: withdrawn.state,
    generation: withdrawn.generation,
    generation_issued_at: withdrawn.generation_issued_at,
  });
  data(changed, await change('artwork-1', 'eligible', withdrawn.generation));
  failure(await resolve('artwork-1'), 404, 'NOT_FOUND');
  const freshApp = await acquireApp(9101);
  failure(
    await submit('artwork-1', auth.generation, {
      ...newer,
      applications: [{ steam_app_id: 9101, generation: freshApp.generation }],
    }),
    409,
    'PUBLICATION_GENERATION_MISMATCH',
  );
  const freshAuth = await acquireAsset('artwork-1');
  const fresh = syntheticArtworkObservation(
    [{ steam_app_id: 9101, generation: freshApp.generation }],
    Math.floor(Date.now() / 1000),
    'fresh-after-reinstatement',
  );
  outcome(await submit('artwork-1', freshAuth.generation, fresh), 'applied');
  expect(data(asset, await resolve('artwork-1')).revision).toBe(
    'fresh-after-reinstatement',
  );

  // #22: both requests reach their actual D1 batch before either is released.
  // Results are held until both commits, exposing incorrect post-write rereads.
  const gate = async (
    key: string,
    action: string,
    kind = 'batch',
    skip = 0,
  ) => {
    const response = await fetch(
      `${url}/fixture/http-gates/${key}/${action}?kind=${kind}&skip=${skip}`,
      {
        method: ['arrived', 'committed'].includes(action) ? 'GET' : 'POST',
        signal: AbortSignal.timeout(15_000),
      },
    );
    expect(response.status, `${key} ${action}`).toBe(200);
  };
  const race = async (
    key: string,
    left: (extra: Record<string, string>) => ReturnType<typeof request>,
    right: (extra: Record<string, string>) => ReturnType<typeof request>,
    leftFirst: boolean,
  ) => {
    const keys = [`${key}-left`, `${key}-right`];
    for (const key of keys) await gate(key, 'arm');
    const contenders = [
      left({ 'X-Fixture-Gate': keys[0]! }),
      right({ 'X-Fixture-Gate': keys[1]! }),
    ];
    for (const contender of contenders) void contender.catch(() => {});
    try {
      await Promise.all(keys.map((key) => gate(key, 'arrived')));
      for (const key of leftFirst ? keys : [...keys].reverse()) {
        await gate(key, 'release');
        await gate(key, 'committed');
      }
    } finally {
      for (const key of keys) {
        await gate(key, 'release');
        await gate(key, 'respond');
      }
    }
    return Promise.all(contenders);
  };
  let raceApplication = 9200;
  const setup = async (id: string) => {
    const application = await acquireApp(raceApplication++);
    const authorization = await acquireAsset(id);
    const observation = syntheticArtworkObservation(
      [
        {
          steam_app_id: application.steam_app_id,
          generation: application.generation,
        },
      ],
      Math.floor(Date.now() / 1000),
    );
    outcome(await submit(id, authorization.generation, observation), 'applied');
    return { application, authorization, observation };
  };
  for (const global of [true, false])
    for (const withdrawalFirst of [true, false]) {
      const id = `race-${global ? 'global' : 'application'}-${withdrawalFirst}`;
      const fixture = await setup(id);
      const next = {
        ...fixture.observation,
        revision: 'newer-racing-revision',
        observed_at: await after(fixture.observation.observed_at),
      };
      const [withdrawalResult, submissionResult] = await race(
        id,
        (extra) =>
          global
            ? change(id, 'withdrawn', fixture.authorization.generation, extra)
            : changeApp(
                fixture.application.steam_app_id,
                'withdrawn',
                fixture.application.generation,
                extra,
              ),
        (extra) => submit(id, fixture.authorization.generation, next, extra),
        withdrawalFirst,
      );
      expect(withdrawalResult!.status).toBe(200);
      if (withdrawalFirst)
        failure(submissionResult!, 409, 'PUBLICATION_WITHDRAWN');
      else outcome(submissionResult!, 'applied');
      failure(await resolve(id), 404, 'NOT_FOUND');
      expect(
        data(pageSchema, await enumerate(fixture.application.steam_app_id)),
      ).toEqual({ items: [], next_cursor: null });
    }
  for (const withdrawalFirst of [true, false]) {
    const id = `race-acquire-${withdrawalFirst}`;
    const fixture = await setup(id);
    const [withdrawalResult, acquisitionResult] = await race(
      id,
      (extra) =>
        change(id, 'withdrawn', fixture.authorization.generation, extra),
      (extra) =>
        request(
          path(id, '/ingestion-authorization'),
          ingestion,
          'POST',
          undefined,
          undefined,
          extra,
        ),
      withdrawalFirst,
    );
    data(changed, withdrawalResult!);
    if (withdrawalFirst)
      failure(acquisitionResult!, 409, 'PUBLICATION_WITHDRAWN');
    else
      expect(data(assetAuthorization, acquisitionResult!).generation).toBe(
        fixture.authorization.generation,
      );
    failure(await resolve(id), 404, 'NOT_FOUND');
  }
  for (const global of [true, false])
    for (const reinstateFirst of [true, false]) {
      const id = `race-reinstate-${global ? 'global' : 'application'}-${reinstateFirst}`;
      const fixture = await setup(id);
      const initialWithdrawal = global
        ? data(
            changed,
            await change(id, 'withdrawn', fixture.authorization.generation),
          )
        : data(
            Schema.Struct({
              ...applicationPublication.fields,
              outcome: Schema.String,
            }),
            await changeApp(
              fixture.application.steam_app_id,
              'withdrawn',
              fixture.application.generation,
            ),
          );
      const [reinstatement, staleSubmission] = await race(
        id,
        (extra) =>
          global
            ? change(id, 'eligible', initialWithdrawal.generation, extra)
            : changeApp(
                fixture.application.steam_app_id,
                'eligible',
                initialWithdrawal.generation,
                extra,
              ),
        (extra) =>
          submit(
            id,
            fixture.authorization.generation,
            fixture.observation,
            extra,
          ),
        reinstateFirst,
      );
      expect(reinstatement!.status).toBe(200);
      failure(
        staleSubmission!,
        409,
        reinstateFirst
          ? 'PUBLICATION_GENERATION_MISMATCH'
          : 'PUBLICATION_WITHDRAWN',
      );
      failure(await resolve(id), 404, 'NOT_FOUND');
    }

  // A read which already captured data may finish; a new primary read may not.
  for (const capturedBeforeWithdrawal of [true, false]) {
    const id = `read-visibility-${capturedBeforeWithdrawal}`;
    const fixture = await setup(id);
    await gate(id, 'arm', 'read', 1); // skip this request's registry verification
    const pending = resolve(id, 'synthetic', { 'X-Fixture-Gate': id });
    void pending.catch(() => {});
    await gate(id, 'arrived');
    if (capturedBeforeWithdrawal) {
      await gate(id, 'release');
      await gate(id, 'committed');
    }
    data(
      changed,
      await change(id, 'withdrawn', fixture.authorization.generation),
    );
    failure(await resolve(id), 404, 'NOT_FOUND');
    if (!capturedBeforeWithdrawal) {
      await gate(id, 'release');
      await gate(id, 'committed');
    }
    await gate(id, 'respond');
    const result = await pending;
    if (capturedBeforeWithdrawal) expect(data(asset, result).asset_id).toBe(id);
    else failure(result, 404, 'NOT_FOUND');
  }

  // Origin equivalence is intentional: preserve the URL spelling but compare
  // its effective HTTPS origin, unlike exact provenance and rights tuples.
  const equivalentOrigin = await setup('same-origin');
  const equivalentUrl = 'https://ARTWORK.example.invalid:443/same-origin.png';
  outcome(
    await submit('same-origin', equivalentOrigin.authorization.generation, {
      ...equivalentOrigin.observation,
      revision: 'equivalent-origin',
      observed_at: await after(equivalentOrigin.observation.observed_at),
      renditions: [
        { ...equivalentOrigin.observation.renditions[0]!, url: equivalentUrl },
      ],
    }),
    'applied',
  );
  expect(data(asset, await resolve('same-origin')).renditions[0]?.url).toBe(
    equivalentUrl,
  );

  // Paging is a new primary query, not a cached snapshot of former membership.
  const churn = await setup('churn-a');
  const last = await acquireAsset('churn-b');
  outcome(
    await submit(
      'churn-b',
      last.generation,
      syntheticArtworkObservation(
        churn.observation.applications,
        Math.floor(Date.now() / 1000),
      ),
    ),
    'applied',
  );
  const firstPage = data(
    pageSchema,
    await enumerate(churn.application.steam_app_id, '?limit=1'),
  );
  expect(firstPage.items[0]?.asset_id).toBe('churn-a');
  data(changed, await change('churn-b', 'withdrawn', last.generation));
  const before = await acquireAsset('churn-0');
  outcome(
    await submit(
      'churn-0',
      before.generation,
      syntheticArtworkObservation(
        churn.observation.applications,
        Math.floor(Date.now() / 1000),
      ),
    ),
    'applied',
  );
  expect(
    data(
      pageSchema,
      await enumerate(
        churn.application.steam_app_id,
        `?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
      ),
    ),
  ).toEqual({ items: [], next_cursor: null });
  expect(
    data(
      pageSchema,
      await enumerate(churn.application.steam_app_id, '?limit=1'),
    ).items[0]?.asset_id,
  ).toBe('churn-0');

  // Simulate successful replies lost to the caller: ignore them entirely and
  // reconcile through the documented read path before choosing another write.
  const reconcile = await setup('reconcile');
  const reconciledObservation = {
    ...reconcile.observation,
    revision: 'reconciled-revision',
    observed_at: await after(reconcile.observation.observed_at),
  };
  await submit(
    'reconcile',
    reconcile.authorization.generation,
    reconciledObservation,
  );
  expect(data(asset, await resolve('reconcile')).revision).toBe(
    'reconciled-revision',
  );
  outcome(
    await submit(
      'reconcile',
      reconcile.authorization.generation,
      reconciledObservation,
    ),
    'unchanged',
  );
  await change('reconcile', 'withdrawn', reconcile.authorization.generation);
  const reconciledControl = await inspect('reconcile');
  expect(reconciledControl.state).toBe('withdrawn');
  expect(reconciledControl.generation).not.toBe(
    reconcile.authorization.generation,
  );
  failure(
    await change('reconcile', 'eligible', reconcile.authorization.generation),
    409,
    'PUBLICATION_GENERATION_MISMATCH',
  );
  failure(await resolve('reconcile'), 404, 'NOT_FOUND');

  // #23: role revocation/registry outage fail closed, no stale fallback.
  failure(
    await resolve('artwork-1', 'synthetic', { 'X-Fixture-DB-Failure': 'read' }),
    503,
    'SERVICE_UNAVAILABLE',
  );
  expect((await register(['assets:read'], 1)).status).toBe(200);
  failure(await resolve('artwork-1'), 401, 'UNAUTHORIZED');
  expect((await register(['assets:read'], null, true)).status).toBe(200);
  failure(await resolve('artwork-1'), 401, 'UNAUTHORIZED');
  expect((await register(['assets:read'])).status).toBe(200);
  expect(data(asset, await resolve('artwork-1')).revision).toBe(
    'fresh-after-reinstatement',
  );
  expect((await request(`/v1/keys/${keyId}`, registry, 'DELETE')).status).toBe(
    200,
  );
  failure(await resolve('artwork-1'), 401, 'UNAUTHORIZED');
};
