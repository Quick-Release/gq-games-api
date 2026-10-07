// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Effect } from 'effect';

// Effect is the application boundary; infrastructure stays out of the runtime.
export const getHealth = Effect.sync(() => ({
  service: 'gq-games-api',
  status: 'ok',
  maturity: 'research',
}));
