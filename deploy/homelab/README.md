# Private deployment contract

`compose.yaml` is a portable contract example, not an authoritative deployment.
Infrastructure ownership, service discovery, routing, credential delivery, persistent
storage, and network policy belong in a separate private infrastructure system.

The production defaults are the public repositories
`ghcr.io/rsocko/tyrion-bridge` and `ghcr.io/rsocko/tyrion-ui`. Set
`TYRION_BRIDGE_IMAGE_DIGEST` and `TYRION_UI_IMAGE_DIGEST` to the exact `sha256:`
digests recorded by a trusted `main` publication run. Compose fails closed when either
digest is absent; production never follows `main` or `latest`.

Set deployment-specific digests, hostnames, origins, and secrets outside the
repository. Do not copy those values into issues, pull requests, workflow output, or
documentation. Public images pull anonymously after the one-time package visibility
operation documented in
[`docs/DEPLOYMENT-TRUST-BOUNDARY.md`](../../docs/DEPLOYMENT-TRUST-BOUNDARY.md);
no registry credential belongs in the deployment.

The bridge must remain private, the browser must use only the allowlisted server-side
proxy, and reusable session material must stay on access-restricted external storage.
For local/demo development, run the bridge with `python main.py --demo` and the UI with
`npm run dev`; the digest-pinned homelab compose file is the production contract, not
the local development launcher.
