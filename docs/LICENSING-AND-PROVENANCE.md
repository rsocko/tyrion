# Licensing and provenance review

**Review date:** 2026-08-09

This record separates verified facts from engineering risk and decisions that
remain with the repository owner. It is not legal advice.

## Repository license decision

The original repository content is released under the MIT License in
[`../LICENSE`](../LICENSE).

Evidence supporting that decision:

- Git history attributes authored source, documentation, mockups, and brand
  work to Ryan Sockalosky and Copilot-assisted commits made for that owner.
- The repository was extracted from the same owner's private predecessor; the
  public baseline provenance is recorded in `rsocko/tyrion#5`.
- The data certification confirms that retained examples and fixtures are
  synthetic.
- A current-tree and historical-addition review found no vendored source
  snippets, third-party logos, screenshots, live upstream responses, or
  externally sourced images.
- Dependency code is installed from package managers and is not relicensed by
  the repository license. Its material terms are recorded in
  [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

The MIT grant covers the owner's original code and documentation. It does not
grant rights in third-party packages, services, data, names, or marks.

## Asset and generated-content provenance

| Content | Finding | Disposition |
| --- | --- | --- |
| `triage-app/src/app/favicon.ico` | Byte-for-byte match with the Next.js 14.2.35 `create-next-app` template favicon (SHA-256 `2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932`), covered by Next.js MIT terms | Replaced with the repository-authored Tyrion coin SVG so the active identity is unambiguous |
| `triage-app/src/app/fonts/GeistVF.woff` and `GeistMonoVF.woff` | Unused Next.js scaffold assets from Vercel's Geist family, licensed OFL-1.1 | Removed rather than redistributing unused binaries |
| Coin mark, CSS illustrations, HTML mockups, and brand references | Code-drawn assets introduced in owner-authored/Copilot-assisted repository commits; no external image files or logo imports | Retained under the repository license |
| Google Fonts references in `brand/` | Remote references to Cormorant Garamond, IBM Plex Sans, and JetBrains Mono; no font binaries are committed | Retained with OFL provenance in third-party notices |
| Fixtures and examples | Invented structures certified in `SYNTHETIC-DATA-CERTIFICATION.md` | Retained; never substitute live data |
| Historical franchise-linked brand explorations | Obsolete exploratory material included character names and catchphrases that were unnecessary to the accepted product boundary | Removed; active copy now uses original finance-domain language |

Generated package locks are retained as dependency-resolution records. CI
accepts absent registry `resolved` fields and otherwise requires HTTPS URLs
from `registry.npmjs.org` with integrity metadata. This keeps locks portable
without publishing a development-environment mirror hostname.

## Dependency review

The npm lockfiles were reviewed by declared SPDX expression. Runtime packages
are permissively licensed. Development-only exceptions include MPL-2.0,
CC-BY-4.0, and CC0-1.0 packages; those terms are compatible with their use as
tools or reference data and are not changed by Tyrion's MIT license.

Next.js 16 adds sharp 0.34.5 and platform-conditional `@img/sharp-*` packages
for supported production platforms. Those artifacts declare Apache-2.0 and,
where they bundle or describe libvips, LGPL-3.0-or-later and MIT combinations.
The corresponding `@img/sharp-libvips-*` 1.2.4 packages declare
LGPL-3.0-or-later. Their installed license files and notices remain
authoritative and are preserved in dependency and container layers.

The Python runtime and test graphs are resolved universally for Python 3.12 from
exact direct inputs into marker-aware, hash-locked
`monarch-bridge/requirements-runtime.txt` and `monarch-bridge/requirements.txt`.
Their reviewed versions and SPDX expressions are recorded in
`monarch-bridge/dependency-policy.json`; CI rejects graph, marker, hash, license,
public-index provenance, and known-advisory-floor drift. Direct dependencies use MIT
or BSD-3-Clause terms. Material transitives include Apache-2.0/MIT `aiohttp`, MIT
`gql`, LGPL-3.0-only `autocommand`, and the MPL-2.0 Mozilla CA bundle distributed by
`certifi`. Re-run the review whenever an input or generated lock changes.

The production Dockerfiles use digest-pinned official Node.js and Python
images based on Debian Bookworm. Their package-level copyright files must
remain in derived images. Both images copy the repository license and
third-party notice into `/licenses`.

## Monarch terms and affiliation

Verified facts:

- `monarchmoneycommunity==1.5.2` is an unofficial MIT-licensed community fork
  of `hammem/monarchmoney`; it is not a Monarch Money, Inc. SDK.
- Monarch's public Terms of Use, reviewed at
  <https://www.monarch.com/terms> on 2026-08-09, limit use to personal,
  non-commercial use and state restrictions on scraping, storing significant
  service content, programmatic access, and attempts to discover underlying
  service components.
- Tyrion uses plain-text Monarch names only to identify interoperability. No
  Monarch logo, service UI, or raw upstream content is redistributed.

Engineering risk:

- The bridge's automated use of an unofficial client can conflict with the
  cited service restrictions even though the client library itself is MIT
  licensed. An open-source license does not authorize access to Monarch's
  service.
- Private APIs and behavior can change or access can be suspended. Rate
  limiting, bounded synchronization, normalized DTOs, and personal use reduce
  operational exposure but do not resolve the contractual question.

Owner decisions recorded 2026-08-09:

- The owner accepts the identified Monarch account and contract risk and
  retains the existing opt-in live mode for personal, non-commercial use. This
  acceptance does not assert that the community client's MIT license
  authorizes access to Monarch's service. Live tests remain separately gated,
  controlled, and disabled by default; demo mode remains the normal
  development and automated-test path.
- The owner accepts the identified trademark and brand risk and approves the
  Tyrion name for public release. Direct fictional-character references,
  catchphrases, artwork, and heraldry remain excluded. The repository license
  does not grant rights in third-party names or marks.

These are informed owner risk acceptances, not findings that the risks are
absent or legal conclusions binding any third party. Future changes to
Monarch's terms, the integration method, or the public brand require a fresh
review.

Tyrion is independent and is not affiliated with, endorsed by, sponsored by,
or supported by Monarch Money, Inc.
