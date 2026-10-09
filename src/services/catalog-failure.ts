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
