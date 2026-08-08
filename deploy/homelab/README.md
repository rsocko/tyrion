# Homelab deployment parity copy

This directory documents the production Tyrion stack maintained in
`rsocko/homelab-config`. The homelab repository is the deployment source of
truth; update this copy only to preserve reviewable contract parity. It deploys
only the Monarch Bridge. The bounded `triage-app` debug UI is not a deployment
target.

## Contract

| Item | Value |
| --- | --- |
| Image | `registry.socko.us/tyrion:${TYRION_IMAGE_TAG}` |
| Required tag | Immutable `sha-<7-40 lowercase commit hex>` |
| Internal listener | `0.0.0.0:8100`; no host port is published |
| Health check | `GET /health` using Python included in the image |
| Session mount | External volume at `/var/lib/tyrion` |
| Session file | `/var/lib/tyrion/monarch-session.json` |
| Browser origin default | `https://mc.socko.us` |
| Private route | Traefik TLS with `trusted-private-networks@file` |

The image default command starts `monarch-bridge/main.py`; Compose intentionally
sets no command or entrypoint. The container uses a read-only root filesystem,
drops all capabilities, prevents privilege escalation, and limits its writable
temporary filesystem.

## Dockhand variables

Copy `.env.example` values into the corresponding Dockhand regular variables.
Set `TYRION_IMAGE_TAG` to a published immutable tag such as
`sha-0123456789abcdef0123456789abcdef01234567`. Provision
`TYRION_BRIDGE_API_TOKEN` as an external Dockhand secret containing at least 32
characters; Compose maps it to the runtime-only `BRIDGE_API_TOKEN` variable.

Do not create a repository `.env` file. Never store bridge tokens, Monarch
credentials, cookies, sessions, financial data, identifiers, raw responses, or
machine-specific storage paths in this repository. The Traefik route and
external volume are created and operated by `homelab-config`.
