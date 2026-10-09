-- Copyright (C) 2026 gq-games-api contributors
-- SPDX-License-Identifier: AGPL-3.0-only
-- See LICENSE in the repository root.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_steam_application_snapshot` (
	`steam_app_id` integer PRIMARY KEY,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`product_type` text NOT NULL,
	`base_app_id` integer,
	`developers` text,
	`publishers` text,
	`supported_os` text,
	`release_status` text NOT NULL,
	`release_date_kind` text NOT NULL,
	`release_date` text,
	`release_window` text,
	`source_url` text NOT NULL,
	`language` text NOT NULL,
	`observed_at` integer NOT NULL,
	`extractor_version` text NOT NULL,
	CONSTRAINT "snapshot_app_id" CHECK(typeof("steam_app_id") = 'integer' and "steam_app_id" between 1 and 4294967295),
	CONSTRAINT "snapshot_event_id" CHECK(case when json_valid("event_id") then json_type("event_id") = 'text' and length(cast(json_extract("event_id", '$') as blob)) > 0 and length(json_extract("event_id", '$')) <= 128 else 0 end),
	CONSTRAINT "snapshot_title" CHECK(case when json_valid("title") then json_type("title") = 'text' and length(cast(json_extract("title", '$') as blob)) > 0 and length(json_extract("title", '$')) <= 512 else 0 end),
	CONSTRAINT "snapshot_product_type" CHECK("product_type" in ('game', 'demo', 'dlc')),
	CONSTRAINT "snapshot_base_app_id" CHECK("base_app_id" is null or (typeof("base_app_id") = 'integer' and "base_app_id" between 1 and 4294967295 and "base_app_id" <> "steam_app_id" and "product_type" <> 'game')),
	CONSTRAINT "snapshot_developers" CHECK("developers" is null or case when json_valid("developers") then json_type("developers") = 'array' and json_array_length("developers") <= 32 else 0 end),
	CONSTRAINT "snapshot_publishers" CHECK("publishers" is null or case when json_valid("publishers") then json_type("publishers") = 'array' and json_array_length("publishers") <= 32 else 0 end),
	CONSTRAINT "snapshot_supported_os" CHECK("supported_os" is null or case when json_valid("supported_os") then json_type("supported_os") = 'array' and json_array_length("supported_os") <= 3 else 0 end),
	CONSTRAINT "snapshot_release_status" CHECK("release_status" in ('upcoming', 'released', 'unknown')),
	CONSTRAINT "snapshot_release_date" CHECK(("release_date_kind" = 'unknown' and "release_date" is null and "release_window" is null)
        or ("release_date_kind" = 'exact' and "release_date" is not null and "release_window" is null
          and "release_date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          and coalesce(strftime('%Y-%m-%d', "release_date", '+0 days') = "release_date", 0))
        or ("release_date_kind" = 'window' and "release_date" is null and "release_window" is not null
          and case when json_valid("release_window") then json_type("release_window") = 'text'
            and length(cast(json_extract("release_window", '$') as blob)) > 0
            and length(json_extract("release_window", '$')) <= 256 else 0 end)),
	CONSTRAINT "snapshot_source_url" CHECK(case when json_valid("source_url") then json_type("source_url") = 'text' and length(cast(json_extract("source_url", '$') as blob)) > 0 and length(json_extract("source_url", '$')) <= 2048 else 0 end),
	CONSTRAINT "snapshot_language" CHECK("language" = 'en'),
	CONSTRAINT "snapshot_observed_at" CHECK(typeof("observed_at") = 'integer' and "observed_at" >= 0),
	CONSTRAINT "snapshot_extractor_version" CHECK(case when json_valid("extractor_version") then json_type("extractor_version") = 'text' and length(cast(json_extract("extractor_version", '$') as blob)) > 0 and length(json_extract("extractor_version", '$')) <= 128 else 0 end)
);
--> statement-breakpoint
-- Encode existing raw scalar strings once; arrays and ASCII fields stay unchanged.
-- Preserve SQL NULL for absent windows, rather than the JSON literal 'null'.
INSERT INTO `__new_steam_application_snapshot`(`steam_app_id`, `event_id`, `title`, `product_type`, `base_app_id`, `developers`, `publishers`, `supported_os`, `release_status`, `release_date_kind`, `release_date`, `release_window`, `source_url`, `language`, `observed_at`, `extractor_version`) SELECT `steam_app_id`, json_quote(`event_id`), json_quote(`title`), `product_type`, `base_app_id`, `developers`, `publishers`, `supported_os`, `release_status`, `release_date_kind`, `release_date`, CASE WHEN `release_window` IS NULL THEN NULL ELSE json_quote(`release_window`) END, json_quote(`source_url`), `language`, `observed_at`, json_quote(`extractor_version`) FROM `steam_application_snapshot`;--> statement-breakpoint
DROP TABLE `steam_application_snapshot`;--> statement-breakpoint
ALTER TABLE `__new_steam_application_snapshot` RENAME TO `steam_application_snapshot`;--> statement-breakpoint
PRAGMA foreign_keys=ON;