# Homelab deployment parity

`compose.yaml` and `.env.example` are documentation copies of the authoritative
Tyrion deployment in `rsocko/homelab-config`. That repository remains the deployment
source of truth; keep these copies in parity with it.

Compose creates the named Tyrion session volume on first deployment. Normal stack
updates preserve it; do not remove the volume while it contains an active session.
