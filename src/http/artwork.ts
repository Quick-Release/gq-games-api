// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect, Layer } from 'effect';
import type { Context, Hono } from 'hono';
import { Database } from '../db/database';
import { Artwork } from '../services/artwork';
import { isAssetIdentifier } from '../services/artwork-input';
import { CatalogFailure } from '../services/catalog-failure';
import {
  authenticate,
  catalogError,
  parseAppId,
  readJsonBody,
  rejectBody,
  requireHttps,
  requireReadScope,
  runApi,
  type CatalogHttpEnv,
  type CatalogHttpOptions,
} from './catalog';

export type ArtworkHttpOptions = CatalogHttpOptions & {
  artworkLayer?: Layer.Layer<Artwork>;
};
const internal = '/internal/v1/assets/:provider/:assetId';
const reference = (c: Context<CatalogHttpEnv>) => {
  const provider = c.req.param('provider');
  const assetId = c.req.param('assetId');
  return isAssetIdentifier(provider) && isAssetIdentifier(assetId)
    ? { provider, assetId }
    : undefined;
};
const runArtwork = <A>(
  c: Context<CatalogHttpEnv>,
  options: ArtworkHttpOptions,
  operation: Effect.Effect<A, CatalogFailure, Artwork>,
) => {
  if (!options.artworkLayer && !c.env?.DB)
    return catalogError(c, 503, 'SERVICE_UNAVAILABLE');
  const layer =
    options.artworkLayer ??
    Artwork.layer.pipe(
      Layer.provide(
        Database.layer(c.get('requestLifecycle').database(c.env.DB)),
      ),
    );
  return runApi(c, options, operation, layer);
};
const page = (url: string) => {
  const parsed = new URL(url);
  if (/%(?![0-9a-f]{2})/i.test(parsed.search)) return;
  const query = parsed.searchParams;
  if (
    [...query.keys()].some((key) => !['limit', 'cursor'].includes(key)) ||
    query.getAll('limit').length > 1 ||
    query.getAll('cursor').length > 1
  )
    return;
  const rawLimit = query.get('limit') ?? '20';
  if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) return;
  const rawCursor = query.get('cursor');
  let cursor: { provider: string; asset_id: string } | null = null;
  if (rawCursor !== null) {
    // URLSearchParams performs the single URI-component decode.
    const pair = rawCursor.split(':');
    if (
      pair.length !== 2 ||
      !isAssetIdentifier(pair[0]) ||
      !isAssetIdentifier(pair[1])
    )
      return;
    cursor = { provider: pair[0], asset_id: pair[1] };
  }
  return { limit: Number(rawLimit), cursor };
};

export const mountArtwork = (
  app: Hono<CatalogHttpEnv>,
  options: ArtworkHttpOptions,
) => {
  app.get('/v1/assets/:provider/:assetId', async (c) => {
    const denied =
      requireHttps(c, options) ?? (await requireReadScope(c, 'assets:read'));
    if (denied) return denied;
    const ref = reference(c);
    if (!ref) return catalogError(c, 422, 'VALIDATION_FAILED');
    return runArtwork(
      c,
      options,
      Effect.gen(function* () {
        return yield* (yield* Artwork).resolve(ref.provider, ref.assetId);
      }),
    );
  });
  app.get('/v1/steam/applications/:steamAppId/assets', async (c) => {
    const denied =
      requireHttps(c, options) ?? (await requireReadScope(c, 'assets:read'));
    if (denied) return denied;
    const steamAppId = parseAppId(c.req.param('steamAppId'));
    if (steamAppId === undefined) return catalogError(c, 400, 'INVALID_APP_ID');
    const decoded = page(c.req.url);
    if (!decoded) return catalogError(c, 422, 'VALIDATION_FAILED');
    return runArtwork(
      c,
      options,
      Effect.gen(function* () {
        return yield* (yield* Artwork).enumerate(steamAppId, decoded);
      }),
    );
  });
  app.post(`${internal}/ingestion-authorization`, async (c) => {
    const denied = authenticate(c, 'ingestion', options);
    if (denied) return denied;
    const ref = reference(c);
    if (!ref) return catalogError(c, 422, 'VALIDATION_FAILED');
    const bodyError = await rejectBody(c);
    if (bodyError) return bodyError;
    return runArtwork(
      c,
      options,
      Effect.gen(function* () {
        return yield* (yield* Artwork).acquireAuthorization(
          ref.provider,
          ref.assetId,
        );
      }),
    );
  });
  app.put(`${internal}/observation`, async (c) => {
    const denied = authenticate(c, 'ingestion', options);
    if (denied) return denied;
    const ref = reference(c);
    if (!ref) return catalogError(c, 422, 'VALIDATION_FAILED');
    const body = await readJsonBody(c);
    if (body.error) return body.error;
    return runArtwork(
      c,
      options,
      Effect.gen(function* () {
        return yield* (yield* Artwork).submitObservation(
          ref.provider,
          ref.assetId,
          c.req.header('X-Publication-Generation'),
          body.input,
          c.env.APPROVED_ARTWORK_SOURCES,
        );
      }),
    );
  });
  app.get(`${internal}/publication`, async (c) => {
    const denied = authenticate(c, 'admin', options);
    if (denied) return denied;
    const ref = reference(c);
    if (!ref) return catalogError(c, 422, 'VALIDATION_FAILED');
    return runArtwork(
      c,
      options,
      Effect.gen(function* () {
        return yield* (yield* Artwork).inspectPublication(
          ref.provider,
          ref.assetId,
        );
      }),
    );
  });
  app.put(`${internal}/publication`, async (c) => {
    const denied = authenticate(c, 'admin', options);
    if (denied) return denied;
    const ref = reference(c);
    if (!ref) return catalogError(c, 422, 'VALIDATION_FAILED');
    const body = await readJsonBody(c);
    if (body.error) return body.error;
    return runArtwork(
      c,
      options,
      Effect.gen(function* () {
        return yield* (yield* Artwork).changePublication(
          ref.provider,
          ref.assetId,
          body.input,
        );
      }),
    );
  });
};
