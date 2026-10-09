// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';
import { CatalogFailure } from './catalog-failure';

// Publication commands contain no content or reason. Validation reports only
// fixed contract paths, never caller-supplied key names, values, or generations.
export const validatePublicationCommand = Effect.fn(
  'Catalog.validatePublicationCommand',
)(function* (steamAppId: number, input: unknown) {
  const issues: NonNullable<CatalogFailure['issues']> = [];
  if (
    !Number.isInteger(steamAppId) ||
    steamAppId < 1 ||
    steamAppId > 4294967295
  ) {
    issues.push({ path: 'steam_app_id', code: 'INVALID_APP_ID' });
  }
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    return yield* Effect.fail(
      new CatalogFailure({
        code: 'VALIDATION_FAILED',
        issues: [
          ...issues,
          {
            path: 'body',
            code: input === undefined ? 'REQUIRED' : 'INVALID_TYPE',
          },
        ],
      }),
    );
  }
  if (
    Object.keys(input).some(
      (key) => key !== 'state' && key !== 'expected_generation',
    )
  ) {
    issues.push({ path: 'body', code: 'UNKNOWN_FIELD' });
  }
  const state = 'state' in input ? input.state : undefined;
  const expectation =
    'expected_generation' in input ? input.expected_generation : undefined;
  if (state !== 'eligible' && state !== 'withdrawn') {
    issues.push({
      path: 'state',
      code:
        state === undefined
          ? 'REQUIRED'
          : typeof state === 'string'
            ? 'INVALID_VALUE'
            : 'INVALID_TYPE',
    });
  }
  if (expectation !== null) {
    const code =
      expectation === undefined
        ? 'REQUIRED'
        : typeof expectation !== 'string'
          ? 'INVALID_TYPE'
          : expectation.trim().length === 0
            ? 'BLANK_STRING'
            : expectation.trim() !== expectation
              ? 'EDGE_WHITESPACE'
              : Array.from(expectation).length > 128
                ? 'STRING_TOO_LONG'
                : undefined;
    if (code) issues.push({ path: 'expected_generation', code });
  }
  if (
    issues.length > 0 ||
    (state !== 'eligible' && state !== 'withdrawn') ||
    (expectation !== null && typeof expectation !== 'string')
  ) {
    return yield* Effect.fail(
      new CatalogFailure({ code: 'VALIDATION_FAILED', issues }),
    );
  }
  return { state, expected_generation: expectation };
});
