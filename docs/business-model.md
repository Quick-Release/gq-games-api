# Business model and licensing

## Decision

Use an **open-source server plus a paid managed API**, inspired by Firecrawl's
public AGPL server and hosted service. This replaces the earlier idea of free
personal use with mandatory payment for commercial code use.

Original project code is **AGPL-3.0-only**. The full, unmodified license is in
[LICENSE](../LICENSE); `package.json` records the SPDX identifier. Dependencies
retain their own licenses. This choice does not license the separate private
`gq-crawl` repository or third-party game data.

## Free software versus a paid service

| Offering                                            | Intended model                                            |
| --------------------------------------------------- | --------------------------------------------------------- |
| Server source and compliant self-hosting            | AGPL-3.0-only, including commercial use                   |
| GETQUICK-operated games API                         | Paid subscriptions or usage-based credits, to be designed |
| Future standalone client SDKs                       | MIT, only after explicit separate licenses are added      |
| Game records, images, source material, and datasets | Separate source-rights and data terms                     |

Self-hosters supply their own Cloudflare infrastructure, ingestion inputs, and
operating costs. An open-source code license does not grant free access to our
hosted service, private infrastructure, credentials, or datasets.

Businesses may self-host, modify, distribute, or offer competing services
without buying a license from us, provided they comply with AGPL and other
applicable rights. AGPL is not a noncommercial license or a ban on competing
hosting.

## Planned managed-service value

The potential paid offering is operated infrastructure, maintained and
normalized game records, ingestion/freshness management, reliability, and
support. Research must determine which of these are useful, legally
distributable, and affordable. Billing, credits, quotas, service tiers,
enterprise features, and SLAs are not implemented or promised. No hosted service
has been deployed.

## AGPL responsibilities

This is a summary, not a replacement for the license or legal review:

- Preserve the required copyright, license, and warranty notices.
- Follow the license's requirements when distributing covered source or
  binaries.
- Under section 13, modified versions supporting remote network interaction must
  prominently offer all interacting users free access to their Corresponding
  Source. Corresponding Source includes the required build/install/run scripts,
  not merely a link to an outdated or unrelated upstream version.
- Before deploying a modified hosted version, provide a prominent source offer
  through the API/documentation for the actual version served. Implement and
  verify that offer as part of the first deployment; no service exists today.
- Do not assume that a private component may be combined into an AGPL-covered
  program without affecting its licensing. Review actual integration boundaries.
  An independent application merely calling an API is not automatically
  relicensed by that API's server license.

Keep private crawl artifacts, credentials, and third-party data out of public
source. Determine source obligations and data rights separately; the license is
not a reason to publish secrets or material we cannot redistribute.

## Optional future commercial code licenses

A paid hosted API does not require dual-licensing the server. An alternative
commercial code license could later be offered to customers needing permissions
outside AGPL, but only for code we have sufficient rights to license that way.
Agree an appropriate contributor-rights policy before accepting contributions if
this option matters; AGPL contributions alone do not automatically grant us
proprietary relicensing rights. No such paid code license is offered today.

## References

- [GNU AGPL version 3](https://www.gnu.org/licenses/agpl-3.0.html), particularly
  sections 6 and 13.
- [Firecrawl's license and cloud model](https://github.com/firecrawl/firecrawl#open-source-vs-cloud):
  primarily AGPL-3.0, with separately licensed SDKs and components. This is a
  business-model reference, not a dependency or copied implementation.
