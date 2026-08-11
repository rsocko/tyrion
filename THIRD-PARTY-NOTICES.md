# Third-party notices

Tyrion is licensed under the root [`LICENSE`](LICENSE). That license does not
replace the terms for dependencies, base images, hosted fonts, or third-party
names. Installed packages and container base layers retain their own license
files and notices.

## Material runtime components

| Component | Version or source | License | Required notice / source |
| --- | --- | --- | --- |
| Next.js | 16.2.12 | MIT | Copyright (c) Vercel, Inc.; [license](https://github.com/vercel/next.js/blob/v16.2.12/license.md) |
| React and React DOM | 19.2.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates; [license](https://github.com/facebook/react/blob/v19.2.0/LICENSE) |
| sharp and `@img/sharp-*` platform packages | 0.35.3 | Apache-2.0, with LGPL-3.0-or-later and MIT terms where declared by platform packages | [sharp source and license](https://github.com/lovell/sharp/tree/v0.35.3); installed package license files remain authoritative and are copied into `/licenses/npm-runtime` in the UI image |
| `@img/sharp-libvips-*` platform packages | 1.3.2 | LGPL-3.0-or-later | [libvips source and license](https://github.com/libvips/libvips); package metadata is verified and the pinned Debian base image's canonical LGPL-3 text is copied into `/licenses/npm-runtime` when a platform package omits a license file |
| PostCSS and nanoid | 8.5.25 and 3.3.16 | MIT | Package metadata and installed license files |
| proper-lockfile and runtime dependencies | 4.1.2 | MIT | [package source and license](https://github.com/moxystudio/node-proper-lockfile/tree/v4.1.2) |
| Zod | 4.1.12 | MIT | [package source and license](https://github.com/colinhacks/zod/tree/v4.1.12) |
| monarchmoneycommunity | 1.5.2 | MIT | Copyright (c) 2026 bradleyseanf; [license](https://github.com/bradleyseanf/monarchmoneycommunity/blob/v1.5.2/LICENSE) |
| monarchmoneycommunity upstream | hammem/monarchmoney | MIT | Copyright (c) 2023 hammem; [license](https://github.com/hammem/monarchmoney/blob/main/LICENSE) |
| FastAPI 0.141.1, Pydantic 2.13.4 | 2026-08-09 resolution | MIT | Package license metadata and installed distributions |
| Uvicorn 0.52.1, HTTPX 0.28.1, python-dotenv 1.2.2 | 2026-08-09 resolution | BSD-3-Clause | Package license metadata and installed distributions |
| gql 4.0.0 and GraphQL Core 3.2.11 | 2026-08-09 transitive resolution | MIT | Package license metadata and installed distributions |
| aiohttp 3.14.3 and its runtime stack | 2026-08-09 transitive resolution | Apache-2.0 and MIT | Package license metadata and installed distributions |
| autocommand 2.2.2 | 2026-08-09 transitive resolution through `path` | LGPL-3.0-only | [package source and license](https://github.com/jaraco/autocommand) |
| certifi 2026.7.22 CA bundle | 2026-08-09 transitive resolution | MPL-2.0 | Mozilla certificate notice retained by the installed distribution; [license](https://github.com/certifi/python-certifi/blob/master/LICENSE) |
| Node.js official image | `node:20.19.4-bookworm-slim` at the digest in `triage-app/Dockerfile` | MIT plus bundled component terms | [Node.js license](https://github.com/nodejs/node/blob/v20.19.4/LICENSE), [docker-node source](https://github.com/nodejs/docker-node) |
| Python official image | `python:3.12.11-slim-bookworm` at the digest in `Dockerfile` | PSF-2.0 plus bundled component terms | [Python license](https://docs.python.org/3.12/license.html), [docker-library/python source](https://github.com/docker-library/python) |
| Debian Bookworm base layers | image-pinned OS packages | Multiple free-software licenses | Package copyright files remain in `/usr/share/doc`; [Debian copyright information](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information) |

The standard MIT permission and warranty terms appear in this repository's
`LICENSE`. Copyright notices in this table remain attributable to their
respective holders. BSD, Apache, LGPL, MPL, PSF, and other package-specific
terms remain available in the installed package or image and at the linked
authoritative source. Do not strip those files when producing a distribution.

The complete 2026-08-09 Python runtime resolution also contains:

- MIT: `annotated-doc`, `annotated-types`, `anyio`, `attrs`, `backoff`,
  `h11`, `httptools`, `oathtool`, `path`, `PyYAML`, `typing-inspection`,
  `uvloop`, and `watchfiles`.
- BSD-3-Clause: `click`, `colorama`, `httpcore`, `idna`, `starlette`, and
  `websockets`.
- Apache-2.0 or Apache-2.0/MIT: `aiosignal`, `frozenlist`, `multidict`,
  `propcache`, and `yarl`.
- PSF-2.0: `aiohappyeyeballs` and `typing-extensions`.

These entries are resolved transitives, not separately selected Tyrion
components. Their exact package metadata and embedded license files remain
authoritative.

## Development and design-time components

The npm lockfiles also contain development-only packages under MIT, ISC,
BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, Python-2.0,
MPL-2.0, CC0-1.0, and CC-BY-4.0. In particular, `axe-core` is MPL-2.0 and
`caniuse-lite` is CC-BY-4.0. The Next.js runtime graph also carries
platform-conditional Apache-2.0 and LGPL-3.0-or-later sharp/libvips packages;
only the matching runtime platform artifacts are installed into a production
image. These packages are not copied into Tyrion's application source.

The brand reference HTML loads, but does not redistribute, Cormorant Garamond,
IBM Plex Sans, and JetBrains Mono from Google Fonts. Each family is distributed
under SIL Open Font License 1.1:

- [Cormorant](https://github.com/googlefonts/Cormorant)
- [IBM Plex](https://github.com/IBM/plex)
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)

The previously bundled Geist font binaries were unused and were removed.

## Names and services

Monarch and Monarch Money are names of Monarch Money, Inc. Their use here
identifies an independently implemented interoperability target. No Monarch
logo, artwork, or copied service content is included. This project is not
affiliated with, endorsed by, sponsored by, or supported by Monarch Money,
Inc.
