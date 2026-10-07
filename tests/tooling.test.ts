// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { apiConfig } from '../alchemy.run';
import pkg from '../package.json';

// Configuration regression tests, not Cloudflare binding/runtime validation.
describe('Alchemy tooling', () => {
  it('owns the Worker configuration without a Wrangler file', () => {
    expect(existsSync('wrangler.jsonc')).toBe(false);
    expect(existsSync('wrangler.json')).toBe(false);
    expect(existsSync('wrangler.toml')).toBe(false);
    expect(apiConfig.main).toBe('./src/index.ts');
    expect(apiConfig.compatibility.flags).toContain('nodejs_compat');
    expect(apiConfig.dev).toEqual({
      host: '127.0.0.1',
      port: 8787,
      strictPort: true,
    });
  });

  it('keeps local tooling separate from deployment stages', () => {
    expect(pkg.scripts.dev).toBe('alchemy dev --stage local-dev');
    expect(pkg.scripts.preview).toBe(
      'alchemy dev --config scripts/preview-worker.ts --stage local-preview',
    );
    expect(pkg.scripts.build).toBe('node scripts/build-worker.ts');
    expect(pkg.devDependencies).not.toHaveProperty('@cloudflare/vite-plugin');
    expect(pkg.devDependencies).not.toHaveProperty('wrangler');
    expect(apiConfig.build.output).toEqual({
      dir: 'dist',
      entryFileNames: 'index.js',
    });
  });
});
