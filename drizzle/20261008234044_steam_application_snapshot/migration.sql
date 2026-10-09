CREATE TABLE `steam_application_snapshot` (
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
	CONSTRAINT "snapshot_event_id" CHECK(length(cast("event_id" as blob)) > 0 and length("event_id") <= 128),
	CONSTRAINT "snapshot_title" CHECK(length(cast("title" as blob)) > 0 and length("title") <= 512),
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
          and length(cast("release_window" as blob)) > 0 and length("release_window") <= 256)),
	CONSTRAINT "snapshot_source_url" CHECK(length("source_url") between 1 and 2048),
	CONSTRAINT "snapshot_language" CHECK("language" = 'en'),
	CONSTRAINT "snapshot_observed_at" CHECK(typeof("observed_at") = 'integer' and "observed_at" >= 0),
	CONSTRAINT "snapshot_extractor_version" CHECK(length(cast("extractor_version" as blob)) > 0 and length("extractor_version") <= 128)
);
