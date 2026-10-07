// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { defineConfig } from 'vite-plus';

// Vite+ owns quality tooling; Alchemy owns Worker builds and local workerd.
export default defineConfig(({ mode }) => ({
  fmt: {
    singleQuote: true,
    printWidth: 80,
    proseWrap: 'always',
    ignorePatterns: [
      'pnpm-lock.yaml',
      '.agents/skills/**',
      'dist/**',
      '.alchemy/**',
      '.wrangler/**',
    ],
  },
  lint: {
    ignorePatterns: [
      '.agents/skills/**',
      'dist/**',
      '.alchemy/**',
      '.wrangler/**',
    ],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
  test: {
    include:
      mode === 'integration'
        ? ['tests/integration/**/*.test.ts']
        : ['tests/*.test.ts'],
    watch: false,
  },
}));
