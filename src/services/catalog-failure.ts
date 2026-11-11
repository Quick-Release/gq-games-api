// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Data } from 'effect';

// Never retain submitted values, credentials, SQL, or underlying driver causes.
// HTTP maps these application codes to statuses; issues use safe field paths.
export class CatalogFailure extends Data.TaggedError('CatalogFailure')<{
  code:
    | 'NOT_FOUND'
    | 'PUBLICATION_WITHDRAWN'
    | 'SERVICE_UNAVAILABLE'
    | 'INTERNAL_SERVER_ERROR'
    | 'VALIDATION_FAILED'
    | 'SOURCE_NOT_APPROVED'
    | 'PUBLICATION_GENERATION_MISMATCH'
    | 'SNAPSHOT_CONFLICT';
  issues?: { path: string; code: string }[];
}> {}

// The pinned D1 client wraps every driver failure in SqlError/UnknownError.
// Recognize only documented transient D1 messages; unknown/permanent failures
// are 500, never mistaken for retryable unavailability. Inspect but do not retain
// or log any driver text. No application retry or second query is introduced.
// https://developers.cloudflare.com/d1/observability/debug-d1/#list-of-d1_errors
const temporaryDatabaseFailures = new Set([
  'Network connection lost.',
  'D1 DB reset because its code was updated.',
  'Internal error while starting up D1 DB storage caused object to be reset.',
  'Internal error in D1 DB storage caused object to be reset.',
  'Cannot resolve D1 DB due to transient issue on remote node.',
  "Can't read from request stream because client disconnected.",
  'D1 DB storage operation exceeded timeout which caused object to be reset.',
  'D1 DB is overloaded. Requests queued for too long.',
  'D1 DB is overloaded. Too many requests queued.',
  "D1 DB's isolate exceeded its memory limit and was reset.",
  'D1 DB exceeded its CPU time limit and was reset.',
]);
export const databaseFailure = (cause: unknown) => {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : '';
  const temporary = temporaryDatabaseFailures.has(
    message.replace(/^D1_ERROR: /, ''),
  );
  return new CatalogFailure({
    code: temporary ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_SERVER_ERROR',
  });
};
