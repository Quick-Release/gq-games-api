// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { Database } from '../db/database';
import { apiKeyRegistry } from '../db/schema';
import { registryId } from './registry';

export type Principal = {
  tenant_id: string;
  scopes: readonly 'catalog:read'[];
};

// Parsing is independent of D1 so malformed input never needs a registry read.
export const parseApiKey = (authorization: string | undefined) => {
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!bearer) return null;
  const [keyId, secret, extra] = bearer.split('.');
  if (
    !keyId ||
    !registryId.test(keyId) ||
    !secret ||
    !/^[0-9a-f]{64}$/i.test(secret) ||
    extra !== undefined
  )
    return null;
  return { keyId, secret };
};

// Null rejects unknown, corrupt, expired and revoked registry records alike.
// Route policy (including required scopes) belongs to the HTTP layer.
export const verifyApiKey = (
  credential: NonNullable<ReturnType<typeof parseApiKey>>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select()
      .from(apiKeyRegistry)
      .where(eq(apiKeyRegistry.keyId, credential.keyId));
    const row = rows[0];
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(credential.secret),
      ),
    );
    // Always compare equal-length digests, including for an unknown identifier.
    const validVerifier =
      typeof row?.verifier === 'string' && /^[0-9a-f]{64}$/.test(row.verifier);
    const expected = Uint8Array.from(
      (validVerifier ? row.verifier : '0'.repeat(64)).match(/../g)!,
      (byte) => Number.parseInt(byte, 16),
    );
    const matches = timingSafeEqual(new Uint8Array(digest), expected);
    const now = yield* Clock.currentTimeMillis;
    if (
      !validVerifier ||
      !matches ||
      !row ||
      row.revoked ||
      (row.expiresAt !== null && row.expiresAt <= Math.floor(now / 1000))
    )
      return null;
    return { tenant_id: row.tenantId, scopes: row.scopes } satisfies Principal;
  });
