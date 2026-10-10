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
The exact read-only current-snapshot and generation-addressed document-expectation
routes for OWL delegate to Finance Insights inside the UI container and require its
read gate and store.
The protected finance insight service keeps both state and immutable policy snapshots
in `state.sqlite` on the ordinary persistent `tyrion-finance-insights` volume. A new
database initializes deterministic, fail-closed policy history through version 2;
an existing database retains its current history unchanged.
Finance Insights does not expose a policy editor today. Later policy changes must be
delivered as explicit, validated, append-only Tyrion database migrations rather than
by replacing a mounted file.
Back up the volume. Keep all Finance Insights rollout gates off
until the database restore and metadata-only health checks pass;
enable evaluation/write, read, confirmed actions, and the automation transport in
that order. The automation gate exposes only the private scheduled-job and exact
delivery-acknowledgement routes; it does not create a browser or public connector
surface.
Receipt evidence uses the same private-authority posture at
`/api/internal/v1/finance/receipt-evidence`. OWL and Tyrion must share an explicitly
allowlisted private service network; no Traefik router exposes this path. Configure
OWL's fixed service URL and its independent `OWL_RECEIPT_INTAKE_API_TOKEN`, plus a
stable receipt identity namespace. Enable receipt reads first, then replica writes
only after OWL canonical intake is healthy. Keep recovery disabled until the separate
Monarch-first recovery work is approved. The UI streams artifacts through its bounded
64 MiB `/tmp` tmpfs, persists only byte-free orchestration state, and removes temporary
files in every terminal or unknown outcome.

The `receipt-recovery` Compose profile adds a disabled one-shot
`tyrion-monarch-recovery` job for Monarch-first backfill. It reuses the immutable
Bridge image but runs `receipt_recovery_worker.py --run-once`; it does not start a
second Bridge, load Monarch session material, publish a port, or join Traefik. The job
calls the healthy Bridge on `tyrion-backend`, calls OWL's protected canonical intake,
uses a size-capped `/tmp`, and mounts only the separate
`tyrion-monarch-recovery-state` checkpoint volume.

Keep `TYRION_MONARCH_RECOVERY_ENABLED=false` until both protected services and the
restricted state volume are provisioned. Then invoke one bounded cycle explicitly:

```powershell
docker compose --profile receipt-recovery run --rm tyrion-monarch-recovery
```

The checkpoint volume must be owned by UID/GID `10001` and excluded from repository
and CI capture. It contains only a schema version, source selector, hashed occurrence
cursor, and lease file. A nonzero result is not permission to delete state or retry
blindly: preserve the checkpoint, correct connectivity or contract configuration,
and rerun so OWL occurrence lookup reconciles any unknown intake first. Private
infrastructure may schedule the same one-shot command, but overlapping runs are
rejected by the lease.
For local/demo development, run the bridge with `python main.py --demo` and the UI with
`npm run dev`; the homelab compose file is the production contract, not the local
development launcher.
