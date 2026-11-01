// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { Database } from '../db/database';
import { apiKeyRegistry } from '../db/schema';

export type Principal = {
  tenant_id: string;
  scopes: readonly 'catalog:read'[];
};

export const apiKeyPattern = /^Bearer ([A-Za-z0-9_-]{1,128})\.([0-9a-f]{64})$/i;

// Null is the same rejection for malformed, unknown, expired and revoked keys.
// Route policy (including required scopes) belongs to the HTTP layer.
export const verifyApiKey = (authorization: string | undefined) =>
  Effect.gen(function* () {
    const parts = authorization?.match(apiKeyPattern);
    if (!parts) return null;
    const db = yield* Database;
    const rows = yield* db
      .select()
      .from(apiKeyRegistry)
      .where(eq(apiKeyRegistry.keyId, parts[1]!));
    const row = rows[0];
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts[2]!)),
    );
    // Always compare equal-length digests, including for an unknown identifier.
    const expected = Uint8Array.from(
      (row?.verifier ?? '0'.repeat(64)).match(/../g)!,
      (byte) => Number.parseInt(byte, 16),
    );
    const matches = timingSafeEqual(new Uint8Array(digest), expected);
    const now = yield* Clock.currentTimeMillis;
    if (
      !matches ||
      !row ||
      row.revoked ||
      (row.expiresAt !== null && row.expiresAt <= Math.floor(now / 1000))
    )
      return null;
    return { tenant_id: row.tenantId, scopes: row.scopes } satisfies Principal;
  });
