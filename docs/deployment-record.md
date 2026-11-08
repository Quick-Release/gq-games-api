# Deployment record

Factual record of hosted deployments of this repository's Worker. Account
identifiers, zone identifiers and credentials are deliberately omitted.

## 2026-11-06: first hosted deployment (ADR 0002)

| Item           | Value                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Origin         | `https://games-api.bnq.pt` (custom domain; `workers.dev` disabled)                             |
| Stage          | `production`                                                                                   |
| Revision       | `7c5f3eabe42780a60b18e273bf54050ac09f3a84` (merge of PR #15)                                   |
| Deployment     | `7e10f5b7-3805-4273-9144-33d80f634c36`, version `c9628fd2-4ea4-4a36-b7c4-1915f53b8137` at 100% |
| Access mode    | Anonymous (`CATALOG_ACCESS_MODE` unset, no registry credential)                                |
| State          | Existing Alchemy Cloudflare state store in the same account (encrypted)                        |
| Resources      | Worker `Api`, D1 `Database`, rate-limit binding (100 per 60 s per IP)                          |
| Published data | One synthetic verification record, App ID 1001                                                 |

The synthetic record was published once through the ingestion route (`applied`),
with source `https://catalog.example.invalid/apps/1001` and extractor
`synthetic-v1`. It is not real game information.

### Verification (2026-11-06, from outside Cloudflare)

| Request                                                      | Result                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `GET /health`                                                | 200                                                        |
| `GET /`                                                      | 200, `source.revision` = the revision above                |
| `GET /v1/steam/applications/1001`, no `Authorization` header | 200, `no-store`, server `X-Request-ID`, synthetic snapshot |
| `GET /v1/steam/applications/1002`                            | 404 `NOT_FOUND`                                            |
| `GET /v1/steam/applications/01`                              | 400 `INVALID_APP_ID`                                       |
| `GET` over plain HTTP                                        | 403 `FORBIDDEN`                                            |
| `GET /v1/keys/{keyId}` (registry not configured)             | 503                                                        |
| `POST .../ingestion-authorization` without credentials       | 401                                                        |
| `workers.dev` URL                                            | 404                                                        |

The anonymous 200 body:

```json
{
  "data": {
    "steam_app_id": 1001,
    "metadata": {
      "title": "Synthetic Verification Record",
      "product_type": "game",
      "base_app_id": null,
      "developers": [],
      "publishers": [],
      "supported_os": [],
      "release": { "status": "unknown", "date": { "kind": "unknown" } }
    },
    "provenance": {
      "source_url": "https://catalog.example.invalid/apps/1001",
      "language": "en",
      "observed_at": 1794001280
    }
  }
}
```

These checks show the deployed routing, access mode and contract shape. They do
not show real-source rights, production quotas, or behavior under load.

## 2026-11-08: rights-backed source policy (ADR 0003)

| Item           | Value                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Origin         | `https://games-api.bnq.pt` (unchanged)                                                         |
| Stage          | `production`                                                                                   |
| Revision       | `4d01f0983498ab6b8ae2ab33f992a43392de8a3f` (merge of PR #17)                                   |
| Deployment     | `0fc3e5fe-9f7a-41db-b53f-767250cbc43e`, version `f28ff415-8432-4fd3-bf9a-7d2ae0302c26` at 100% |
| Changes        | `APPROVED_SNAPSHOT_SOURCES` and `SOURCE_REVISION` bindings on `Api` only; D1 and secrets noop  |
| Access mode    | Anonymous (unchanged)                                                                          |
| Published data | Unchanged: the synthetic App ID 1001 record only                                               |

`APPROVED_SNAPSHOT_SOURCES` is now the value proposed in ADR 0003: the synthetic
tuple plus one `wikidata-entity-v1` tuple each for Q279446 (620), Q23013817
(413150) and Q59756366 (1145360). These come from gq-crawl's Wikidata source
record (W1–W4, W5a at `8240e61`). This deployment published no real snapshot;
`gq-crawl` publishes them.

The owner approved the merge, configuration change and redeploy in the
requesting session. Following ADR 0002, each step (plan, deploy, deployment
lookup) minted one account-owned Cloudflare token that expired within an hour,
and revoked it when the step ended. Worker secrets came from Sigillo (GQ Games
API, `production`) and were never printed. An `alchemy plan` against this
revision showed only the two binding updates before the deploy ran.

### Verification (2026-11-08, from outside Cloudflare)

| Request                           | Result                                            |
| --------------------------------- | ------------------------------------------------- |
| `GET /health`                     | 200                                               |
| `GET /`                           | 200, `source.revision` = the revision above       |
| `GET /v1/steam/applications/1001` | 200, the synthetic record, unchanged              |
| `GET /v1/steam/applications/620`  | 404 `NOT_FOUND` (not yet published by `gq-crawl`) |
| `GET /v1/steam/applications/1002` | 404 `NOT_FOUND`                                   |
| `GET /v1/steam/applications/01`   | 400 `INVALID_APP_ID`                              |
| `GET` over plain HTTP             | 403 `FORBIDDEN`                                   |

These checks show the deployed revision and that existing behavior is unchanged.
Acceptance of the real tuples is shown by the unit tests in PR #17, not yet by a
production submission.
