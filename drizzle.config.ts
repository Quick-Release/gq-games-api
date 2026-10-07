// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import type { Config } from 'drizzle-kit';

// Generation only: Alchemy owns D1 bindings and migration application.
// Keep credentials out of Drizzle Kit; it must not push to cloud databases.
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
} satisfies Config;
