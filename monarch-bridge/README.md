# Monarch Bridge Service

The bridge is Tyrion's sole owner of Monarch authentication state. Mission Control,
scheduled sync, the operational UI, and MCP tooling must call this service rather than
creating or persisting separate Monarch sessions.

This is an independent, unofficial interoperability service. It is not affiliated
with, endorsed by, sponsored by, or supported by Monarch Money, Inc. The client uses
a private upstream interface, not a supported Monarch SDK. On 2026-08-09, the owner
accepted the documented account and contract risk and retained opt-in live mode for
personal, non-commercial use. The client license does not authorize service access.
See [`../docs/LICENSING-AND-PROVENANCE.md`](../docs/LICENSING-AND-PROVENANCE.md).

## Supported client

`monarchmoneycommunity==1.5.2` is pinned in `requirements-runtime.in` and the
hash-locked runtime resolution. Authentication, transaction pagination, and category
mutation signatures are covered by deterministic tests. Upgrade the pin only with a
contract-test and controlled live-validation run.

All direct dependencies are exact in `requirements-runtime.in` and
`requirements-test.in`. The generated `requirements-runtime.txt` and
`requirements.txt` locks contain universal Python 3.12 runtime and test graphs with
platform markers and public PyPI hashes. Production installs only the runtime lock; CI
installs the test lock. `dependency-policy.json` records the reviewed versions,
markers, license expressions, and known security floors.

Regenerate locks only with Python 3.12 and the public index:

```powershell
python -m pip install uv==0.12.2
$env:PIP_INDEX_URL = "https://pypi.org/simple"
uv pip compile requirements-runtime.in --python-version 3.12 --universal --generate-hashes --index-url https://pypi.org/simple -o requirements-runtime.txt
uv pip compile requirements-test.in --python-version 3.12 --universal --generate-hashes --index-url https://pypi.org/simple -o requirements.txt
python ..\.github\scripts\check_python_dependency_policy.py
```

Review every changed package and license, update `dependency-policy.json`, and confirm
advisory floors before accepting regenerated output. Never resolve or retain a private
package-index URL in repository files. Python version updates are intentionally excluded
from weekly Dependabot version updates because Dependabot cannot update the reviewed
policy metadata or reliably regenerate both universal locks; apply Python updates
through this review process instead.

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# Safe fixture data; never contacts Monarch.
.\.venv\Scripts\python.exe main.py --demo

# Headless/recovery setup. The normal setup surface is the operational UI.
.\.venv\Scripts\python.exe main.py --setup

# Live bridge, bound only to loopback by default.
.\.venv\Scripts\python.exe main.py
```

The bridge stores its opaque session outside the repository under the operating
system's per-user application-state directory. The directory and file are restricted
to the bridge user, and session replacement is atomic. `SESSION_FILE` may override
the path, but the bridge rejects paths inside a Git repository.

Do not put Monarch passwords, MFA seeds, cookie values, session files, or financial
payloads in `.env`, command history, test fixtures, logs, screenshots, or issue/PR
content. Login inputs are accepted only for the current request and are not retained
by Tyrion.

## Operational UI proxy

The browser calls the Next.js `/api/bridge/...` route. That server-side route permits
only health, auth setup/status/logout, and bounded sync, then injects
`BRIDGE_API_TOKEN` for protected operations. The token must remain server-only; never
use a `NEXT_PUBLIC_` variable. Mission Control uses the separate backend-only
`/api/connector/v1` gateway described below; scheduled sync and MCP callers may use
that same approved contract or the private bridge when they share its backend network.

The operational UI and `python main.py --setup` are initiation surfaces for the same
bridge-owned session. They do not create independent session stores. Browser-cookie
setup is the recommended UI path because Monarch may reject programmatic password
login even when account MFA is disabled; email/password remains a best-effort fallback.

### Mission Control connection

Mission Control server and worker processes call the bearer-protected public gateway:

```dotenv
FINANCE_MANAGER_URL=https://tyrion.socko.us/api/connector/v1
FINANCE_MANAGER_API_TOKEN=
```

The Mission Control token must equal Tyrion's server-only `BRIDGE_API_TOKEN` and be at
least 32 characters. Mission Control must allowlist `tyrion.socko.us` and authorize
token attachment only to the exact `https://tyrion.socko.us` origin. It must not send
the credential to redirects or expose it to browser code.

The gateway strips `/api/connector/v1` and forwards only its documented Bridge v1
allowlist to private `BRIDGE_URL`. The raw bridge base, `/auth/*`, reusable sessions,
OpenAPI/docs, attribution, and policy routes remain private or unavailable.
`/api/bridge/health` remains the bounded browser operations check; transaction reads
or mutations are still unavailable through `/api/bridge/...`.

## Authenticated homelab deployment

Loopback is the default. A non-loopback bind fails closed unless:

1. `BRIDGE_API_TOKEN` is a random value of at least 32 characters.
2. TLS is terminated by a trusted reverse proxy and `BRIDGE_REMOTE_TLS=true`.
3. `BRIDGE_ALLOWED_ORIGINS` contains only intended browser origins.
4. The public UI is behind trusted private-network TLS ingress, while server callers
   send the service token only over the private backend network or trusted TLS.

```dotenv
BRIDGE_HOST=192.0.2.10
BRIDGE_API_TOKEN=<random-server-only-value>
BRIDGE_REMOTE_TLS=true
BRIDGE_ALLOWED_ORIGINS=https://mission-control.example
```

Only `/`, `/health`, and `/contract` are public. `/` aliases the health response.
Public health reports reachability and a
coarse auth state; all auth, read, sync, mutation, OpenAPI, and docs routes require
service authentication in a remote deployment. Put rate limits and request logging
redaction at the reverse proxy, and never log request bodies or authorization headers.
Start the service through `main.py`; if a raw ASGI server overrides the bind address,
non-loopback clients still fail closed, but that is not a supported TLS deployment.
The supported `main.py` entrypoint disables Uvicorn access logs because endpoint paths
can contain private transaction identifiers.

### Production container

Pull-request CI builds both production containers without publishing them. A separate
GitHub-hosted workflow publishes trusted `main` commits to
`ghcr.io/rsocko/tyrion-bridge` and `ghcr.io/rsocko/tyrion-ui` with immutable commit
digests and workflow-enforced write-once commit tags, then promotes those digests to
`build-N`, `main`, and `latest` without rebuilding. Canonical Compose follows `latest`
and accepts one shared tag override for paired rollback; the commit tag and digest
remain available for stronger pinning. The exact trigger, credential,
package-visibility, numbering, and promotion controls are documented in
[`docs/DEPLOYMENT-TRUST-BOUNDARY.md`](../docs/DEPLOYMENT-TRUST-BOUNDARY.md).

The bridge image runs `main.py` as UID/GID `10001`, listens on container port `8100`, and
checks `GET /health` over loopback. It contains only the bridge runtime and runtime
dependencies; the operational UI, tests, documentation, local environment files, and
session material are excluded from the build context and final image.
Production gives the bridge no Traefik route and publishes no host port. The
operational UI reaches it by service DNS on the unexposed `tyrion-backend` Docker
network. Authorized Mission Control, scheduled sync, and MCP services may join that
network and call the protected bridge contract directly.

The UI image runs as UID/GID `10001`, listens on port `3000`, and checks
`GET /api/health`. It is the only service routed from
`https://tyrion.socko.us`; the browser uses its allowlisted `/api/bridge/...` proxy,
while backend callers use the independently authenticated `/api/connector/v1`
gateway. The raw bridge still has no Traefik route.

Production must mount writable persistent storage at `/var/lib/tyrion`. The bridge
stores the opaque session at `/var/lib/tyrion/monarch-session.json` and creates its
cross-process lease alongside that file. Ensure the mounted directory is owned by
UID/GID `10001` and is accessible only to the bridge operator. Do not copy, back up,
or inspect the session through CI or deployment automation.

The image sets `BRIDGE_HOST=0.0.0.0` and acknowledges the required private
Traefik TLS termination with `BRIDGE_REMOTE_TLS=true`, so startup deliberately
fails unless runtime configuration injects the service token. The complete
production setting contract is:

| Variable | Production value |
| --- | --- |
| `BRIDGE_API_TOKEN` | Random server-only value with at least 32 characters |
| `BRIDGE_REMOTE_TLS` | `true`, acknowledging trusted TLS ingress and isolated private routing |
| `BRIDGE_ALLOWED_ORIGINS` | `https://mc.socko.us`; browsers do not call the bridge directly |

`BRIDGE_PORT` and `SESSION_FILE` default to `8100` and
`/var/lib/tyrion/monarch-session.json`; keep those values aligned with the image
health check and volume mount. The image also defaults
`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`, `BRIDGE_REMOTE_TLS=true`,
`BRIDGE_LOAD_DOTENV=false`, and `DEFAULT_TRANSACTION_DAYS=90`; these are
non-secret and may be repeated explicitly by the stack. Runtime secrets must
be injected by the deployment platform, never baked into the image or placed
in repository environment files.

## Session lifecycle

| State | Meaning | Operator action |
| --- | --- | --- |
| `unauthenticated` | No bridge-managed session exists | Start setup from the operational UI or CLI |
| `connected` | The session passed a live account check | No action |
| `expired` | Monarch rejected the session; persisted state was removed | Authenticate again |
| `degraded` | A session exists but Monarch is temporarily unavailable or returned an unknown failure | Retry, then reauthenticate if it persists |

Startup loads only the bridge-owned session. `GET /auth/status` verifies it against
Monarch. Expired or unreadable sessions are removed. Logout clears in-memory and
persisted state. A cross-process lease prevents a second bridge process from loading
or deleting the session while it is owned. To revoke access held by another device,
revoke Monarch sessions upstream as well.

The public Tyrion connector does not expose `/auth/status`. Its authenticated
`GET /api/connector/v1/health` handler calls this protected route exactly once
server-to-server, derives the normalized health status and reachability from the
verified result, and discards email and all other authentication context.

Browser cookies cannot be refreshed automatically because Monarch does not provide the
bridge a refresh credential. When an upstream request explicitly rejects the session,
the bridge removes it, preserves the `expired` health state, and requires the user to
copy fresh browser cookie values. Transient network/upstream failures retain the
session as `degraded` instead of forcing reauthentication. The operational UI offers
explicit status recheck and one bounded 30-day sync action; it never exposes finance
read or mutation routes.

Monarch does not publish a cookie TTL. The community client reports that saved
sessions have sometimes lasted several months, but this is observational rather than
a guarantee. The pinned client replays the original cookie values and does not capture
rotated `Set-Cookie` responses, so Tyrion treats a real authentication rejection as the
only reliable expiry signal rather than predicting a date.

## Revocation and incident recovery

1. Stop every bridge process.
2. Sign out all Monarch sessions from Monarch's security settings.
3. Rotate the Monarch password if credentials or session material may have escaped.
4. Delete the configured external session file and any untracked local captures.
5. Rotate `BRIDGE_API_TOKEN` for remote deployments and update server-side callers.
6. Run setup again, then confirm `/auth/status` reports `connected`.
7. Check Git history, CI artifacts, backups, reverse-proxy logs, and issue attachments;
   purge exposed material rather than committing a deletion alone.

Exclude the session directory from backups unless the backup has equivalent access
controls and encryption. Never restore a session after upstream revocation.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest test_auth.py test_bridge.py
```

The deterministic suite disables `.env` loading, uses temporary session paths, mocks
the Monarch client at `create_monarch_client`, and cannot contact Monarch.

Credentialed checks are separately opt-in:

```powershell
$env:TYRION_LIVE_TESTS = "1"
$env:TYRION_LIVE_BRIDGE_URL = "http://127.0.0.1:8100"
.\.venv\Scripts\python.exe -m pytest test_live_integration.py
```

Live auth values are process environment only. Category mutation also requires a
dedicated test transaction/category and
`TYRION_LIVE_MUTATION_CONFIRM=I_ACCEPT_REVERSIBLE_MONARCH_MUTATION`; the test verifies
the write and restores the original category in a `finally` block. Do not redirect
live test output to tracked files.

See [`docs/MONARCH-INTEGRATION-VALIDATION.md`](../docs/MONARCH-INTEGRATION-VALIDATION.md)
for the evidence matrix, limitations, and safe refresh procedure.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/contract` | Stable contract version |
| GET | `/health` | Reachability and coarse auth state |
| POST | `/auth/login` | Password/MFA setup |
| POST | `/auth/login-with-cookies` | Browser-cookie setup |
| GET | `/auth/status` | Verified session state |
| POST | `/auth/logout` | Clear bridge-owned session |
| POST | `/sync` | Trigger transaction pull |
| GET | `/transactions` | Fetch transactions with filters |
| GET | `/transactions/{id}` | Single transaction detail |
| PATCH | `/transactions/{id}/category` | Verified category write-back |
| GET | `/accounts` | Bounded account references and current balances |
| GET | `/category-groups` | Bounded category-group references |
| GET | `/categories` | Bounded categories with stable group identity |
| GET | `/tags` | Bounded transaction-tag references |
| GET | `/recurring` | Bounded recurring-obligation snapshot |
| GET | `/cashflow` | Cash-flow summary |
| GET | `/budgets` | Bounded current budget status with explicit period |
