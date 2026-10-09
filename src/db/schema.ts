// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Absence represents uninitialized control. No source content, reason, expiry,
// or delivery history belongs in this durable publication fence.
export const publicationControl = sqliteTable(
  'steam_application_publication',
  {
    steamAppId: integer('steam_app_id').primaryKey(),
    state: text('state', { enum: ['eligible', 'withdrawn'] }).notNull(),
    generation: text('generation').notNull(),
    generationIssuedAt: integer('generation_issued_at').notNull(),
  },
  (table) => [
    check(
      'publication_app_id',
      sql`typeof(${table.steamAppId}) = 'integer' and ${table.steamAppId} between 1 and 4294967295`,
    ),
    check(
      'publication_state',
      sql`${table.state} in ('eligible', 'withdrawn')`,
    ),
    check('publication_generation', sql`length(${table.generation}) > 0`),
    check(
      'publication_issued_at',
      sql`typeof(${table.generationIssuedAt}) = 'integer' and ${table.generationIssuedAt} >= 0`,
    ),
  ],
);

// One deletable, complete observation per App ID. Explicit scalar JSON string
// columns preserve lone UTF-16 surrogates across D1's UTF-8 boundary; credits
// and the canonical OS set use JSON arrays. Base links have no catalog foreign key.
export const applicationSnapshot = sqliteTable(
  'steam_application_snapshot',
  {
    steamAppId: integer('steam_app_id').primaryKey(),
    eventId: text('event_id', { mode: 'json' }).$type<string>().notNull(),
    title: text('title', { mode: 'json' }).$type<string>().notNull(),
    productType: text('product_type', {
      enum: ['game', 'demo', 'dlc'],
    }).notNull(),
    baseAppId: integer('base_app_id'),
    developers: text('developers', { mode: 'json' }).$type<readonly string[]>(),
    publishers: text('publishers', { mode: 'json' }).$type<readonly string[]>(),
    supportedOs: text('supported_os', { mode: 'json' }).$type<
      readonly ('windows' | 'macos' | 'linux')[]
    >(),
    releaseStatus: text('release_status', {
      enum: ['upcoming', 'released', 'unknown'],
    }).notNull(),
    releaseDateKind: text('release_date_kind', {
      enum: ['exact', 'window', 'unknown'],
    }).notNull(),
    releaseDate: text('release_date'),
    releaseWindow: text('release_window', { mode: 'json' }).$type<string>(),
    sourceUrl: text('source_url', { mode: 'json' }).$type<string>().notNull(),
    language: text('language', { enum: ['en'] }).notNull(),
    observedAt: integer('observed_at').notNull(),
    extractorVersion: text('extractor_version', { mode: 'json' })
      .$type<string>()
      .notNull(),
  },
  (table) => [
    check(
      'snapshot_app_id',
      sql`typeof(${table.steamAppId}) = 'integer' and ${table.steamAppId} between 1 and 4294967295`,
    ),
    // CASE guards JSON extraction. SQLite length(TEXT) stops at NUL, so
    // decoded byte length checks nonemptiness without rejecting NUL strings;
    // validation enforces full Unicode code-point bounds before any write.
    check(
      'snapshot_event_id',
      sql`case when json_valid(${table.eventId}) then json_type(${table.eventId}) = 'text' and length(cast(json_extract(${table.eventId}, '$') as blob)) > 0 and length(json_extract(${table.eventId}, '$')) <= 128 else 0 end`,
    ),
    check(
      'snapshot_title',
      sql`case when json_valid(${table.title}) then json_type(${table.title}) = 'text' and length(cast(json_extract(${table.title}, '$') as blob)) > 0 and length(json_extract(${table.title}, '$')) <= 512 else 0 end`,
    ),
    check(
      'snapshot_product_type',
      sql`${table.productType} in ('game', 'demo', 'dlc')`,
    ),
    check(
      'snapshot_base_app_id',
      sql`${table.baseAppId} is null or (typeof(${table.baseAppId}) = 'integer' and ${table.baseAppId} between 1 and 4294967295 and ${table.baseAppId} <> ${table.steamAppId} and ${table.productType} <> 'game')`,
    ),
    // CASE also prevents malformed JSON from reaching JSON array functions.
    // Element bounds/uniqueness and OS canonicalization belong to validation.
    check(
      'snapshot_developers',
      sql`${table.developers} is null or case when json_valid(${table.developers}) then json_type(${table.developers}) = 'array' and json_array_length(${table.developers}) <= 32 else 0 end`,
    ),
    check(
      'snapshot_publishers',
      sql`${table.publishers} is null or case when json_valid(${table.publishers}) then json_type(${table.publishers}) = 'array' and json_array_length(${table.publishers}) <= 32 else 0 end`,
    ),
    check(
      'snapshot_supported_os',
      sql`${table.supportedOs} is null or case when json_valid(${table.supportedOs}) then json_type(${table.supportedOs}) = 'array' and json_array_length(${table.supportedOs}) <= 3 else 0 end`,
    ),
    check(
      'snapshot_release_status',
      sql`${table.releaseStatus} in ('upcoming', 'released', 'unknown')`,
    ),
    check(
      'snapshot_release_date',
      sql`(${table.releaseDateKind} = 'unknown' and ${table.releaseDate} is null and ${table.releaseWindow} is null)
        or (${table.releaseDateKind} = 'exact' and ${table.releaseDate} is not null and ${table.releaseWindow} is null
          and ${table.releaseDate} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          and coalesce(strftime('%Y-%m-%d', ${table.releaseDate}, '+0 days') = ${table.releaseDate}, 0))
        or (${table.releaseDateKind} = 'window' and ${table.releaseDate} is null and ${table.releaseWindow} is not null
          and case when json_valid(${table.releaseWindow}) then json_type(${table.releaseWindow}) = 'text'
            and length(cast(json_extract(${table.releaseWindow}, '$') as blob)) > 0
            and length(json_extract(${table.releaseWindow}, '$')) <= 256 else 0 end)`,
    ),
    check(
      'snapshot_source_url',
      sql`case when json_valid(${table.sourceUrl}) then json_type(${table.sourceUrl}) = 'text' and length(cast(json_extract(${table.sourceUrl}, '$') as blob)) > 0 and length(json_extract(${table.sourceUrl}, '$')) <= 2048 else 0 end`,
    ),
    check('snapshot_language', sql`${table.language} = 'en'`),
    check(
      'snapshot_observed_at',
      sql`typeof(${table.observedAt}) = 'integer' and ${table.observedAt} >= 0`,
    ),
    check(
      'snapshot_extractor_version',
      sql`case when json_valid(${table.extractorVersion}) then json_type(${table.extractorVersion}) = 'text' and length(cast(json_extract(${table.extractorVersion}, '$') as blob)) > 0 and length(json_extract(${table.extractorVersion}, '$')) <= 128 else 0 end`,
    ),
  ],
);
