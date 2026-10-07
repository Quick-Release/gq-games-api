// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import type { InferEnv } from 'alchemy/Cloudflare';
import type { Api } from '../alchemy.run';

// Type-only imports keep infrastructure out of the Worker bundle while binding
// names and types follow the single Alchemy declaration.
export type WorkerEnv = InferEnv<typeof Api>;
