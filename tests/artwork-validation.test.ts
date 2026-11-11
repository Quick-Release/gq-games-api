// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { Cause, Effect, Exit, Option } from 'effect';
import { expect, it } from 'vite-plus/test';
import { validateArtwork } from '../src/services/artwork-input';
import { syntheticArtworkObservation } from './fixtures/artwork';

const now = 1_794_400_000;
const observation = syntheticArtworkObservation(
  [{ steam_app_id: 1001, generation: 'synthetic-generation' }],
  now,
);
const rejected = (input: unknown, path: string, code: string) => {
  const exit = Effect.runSyncExit(validateArtwork(input, now));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error('Invalid artwork was accepted');
  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error('No artwork validation failure');
  expect(failure.value.code).toBe('VALIDATION_FAILED');
  expect(failure.value.issues).toContainEqual({ path, code });
};

it('bounds artwork observation time by the server clock with five minutes of tolerance', () => {
  expect(
    Effect.runSync(
      validateArtwork({ ...observation, observed_at: now + 300 }, now),
    ).observed_at,
  ).toBe(now + 300);
  for (const observed_at of [now + 301, now * 1000, Number.MAX_SAFE_INTEGER]) {
    rejected(
      { ...observation, observed_at },
      'observed_at',
      'TIMESTAMP_IN_FUTURE',
    );
  }
});

it('rejects edge whitespace without changing accepted artwork text', () => {
  rejected(
    { ...observation, revision: ' padded ' },
    'revision',
    'EDGE_WHITESPACE',
  );
  rejected(
    {
      ...observation,
      provenance: { ...observation.provenance, extractor_version: ' padded ' },
    },
    'provenance.extractor_version',
    'EDGE_WHITESPACE',
  );
  for (const key of ['holder', 'permission', 'attribution'] as const) {
    rejected(
      { ...observation, rights: { ...observation.rights, [key]: ' padded ' } },
      `rights.${key}`,
      'EDGE_WHITESPACE',
    );
  }
  rejected(
    {
      ...observation,
      applications: [{ steam_app_id: 1001, generation: ' padded ' }],
    },
    'applications[0].generation',
    'EDGE_WHITESPACE',
  );
  const valid = {
    ...observation,
    revision: 'Café  revision',
    rights: {
      ...observation.rights,
      attribution: 'Credit  with  internal spaces',
    },
  };
  expect(Effect.runSync(validateArtwork(valid, now))).toEqual(valid);
});
