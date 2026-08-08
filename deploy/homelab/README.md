# Homelab deployment parity

`compose.yaml` and `.env.example` document the target contract for the authoritative
deployment in `rsocko/homelab-config`. That repository remains the deployment source
of truth and must implement this change separately.

The stack separates two processes:

- `registry.socko.us/tyrion-ui` listens on `3000` and is the only service attached to
  Traefik. `https://tyrion.socko.us` routes every request to this container.
- `registry.socko.us/tyrion-bridge` listens on `8100` only on the unexposed
  `tyrion-backend` Docker network. The UI reaches it at
  `http://tyrion-monarch-bridge:8100`.

The browser calls only the UI's `/api/bridge/...` allowlisted proxy. The shared
`BRIDGE_API_TOKEN` is injected into both containers as a server-side secret and is
never browser configuration. Mission Control, scheduled sync, and MCP services that
need the protected bridge contract must join `tyrion-backend` and use the bridge
service DNS name plus the same service token; they must not route through the public
UI proxy.

Traefik must retain `trusted-private-networks`, HTTPS redirect, TLS, compression, and
security-header middleware on the UI route. Neither service publishes a host port.
The bridge session volume is external to the image and persists normal stack updates;
do not remove, copy, inspect, or back it up without equivalent secret controls.

The UI also mounts the external `tyrion-policy` volume at
`/var/lib/tyrion-policy`. It contains only strict Tyrion policy snapshots and
metadata-only audit events; it must be access-restricted and backed up. Configure
independent minimum-32-character policy assertion and instrument fingerprint keys as
Dockhand secrets.

The dedicated high-priority `tyrion-policy` router sends `/api/policy` through the
trusted forward-auth service configured by `TYRION_POLICY_AUTH_URL`. That service
must strip browser-supplied `x-tyrion-*` headers and return the short-lived signed
actor, household, and permission assertion documented in `triage-app/README.md`.
The policy API fails closed until this integration and
`TYRION_POLICY_AUTH_SECRET` agree. Connector operations continue to use only the
bridge proxy contract.

Controlled re-attribution additionally requires a protected internal implementation
of the `ReattributionRepository` adapter plus `TYRION_REATTRIBUTION_URL` and
`TYRION_REATTRIBUTION_TOKEN`. Leave both blank when that bounded operation is not
deployed; policy configuration remains available and preview/apply return a sanitized
unavailable response.

Health checks are `GET /api/health` on UI port `3000` and `GET /health` on bridge port
`8100`. The UI's bridge reachability check is `GET /api/bridge/health`.
