-- Copyright (C) 2026 gq-games-api contributors
-- SPDX-License-Identifier: AGPL-3.0-only
-- See LICENSE in the repository root.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_key_registry` (
	`key_id` text PRIMARY KEY,
	`verifier` text NOT NULL,
	`tenant_id` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer,
	`revoked` integer NOT NULL,
	CONSTRAINT "registry_key_id" CHECK(length("key_id") between 1 and 128 and "key_id" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "registry_verifier" CHECK(length("verifier") = 64 and "verifier" not glob '*[^0-9a-f]*'),
	CONSTRAINT "registry_tenant" CHECK(length("tenant_id") between 1 and 128 and "tenant_id" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "registry_scopes" CHECK("scopes" in ('[]', '["catalog:read"]', '["assets:read"]', '["assets:read","catalog:read"]')),
	CONSTRAINT "registry_expiry" CHECK("expires_at" is null or (typeof("expires_at") = 'integer' and "expires_at" between 0 and 9007199254740991)),
	CONSTRAINT "registry_revoked" CHECK("revoked" in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_api_key_registry`(`key_id`, `verifier`, `tenant_id`, `scopes`, `expires_at`, `revoked`) SELECT `key_id`, `verifier`, `tenant_id`, `scopes`, `expires_at`, `revoked` FROM `api_key_registry`;--> statement-breakpoint
DROP TABLE `api_key_registry`;--> statement-breakpoint
ALTER TABLE `__new_api_key_registry` RENAME TO `api_key_registry`;--> statement-breakpoint
PRAGMA foreign_keys=ON;