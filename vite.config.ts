// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite-plus';

export default defineConfig(({ mode }) => ({
  // Unit tests exercise Hono directly; dev/build use the real Workers runtime.
  plugins: mode === 'test' ? [] : cloudflare(),
  server: { port: 8787 },
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
}));
