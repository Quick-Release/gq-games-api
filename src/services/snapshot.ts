// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Clock, Effect } from 'effect';
import { CatalogFailure } from './catalog-failure';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const isBoundedString = (value: unknown, maximum: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.trim() === value &&
  Array.from(value).length <= maximum;

const isAppId = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= 4294967295;

const isCalendarDate = (value: string) => {
  if (value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0)
  );
};

const makeParser = () => {
  const issues: NonNullable<CatalogFailure['issues']> = [];
  const issue = (path: string, code: string) => {
    if (issues.length < 20) issues.push({ path, code });
  };
  const invalid = (value: unknown, path: string, code: string) => {
    issue(path, value === undefined ? 'REQUIRED' : code);
    return undefined;
  };
  const strictKeys = (
    value: Record<string, unknown>,
    path: string,
    keys: readonly string[],
  ) => {
    // Report the containing schema path, never an arbitrary submitted key.
    if (Object.keys(value).some((key) => !keys.includes(key))) {
      issue(path, 'UNKNOWN_FIELD');
    }
  };
  const object = (value: unknown, path: string, keys: readonly string[]) => {
    if (!isObject(value)) return invalid(value, path, 'INVALID_TYPE');
    strictKeys(value, path, keys);
    return value;
  };
  const string = (value: unknown, path: string, maximum: number) => {
    if (typeof value !== 'string') return invalid(value, path, 'INVALID_TYPE');
    if (value.length === 0 || value.trim().length === 0) {
      return invalid(value, path, 'BLANK_STRING');
    }
    if (value.trim() !== value) return invalid(value, path, 'EDGE_WHITESPACE');
    if (Array.from(value).length > maximum)
      return invalid(value, path, 'STRING_TOO_LONG');
    return value;
  };
  const enumeration = <const T extends string>(
    value: unknown,
    path: string,
    allowed: readonly T[],
  ) => {
    if (typeof value !== 'string') return invalid(value, path, 'INVALID_TYPE');
    const decoded = allowed.find((candidate) => candidate === value);
    return decoded ?? invalid(value, path, 'INVALID_VALUE');
  };
  const credits = (value: unknown, path: string) => {
    if (value === null) return null;
    if (!Array.isArray(value)) return invalid(value, path, 'INVALID_TYPE');
    if (value.length > 32) return invalid(value, path, 'TOO_MANY_ITEMS');
    const entries: readonly unknown[] = value;
    const names: string[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const name = string(entry, `${path}[${index}]`, 256);
      if (name === undefined) continue;
      if (seen.has(name)) issue(`${path}[${index}]`, 'DUPLICATE_ITEM');
      seen.add(name);
      names.push(name);
    }
    return names;
  };
  const operatingSystems = (value: unknown, path: string) => {
    if (value === null) return null;
    if (!Array.isArray(value)) return invalid(value, path, 'INVALID_TYPE');
    if (value.length > 3) return invalid(value, path, 'TOO_MANY_ITEMS');
    const entries: readonly unknown[] = value;
    const systems: ('windows' | 'macos' | 'linux')[] = [];
    for (const [index, entry] of entries.entries()) {
      const system = enumeration(entry, `${path}[${index}]`, [
        'windows',
        'macos',
        'linux',
      ]);
      if (system === undefined) continue;
      if (systems.includes(system))
        issue(`${path}[${index}]`, 'DUPLICATE_ITEM');
      systems.push(system);
    }
    return systems.sort();
  };
  const releaseDate = (value: unknown) => {
    const path = 'metadata.release.date';
    if (!isObject(value)) return invalid(value, path, 'INVALID_TYPE');
    const kind = enumeration(value.kind, `${path}.kind`, [
      'exact',
      'window',
      'unknown',
    ]);
    switch (kind) {
      case 'exact': {
        strictKeys(value, path, ['kind', 'date']);
        const date = string(value.date, `${path}.date`, 10);
        if (date === undefined) return undefined;
        if (!isCalendarDate(date))
          return invalid(date, `${path}.date`, 'INVALID_DATE');
        return { kind, date };
      }
      case 'window': {
        strictKeys(value, path, ['kind', 'window']);
        const window = string(value.window, `${path}.window`, 256);
        return window === undefined ? undefined : { kind, window };
      }
      case 'unknown':
        strictKeys(value, path, ['kind']);
        return { kind };
      default:
        strictKeys(value, path, ['kind']);
        return undefined;
    }
  };
  const release = (value: unknown) => {
    const parsed = object(value, 'metadata.release', ['status', 'date']);
    if (!parsed) return undefined;
    const status = enumeration(parsed.status, 'metadata.release.status', [
      'upcoming',
      'released',
      'unknown',
    ]);
    const date = releaseDate(parsed.date);
    if (status === undefined || date === undefined) return undefined;
    return { status, date };
  };
  const metadata = (value: unknown, steamAppId: number) => {
    const parsed = object(value, 'metadata', [
      'title',
      'product_type',
      'base_app_id',
      'developers',
      'publishers',
      'supported_os',
      'release',
    ]);
    if (!parsed) return undefined;
    const title = string(parsed.title, 'metadata.title', 512);
    const productType = enumeration(
      parsed.product_type,
      'metadata.product_type',
      ['game', 'demo', 'dlc'],
    );
    const baseAppId =
      parsed.base_app_id === null
        ? null
        : isAppId(parsed.base_app_id)
          ? parsed.base_app_id
          : invalid(
              parsed.base_app_id,
              'metadata.base_app_id',
              'INVALID_APP_ID',
            );
    if (baseAppId !== null && baseAppId !== undefined) {
      if (baseAppId === steamAppId)
        issue('metadata.base_app_id', 'SELF_REFERENCE');
      if (productType === 'game') issue('metadata.base_app_id', 'MUST_BE_NULL');
    }
    const developers = credits(parsed.developers, 'metadata.developers');
    const publishers = credits(parsed.publishers, 'metadata.publishers');
    const supportedOs = operatingSystems(
      parsed.supported_os,
      'metadata.supported_os',
    );
    const decodedRelease = release(parsed.release);
    if (
      title === undefined ||
      productType === undefined ||
      baseAppId === undefined ||
      developers === undefined ||
      publishers === undefined ||
      supportedOs === undefined ||
      decodedRelease === undefined
    )
      return undefined;
    return {
      title,
      product_type: productType,
      base_app_id: baseAppId,
      developers,
      publishers,
      supported_os: supportedOs,
      release: decodedRelease,
    };
  };
  const provenance = (value: unknown, nowSeconds: number) => {
    const parsed = object(value, 'provenance', [
      'source_url',
      'language',
      'observed_at',
      'extractor_version',
    ]);
    if (!parsed) return undefined;
    // URL bounds are structural (422); URL safety/approval is a later 403 check.
    const sourceUrl = string(parsed.source_url, 'provenance.source_url', 2048);
    const language = enumeration(parsed.language, 'provenance.language', [
      'en',
    ]);
    const observedAt =
      typeof parsed.observed_at === 'number' &&
      Number.isSafeInteger(parsed.observed_at) &&
      parsed.observed_at >= 0
        ? parsed.observed_at
        : invalid(
            parsed.observed_at,
            'provenance.observed_at',
            'INVALID_TIMESTAMP',
          );
    if (observedAt !== undefined && observedAt > nowSeconds + 300) {
      issue('provenance.observed_at', 'TIMESTAMP_IN_FUTURE');
    }
    const extractorVersion = string(
      parsed.extractor_version,
      'provenance.extractor_version',
      128,
    );
    if (
      sourceUrl === undefined ||
      language === undefined ||
      observedAt === undefined ||
      extractorVersion === undefined
    )
      return undefined;
    return {
      source_url: sourceUrl,
      language,
      observed_at: observedAt,
      extractor_version: extractorVersion,
    };
  };
  const snapshot = (steamAppId: number, value: unknown, nowSeconds: number) => {
    const parsed = object(value, 'body', [
      'event_id',
      'metadata',
      'provenance',
    ]);
    if (!parsed) return undefined;
    const eventId = string(parsed.event_id, 'event_id', 128);
    const decodedMetadata = metadata(parsed.metadata, steamAppId);
    const decodedProvenance = provenance(parsed.provenance, nowSeconds);
    if (
      eventId === undefined ||
      decodedMetadata === undefined ||
      decodedProvenance === undefined
    )
      return undefined;
    // Fixed key order, freshly reconstructed objects, and canonical OS ordering
    // make JSON equality meaningful without rewriting source text or credits.
    return {
      event_id: eventId,
      metadata: decodedMetadata,
      provenance: decodedProvenance,
    };
  };
  return { issues, issue, string, snapshot };
};

/** Canonical snapshot body only; generation is validated but not part of it. */
export type Snapshot = NonNullable<
  ReturnType<ReturnType<typeof makeParser>['snapshot']>
>;

/**
 * approvedSources must be a JSON STRING encoding an array of these exact pairs:
 * [{"source_url":"https://catalog.example.invalid/apps/1001","extractor_version":"synthetic-v1"}]
 * Every tuple must have exactly these two fields. Missing/malformed policy,
 * unsafe/non-synthetic tuples, and no exact matching tuple fail closed (403).
 * Only example.invalid and its subdomains are permitted. No real source can be
 * approved by this implementation. Strings are preserved and matched exactly;
 * parsing a URL for safety never replaces it with a normalized URL spelling.
 */
export type ApprovedSourcePolicy = Pick<
  Snapshot['provenance'],
  'source_url' | 'extractor_version'
>[];

const isSyntheticUrl = (value: string) => {
  // Disallow parser-repaired authorities, credentials, query/fragment markers
  // (even empty ones), backslashes, whitespace, and ASCII control characters.
  if (
    !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*example\.invalid(?::[0-9]+)?(?:\/|$)/i.test(
      value,
    ) ||
    /[?#\\\s]/u.test(value) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      (url.hostname === 'example.invalid' ||
        url.hostname.endsWith('.example.invalid'))
    );
  } catch {
    return false;
  }
};

const sourceIsApproved = (snapshot: Snapshot, approvedSources: unknown) => {
  if (
    typeof approvedSources !== 'string' ||
    !isSyntheticUrl(snapshot.provenance.source_url)
  )
    return false;
  try {
    const decoded: unknown = JSON.parse(approvedSources);
    if (!Array.isArray(decoded)) return false;
    const policies: readonly unknown[] = decoded;
    let matches = false;
    for (const policy of policies) {
      if (
        !isObject(policy) ||
        Object.keys(policy).length !== 2 ||
        !Object.hasOwn(policy, 'source_url') ||
        !Object.hasOwn(policy, 'extractor_version') ||
        typeof policy.source_url !== 'string' ||
        !isBoundedString(policy.source_url, 2048) ||
        !isSyntheticUrl(policy.source_url) ||
        !isBoundedString(policy.extractor_version, 128)
      )
        return false;
      if (
        policy.source_url === snapshot.provenance.source_url &&
        policy.extractor_version === snapshot.provenance.extractor_version
      )
        matches = true;
    }
    return matches;
  } catch {
    return false;
  }
};

/**
 * Pure application validation using Effect's clock; no source fetch or SQL.
 * Callers must authenticate/bound/decode transport first, then make generation,
 * observation-floor, and persistence decisions in one atomic SQL operation.
 */
export const validateSnapshot = Effect.fn('Catalog.validateSnapshot')(
  function* (
    steamAppId: number,
    generation: unknown,
    input: unknown,
    approvedSources: unknown,
  ) {
    const parser = makeParser();
    if (!isAppId(steamAppId)) parser.issue('steam_app_id', 'INVALID_APP_ID');
    parser.string(generation, 'X-Publication-Generation', 128);
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const snapshot = parser.snapshot(steamAppId, input, nowSeconds);
    if (snapshot === undefined || parser.issues.length > 0) {
      return yield* Effect.fail(
        new CatalogFailure({
          code: 'VALIDATION_FAILED',
          issues: parser.issues,
        }),
      );
    }
    if (!sourceIsApproved(snapshot, approvedSources)) {
      return yield* Effect.fail(
        new CatalogFailure({ code: 'SOURCE_NOT_APPROVED' }),
      );
    }
    return snapshot;
  },
);
