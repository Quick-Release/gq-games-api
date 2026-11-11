// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';
import { CatalogFailure } from './catalog-failure';

const invalid = (path: string): never => {
  throw new CatalogFailure({
    code: 'VALIDATION_FAILED',
    issues: [{ path, code: 'INVALID_VALUE' }],
  });
};
const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);
const object = (input: unknown, keys: readonly string[], path: string) => {
  if (
    !isRecord(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    return invalid(path);
  const value: Record<string, unknown> = input;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid(path);
  return value;
};
const text = (value: unknown, maximum: number, path: string) => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Array.from(value).length > maximum
  )
    return invalid(path);
  if (value.trim() !== value) {
    throw new CatalogFailure({
      code: 'VALIDATION_FAILED',
      issues: [{ path, code: 'EDGE_WHITESPACE' }],
    });
  }
  return value;
};
export const isAssetIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const identifier = (value: unknown, path: string) =>
  isAssetIdentifier(value) ? value : invalid(path);
const integer = (
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
) => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalid(path);
  return value;
};
// Stable HTTPS locations only: reject credentials, query tokens, parser repair,
// whitespace and fragments. Preserve the supplied spelling for exact approval.
const url = (input: unknown, path: string) => {
  const value = text(input, 2048, path);
  if (
    !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]+)?(?:\/|$)/i.test(
      value,
    ) ||
    /[?#\\\s]/u.test(value) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return invalid(path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(path);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  )
    return invalid(path);
  // A URL parser must not silently repair dot segments or percent dot segments.
  const authorityEnd = value.indexOf('/', 8);
  const originalPath = authorityEnd < 0 ? '/' : value.slice(authorityEnd);
  if (parsed.pathname !== originalPath) return invalid(path);
  return value;
};
const list = <T>(
  input: unknown,
  maximum: number,
  path: string,
  decode: (value: unknown, path: string) => T,
) => {
  if (!Array.isArray(input) || input.length < 1 || input.length > maximum)
    return invalid(path);
  const entries: readonly unknown[] = input;
  return entries.map((entry, index) => decode(entry, `${path}[${index}]`));
};
const unique = <T>(
  values: T[],
  key: (value: T) => string | number,
  path: string,
) => {
  if (new Set(values.map(key)).size !== values.length) return invalid(path);
  return values;
};
const rights = (input: unknown, path: string) => {
  const value = object(input, ['holder', 'permission', 'attribution'], path);
  return {
    holder: text(value.holder, 2048, `${path}.holder`),
    permission: text(value.permission, 2048, `${path}.permission`),
    attribution: text(value.attribution, 2048, `${path}.attribution`),
  };
};
const observation = (input: unknown) => {
  const value = object(
    input,
    [
      'revision',
      'observed_at',
      'renditions',
      'provenance',
      'rights',
      'applications',
    ],
    'body',
  );
  const provenance = object(
    value.provenance,
    ['source_url', 'extractor_version'],
    'provenance',
  );
  return {
    revision: text(value.revision, 128, 'revision'),
    observed_at: integer(
      value.observed_at,
      0,
      Number.MAX_SAFE_INTEGER,
      'observed_at',
    ),
    renditions: unique(
      list(value.renditions, 16, 'renditions', (input, path) => {
        const entry = object(
          input,
          ['id', 'url', 'mime', 'width', 'height'],
          path,
        );
        const mime = text(entry.mime, 32, `${path}.mime`);
        if (
          !['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(
            mime,
          )
        )
          return invalid(`${path}.mime`);
        return {
          id: identifier(entry.id, `${path}.id`),
          url: url(entry.url, `${path}.url`),
          mime,
          width: integer(entry.width, 1, 32768, `${path}.width`),
          height: integer(entry.height, 1, 32768, `${path}.height`),
        };
      }),
      (entry) => entry.id,
      'renditions',
    ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    provenance: {
      source_url: url(provenance.source_url, 'provenance.source_url'),
      extractor_version: text(
        provenance.extractor_version,
        128,
        'provenance.extractor_version',
      ),
    },
    rights: rights(value.rights, 'rights'),
    applications: unique(
      list(value.applications, 32, 'applications', (input, path) => {
        const entry = object(input, ['steam_app_id', 'generation'], path);
        return {
          steam_app_id: integer(
            entry.steam_app_id,
            1,
            4294967295,
            `${path}.steam_app_id`,
          ),
          generation: text(entry.generation, 128, `${path}.generation`),
        };
      }),
      (entry) => entry.steam_app_id,
      'applications',
    ).sort((a, b) => a.steam_app_id - b.steam_app_id),
  };
};
export type ArtworkObservation = ReturnType<typeof observation>;
export const validateArtwork = (input: unknown, now: number) =>
  Effect.try({
    try: () => {
      const decoded = observation(input);
      if (decoded.observed_at > now + 300) {
        throw new CatalogFailure({
          code: 'VALIDATION_FAILED',
          issues: [{ path: 'observed_at', code: 'TIMESTAMP_IN_FUTURE' }],
        });
      }
      return decoded;
    },
    catch: (error) =>
      error instanceof CatalogFailure
        ? error
        : new CatalogFailure({ code: 'VALIDATION_FAILED' }),
  });

export const approveArtwork = (
  provider: string,
  observation: ArtworkObservation,
  policy: unknown,
) =>
  Effect.try({
    try: () => {
      if (typeof policy !== 'string') throw new Error();
      const decoded: unknown = JSON.parse(policy);
      if (!Array.isArray(decoded) || decoded.length > 64) throw new Error();
      const entries: readonly unknown[] = decoded;
      // Decode every entry before looking for a match: malformed policy denies all.
      const policies = entries.map((input) => {
        const entry = object(
          input,
          [
            'provider',
            'source_url',
            'extractor_version',
            'rights',
            'delivery_origins',
          ],
          'policy',
        );
        return {
          provider: identifier(entry.provider, 'policy.provider'),
          source_url: url(entry.source_url, 'policy.source_url'),
          extractor_version: text(
            entry.extractor_version,
            128,
            'policy.extractor_version',
          ),
          rights: rights(entry.rights, 'policy.rights'),
          delivery_origins: unique(
            list(
              entry.delivery_origins,
              16,
              'policy.delivery_origins',
              (input, path) => {
                const value = url(input, path);
                if (new URL(value).origin !== value) return invalid(path);
                return value;
              },
            ),
            (value) => value,
            'policy.delivery_origins',
          ),
        };
      });
      const approved = policies.some(
        (entry) =>
          entry.provider === provider &&
          entry.source_url === observation.provenance.source_url &&
          entry.extractor_version ===
            observation.provenance.extractor_version &&
          JSON.stringify(entry.rights) === JSON.stringify(observation.rights) &&
          observation.renditions.every((rendition) =>
            entry.delivery_origins.includes(new URL(rendition.url).origin),
          ),
      );
      if (!approved) throw new Error();
    },
    catch: () => new CatalogFailure({ code: 'SOURCE_NOT_APPROVED' }),
  });
