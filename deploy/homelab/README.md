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

Health checks are `GET /api/health` on UI port `3000` and `GET /health` on bridge port
`8100`. The UI's bridge reachability check is `GET /api/bridge/health`.
