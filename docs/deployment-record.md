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
