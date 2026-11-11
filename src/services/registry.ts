// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { Database } from '../db/database';
import { apiKeyRegistry } from '../db/schema';
import { CatalogFailure } from './catalog-failure';

export const registryId = /^[A-Za-z0-9_-]{1,128}$/;
const recordSchema = Schema.Struct({
  verifier: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  tenant_id: Schema.String.check(Schema.isPattern(registryId)),
  scopes: Schema.Array(Schema.Literals(['catalog:read', 'assets:read'])).check(
    Schema.isMaxLength(2),
  ),
  expires_at: Schema.NullOr(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  revoked: Schema.Boolean,
});
const publicRecord = (row: typeof apiKeyRegistry.$inferSelect) => ({
  key_id: row.keyId,
  tenant_id: row.tenantId,
  scopes: row.scopes,
  expires_at: row.expiresAt,
  revoked: row.revoked,
});

export const manageRegistry = (
  keyId: string,
  operation: 'upsert' | 'inspect' | 'revoke',
  input?: unknown,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (operation === 'upsert') {
      const record = yield* Schema.decodeUnknownEffect(recordSchema)(input, {
        onExcessProperty: 'error',
      }).pipe(
        Effect.mapError(
          () => new CatalogFailure({ code: 'VALIDATION_FAILED' }),
        ),
      );
      if (new Set(record.scopes).size !== record.scopes.length) {
        return yield* new CatalogFailure({ code: 'VALIDATION_FAILED' });
      }
      const values = {
        keyId,
        verifier: record.verifier,
        tenantId: record.tenant_id,
        scopes: [...record.scopes].sort(),
        expiresAt: record.expires_at,
        revoked: record.revoked,
      };
      const rows = yield* db
        .insert(apiKeyRegistry)
        .values(values)
        .onConflictDoUpdate({ target: apiKeyRegistry.keyId, set: values })
        .returning();
      return publicRecord(rows[0]!);
    }
    const rows =
      operation === 'revoke'
        ? yield* db
            .update(apiKeyRegistry)
            .set({ revoked: true })
            .where(eq(apiKeyRegistry.keyId, keyId))
            .returning()
        : yield* db
            .select()
            .from(apiKeyRegistry)
            .where(eq(apiKeyRegistry.keyId, keyId));
    if (!rows[0]) return yield* new CatalogFailure({ code: 'NOT_FOUND' });
    return publicRecord(rows[0]);
  }).pipe(
    Effect.catchTag('EffectDrizzleQueryError', () =>
      Effect.fail(new CatalogFailure({ code: 'SERVICE_UNAVAILABLE' })),
    ),
  );
