# ADR 0003: Real source tuples backed by a recorded rights policy

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** repository maintainer (service owner), on the request of the
  catalog and source-rights owner

## Context

Until now, snapshot submission admitted only reserved synthetic sources: any
`source_url` (in a snapshot or in `APPROVED_SNAPSHOT_SOURCES`) whose host was
not `example.invalid` or one of its subdomains failed closed with 403
`SOURCE_NOT_APPROVED`, whatever the configured policy said. ADR 0002 accordingly
limited the first hosted deployment to one synthetic verification record.

`gq-crawl`, the only producer, now has its first recorded source-rights policy:
Wikidata item data (CC0) through the Linked Data Interface, extractor
`wikidata-entity-v1`. The owner recorded it on 2026-11-07/08 in gq-crawl
[`docs/research/wikidata-source-records.md`](https://github.com/Quick-Release/gq-crawl/blob/8240e61ac9c8a653c7f50c491d96fd6d8d223171/docs/research/wikidata-source-records.md)
at commit `8240e61ac9c8a653c7f50c491d96fd6d8d223171`
([gq-crawl#59](https://github.com/Quick-Release/gq-crawl/pull/59)):

- **W1–W4** cover the included fields, access, storage, public redistribution,
  attribution (not required; Wikidata is credited voluntarily through
  `source_url`, with no endorsement implied), retention (none imposed; this
  service may keep its publication control indefinitely) and deletion (the
  owner's decision, through publication-admin withdrawal). This satisfies the
  contract's
  [approved-source boundary](../steam-catalog-contract.md#approved-source-boundary).
- **W5a** approves three individual records.

## Decision

1. **Any HTTPS host may be listed.** A policy tuple and a snapshot `source_url`
   may name a real HTTPS URL. Every other safety check stays: HTTPS only; a
   literal ASCII host (no userinfo, IP-literal brackets, percent-encoding or
   IDNA conversion) and optional numeric port; no query, fragment (even empty
   markers), backslash, whitespace or control characters; no parser repair; at
   most 2048 code points.
2. **Exact, individual listing.** Matching remains exact and unnormalized on the
   complete (`source_url`, `extractor_version`) tuple. There are no host, prefix
   or pattern wildcards, so `APPROVED_SNAPSHOT_SOURCES` is the record-level
   approval list. Any malformed or unsafe tuple still makes the whole policy
   deny.
3. **Rights before listing.** A real tuple may be configured only when a
   recorded source-rights policy covers its source, fields and obligations, and
   its records are individually approved. Matching remains enforcement, not
   rights approval; this repository records no source rights itself. The
   gq-crawl Wikidata records above are the first such policy.
4. **First real tuples.** The production value proposed for the next deployment
   is the existing synthetic tuple (so App ID 1001 keeps working) plus the W5a
   records:

   | App ID  | `source_url`                                                      | `extractor_version`  |
   | ------- | ----------------------------------------------------------------- | -------------------- |
   | 1001    | `https://catalog.example.invalid/apps/1001`                       | `synthetic-v1`       |
   | 620     | `https://www.wikidata.org/wiki/Special:EntityData/Q279446.json`   | `wikidata-entity-v1` |
   | 413150  | `https://www.wikidata.org/wiki/Special:EntityData/Q23013817.json` | `wikidata-entity-v1` |
   | 1145360 | `https://www.wikidata.org/wiki/Special:EntityData/Q59756366.json` | `wikidata-entity-v1` |

   The configured value, on one line (JSON whitespace does not matter, but every
   string is matched exactly):

   ```text
   [{"source_url":"https://catalog.example.invalid/apps/1001","extractor_version":"synthetic-v1"},{"source_url":"https://www.wikidata.org/wiki/Special:EntityData/Q279446.json","extractor_version":"wikidata-entity-v1"},{"source_url":"https://www.wikidata.org/wiki/Special:EntityData/Q23013817.json","extractor_version":"wikidata-entity-v1"},{"source_url":"https://www.wikidata.org/wiki/Special:EntityData/Q59756366.json","extractor_version":"wikidata-entity-v1"}]
   ```

   Policy tuples do not bind a URL to an App ID; the producer's approved report
   does. `gq-crawl` publishes the snapshots itself after the redeploy; this
   repository never submits real snapshots.

5. **Deployment stays separate.** Changing the production value, redeploying and
   publishing each need the owner's explicit approval of the exact scope,
   following ADR 0002's minted, short-lived, revoked-afterwards credential
   pattern. Each resulting revision is recorded in
   [the deployment record](../deployment-record.md).

## Consequences

- Real, rights-backed records can be published and served by the anonymous
  lookup. ADR 0002's "synthetic data only" consequence ends once the listed
  records are published; App ID 1001 stays synthetic and must still not be
  presented as real game information.
- Adding or removing a real record is a configuration change and a redeploy,
  reviewed against its rights record, not a code change.
- Withdrawing a configured tuple stops new submissions for it but does not
  remove an already published snapshot; deletion goes through publication-admin
  withdrawal.
- The service never fetches a `source_url`; listing a real URL adds no
  request-path network access.
