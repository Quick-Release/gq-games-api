CREATE TABLE `artwork_association` (
	`provider` text NOT NULL,
	`asset_id` text NOT NULL,
	`steam_app_id` integer NOT NULL,
	`asset_generation` text NOT NULL,
	`application_generation` text NOT NULL,
	CONSTRAINT `artwork_association_pk` PRIMARY KEY(`provider`, `asset_id`, `steam_app_id`),
	CONSTRAINT "artwork_association_app_id" CHECK(typeof("steam_app_id") = 'integer' and "steam_app_id" between 1 and 4294967295)
);
--> statement-breakpoint
CREATE TABLE `artwork_content` (
	`provider` text NOT NULL,
	`asset_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `artwork_content_pk` PRIMARY KEY(`provider`, `asset_id`),
	CONSTRAINT "artwork_content_time" CHECK(typeof("observed_at") = 'integer' and "observed_at" >= 0),
	CONSTRAINT "artwork_content_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `artwork_publication` (
	`provider` text NOT NULL,
	`asset_id` text NOT NULL,
	`state` text NOT NULL,
	`generation` text NOT NULL,
	`generation_issued_at` integer NOT NULL,
	CONSTRAINT `artwork_publication_pk` PRIMARY KEY(`provider`, `asset_id`),
	CONSTRAINT "artwork_provider" CHECK(length("provider") between 1 and 128 and "provider" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "artwork_asset_id" CHECK(length("asset_id") between 1 and 128 and "asset_id" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "artwork_state" CHECK("state" in ('eligible', 'withdrawn')),
	CONSTRAINT "artwork_generation" CHECK(length("generation") > 0),
	CONSTRAINT "artwork_issued_at" CHECK(typeof("generation_issued_at") = 'integer' and "generation_issued_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `artwork_association_application` ON `artwork_association` (`steam_app_id`,`provider`,`asset_id`);--> statement-breakpoint
-- Application lifecycle changes end only that application's associations.
-- This trigger shares Catalog's D1 transaction, including snapshot deletion;
-- it deliberately leaves shared asset content and other application links intact.
CREATE TRIGGER artwork_application_publication_fence
AFTER UPDATE OF state, generation ON steam_application_publication
WHEN NEW.state = 'withdrawn' OR NEW.generation IS NOT OLD.generation
BEGIN
  DELETE FROM artwork_association WHERE steam_app_id = NEW.steam_app_id;
END;
