// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { defineConfig } from 'vite-plus';

// Vite+ owns quality tooling; Alchemy owns Worker builds and local workerd.
export default defineConfig({
  fmt: {
    singleQuote: true,
    printWidth: 80,
    proseWrap: 'always',
    ignorePatterns: [
      'pnpm-lock.yaml',
      'dist/**',
      '.alchemy/**',
      '.wrangler/**',
    ],
  },
  lint: {
    ignorePatterns: ['dist/**', '.alchemy/**', '.wrangler/**'],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    watch: false,
  },
});
