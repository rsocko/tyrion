# Private deployment contract

`compose.yaml` is a portable contract example, not an authoritative deployment.
Infrastructure ownership, service discovery, routing, credential delivery, persistent
storage, and network policy belong in a separate private infrastructure system.

Set deployment-specific image references, hostnames, origins, and secrets outside the
repository. Do not copy those values into issues, pull requests, workflow output, or
documentation. The bridge must remain private, the browser must use only the
allowlisted server-side proxy, and reusable session material must stay on
access-restricted external storage.

Automated image publication is disabled. Before connecting this contract to any
runner or publication service, satisfy the private evidence gate in
[`docs/DEPLOYMENT-TRUST-BOUNDARY.md`](../../docs/DEPLOYMENT-TRUST-BOUNDARY.md).
