// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

export const syntheticArtworkRights = {
  holder: 'Synthetic Artwork Author',
  permission: 'Synthetic fixture only; no real artwork permission',
  attribution: 'Synthetic artwork test fixture',
};

export const syntheticArtworkPolicies = ['synthetic', 'second-provider'].map(
  (provider) => ({
    provider,
    source_url: 'https://artwork.example.invalid/source',
    extractor_version: 'synthetic-artwork-v1',
    rights: syntheticArtworkRights,
    delivery_origins: ['https://artwork.example.invalid'],
  }),
);

export const syntheticArtworkObservation = (
  applications: { steam_app_id: number; generation: string }[],
  observedAt: number,
  revision = 'synthetic-revision-1',
) => ({
  revision,
  observed_at: observedAt,
  renditions: [
    {
      id: 'landscape',
      url: 'https://artwork.example.invalid/synthetic-landscape.png',
      mime: 'image/png',
      width: 1280,
      height: 720,
    },
  ],
  provenance: {
    source_url: 'https://artwork.example.invalid/source',
    extractor_version: 'synthetic-artwork-v1',
  },
  rights: syntheticArtworkRights,
  applications,
});
