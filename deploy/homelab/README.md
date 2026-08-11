# Private deployment contract

`compose.yaml` is a portable contract example, not an authoritative deployment.
Infrastructure ownership, service discovery, routing, credential delivery, persistent
storage, and network policy belong in a separate private infrastructure system.

The production defaults are the public repositories
`ghcr.io/rsocko/tyrion-bridge:latest` and
`ghcr.io/rsocko/tyrion-ui:latest`. This convenient moving deployment follows the
newest successful trusted `main` publication when the stack pulls or recreates its
containers. Set the single `TYRION_IMAGE_TAG` value to the same published `build-N`,
`main`, `latest`, or `sha-<40-character-commit>` tag for both services when an explicit
release is required. Digest-addressed `image@sha256:...` references from the workflow
summary remain the strongest rollback and pinning identity for deployment systems
that accept full image references.

Set deployment-specific tags, hostnames, origins, and secrets outside the repository.
Do not copy sensitive values into issues, pull requests, workflow output, or
documentation. Public images pull anonymously after the one-time package visibility operation documented in
[`docs/DEPLOYMENT-TRUST-BOUNDARY.md`](../../docs/DEPLOYMENT-TRUST-BOUNDARY.md);
no registry credential belongs in the deployment.

The bridge must remain private, the browser must use only the allowlisted server-side
proxy, and reusable session material must stay on access-restricted external storage.
The sole public finance-data transport is the backend-only
`https://tyrion.socko.us/api/connector/v1` gateway. It requires the shared bearer
credential on every request and has its own strict route/query/body allowlist. The
Traefik example exposes that path over TLS without the UI private-network middleware;
all UI routes keep the middleware and all public routers exclude `/api/internal/`.
The protected finance insight service additionally requires the
`tyrion-finance-insights` external volume, an operator-installed strict v1
policy at `/var/lib/tyrion-finance-insights/policy.json`, and independent
minimum-32-byte cursor and identity keys supplied as platform secrets.
Back up the volume and keys together. Keep all three finance insight gates off
until the state, policy, key restore, and metadata-only health checks pass;
enable evaluation/write, read, and confirmed actions in that order.
For local/demo development, run the bridge with `python main.py --demo` and the UI with
`npm run dev`; the homelab compose file is the production contract, not the local
development launcher.
