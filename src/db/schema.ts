// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Absence represents uninitialized control. No source content, reason, expiry,
// or delivery history belongs in this durable publication fence.
export const publicationControl = sqliteTable(
  'steam_application_publication',
  {
    steamAppId: integer('steam_app_id').primaryKey(),
    state: text('state', { enum: ['eligible', 'withdrawn'] }).notNull(),
    generation: text('generation').notNull(),
    generationIssuedAt: integer('generation_issued_at').notNull(),
  },
  (table) => [
    check(
      'publication_app_id',
      sql`typeof(${table.steamAppId}) = 'integer' and ${table.steamAppId} between 1 and 4294967295`,
    ),
    check(
      'publication_state',
      sql`${table.state} in ('eligible', 'withdrawn')`,
    ),
    check('publication_generation', sql`length(${table.generation}) > 0`),
    check(
      'publication_issued_at',
      sql`typeof(${table.generationIssuedAt}) = 'integer' and ${table.generationIssuedAt} >= 0`,
    ),
  ],
);
