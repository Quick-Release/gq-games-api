CREATE TABLE `steam_application_publication` (
	`steam_app_id` integer PRIMARY KEY,
	`state` text NOT NULL,
	`generation` text NOT NULL,
	`generation_issued_at` integer NOT NULL,
	CONSTRAINT "publication_app_id" CHECK(typeof("steam_app_id") = 'integer' and "steam_app_id" between 1 and 4294967295),
	CONSTRAINT "publication_state" CHECK("state" in ('eligible', 'withdrawn')),
	CONSTRAINT "publication_generation" CHECK(length("generation") > 0),
	CONSTRAINT "publication_issued_at" CHECK(typeof("generation_issued_at") = 'integer' and "generation_issued_at" >= 0)
);
