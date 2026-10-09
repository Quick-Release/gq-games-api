// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { expect, it, vi } from 'vite-plus/test';
import { createApp } from '../src/app';

const privatePrefix =
  'https://catalog.example.invalid/internal/v1/steam/applications/1001';

it.each([
  ['D1_ERROR: Network connection lost.', 503, 'SERVICE_UNAVAILABLE'],
  [
    'D1_ERROR: D1 DB is overloaded. Too many requests queued.',
    503,
    'SERVICE_UNAVAILABLE',
  ],
  [
    'D1_ERROR: no such table: synthetic_private_table',
    500,
    'INTERNAL_SERVER_ERROR',
  ],
  ['D1_TYPE_ERROR: synthetic_private_parameter', 500, 'INTERNAL_SERVER_ERROR'],
  ['synthetic unexpected driver failure', 500, 'INTERNAL_SERVER_ERROR'],
] as const)(
  'maps driver failures consistently across all five routes: %s',
  async (message, status, code) => {
    // Exercise real pinned Catalog/Database error wrappers in Node. This is NOT
    // evidence of workerd outages, transaction rollback, or Cloudflare bindings.
    const env = {
      INGESTION_BEARER_TOKEN: crypto.randomUUID(),
      PUBLICATION_ADMIN_BEARER_TOKEN: crypto.randomUUID(),
      APPROVED_SNAPSHOT_SOURCES: JSON.stringify([
        {
          source_url: 'https://catalog.example.invalid/apps/1001',
          extractor_version: 'synthetic-v1',
        },
      ]),
    };
    const snapshot = {
      event_id: 'synthetic-driver-failure-event',
      metadata: {
        title: 'Synthetic Driver Failure Demo',
        product_type: 'demo',
        base_app_id: null,
        developers: null,
        publishers: [],
        supported_os: [],
        release: { status: 'unknown', date: { kind: 'unknown' } },
      },
      provenance: {
        source_url: 'https://catalog.example.invalid/apps/1001',
        language: 'en',
        observed_at: Math.floor(Date.now() / 1000),
        extractor_version: 'synthetic-v1',
      },
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [path, method, token, body] of [
        [
          'https://catalog.example.invalid/v1/steam/applications/1001',
          'GET',
          undefined,
          undefined,
        ],
        [
          `${privatePrefix}/ingestion-authorization`,
          'POST',
          env.INGESTION_BEARER_TOKEN,
          undefined,
        ],
        [
          `${privatePrefix}/publication`,
          'GET',
          env.PUBLICATION_ADMIN_BEARER_TOKEN,
          undefined,
        ],
        [
          `${privatePrefix}/publication`,
          'PUT',
          env.PUBLICATION_ADMIN_BEARER_TOKEN,
          { state: 'withdrawn', expected_generation: null },
        ],
        [
          `${privatePrefix}/snapshot`,
          'PUT',
          env.INGESTION_BEARER_TOKEN,
          snapshot,
        ],
      ] as const) {
        const binding = {
          prepare: vi.fn(() => {
            throw new Error(message);
          }),
          batch: async () => [],
          exec: async () => ({ count: 0, duration: 0 }),
          dump: async () => new ArrayBuffer(0),
          withSession: () => {
            throw new Error('Sessions must not be used');
          },
        } satisfies D1Database;
        const headers = new Headers({
          'X-Request-ID': 'synthetic-caller-driver-id',
          'X-Publication-Generation': 'synthetic-generation',
        });
        if (token) headers.set('Authorization', `Bearer ${token}`);
        if (body) headers.set('Content-Type', 'application/json');
        const response = await createApp().request(
          path,
          {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          { ...env, DB: binding },
        );
        expect(response.status).toBe(status);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const requestId = response.headers.get('X-Request-ID');
        expect(requestId).toBeTruthy();
        expect(requestId).not.toBe('synthetic-caller-driver-id');
        expect(await response.json()).toEqual({
          error: { code, request_id: requestId },
        });
        expect(binding.prepare).toHaveBeenCalledOnce();
      }
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  },
);
