// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Synthetic test-only table; never part of the application migration schema.
export const ormProbe = sqliteTable('orm_probe', {
  id: integer().primaryKey(),
  value: text().notNull(),
});
