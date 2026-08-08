# Monarch Bridge Service

The bridge is Tyrion's sole owner of Monarch authentication state. Mission Control,
scheduled sync, the debug UI, and MCP tooling must call this service rather than
creating or persisting separate Monarch sessions.

## Supported client

`monarchmoneycommunity==1.5.2` is pinned in `requirements.txt`. Authentication,
transaction pagination, and category mutation signatures are covered by deterministic
tests. Upgrade the pin only with a contract-test and controlled live-validation run.

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# Safe fixture data; never contacts Monarch.
.\.venv\Scripts\python.exe main.py --demo

# Headless/recovery setup. The normal setup surface is Mission Control Settings.
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

## Mission Control proxy

The browser calls the Next.js `/api/bridge/...` route. That server-side route forwards
requests to the bridge and injects `BRIDGE_API_TOKEN` when configured. The token must
remain server-only; never use a `NEXT_PUBLIC_` variable. Scheduled sync and MCP clients
must use the same bridge URL and service token.

The Settings UI and `python main.py --setup` are initiation surfaces for the same
bridge-owned session. They do not create independent session stores. Browser-cookie
setup is the recommended UI path because Monarch may reject programmatic password
login even when account MFA is disabled; email/password remains a best-effort fallback.

## Authenticated homelab deployment

Loopback is the default. A non-loopback bind fails closed unless:

1. `BRIDGE_API_TOKEN` is a random value of at least 32 characters.
2. TLS is terminated by a trusted reverse proxy and `BRIDGE_REMOTE_TLS=true`.
3. `BRIDGE_ALLOWED_ORIGINS` contains only intended browser origins.
4. The Next.js server, scheduled jobs, and MCP clients send the service token over TLS.

```dotenv
BRIDGE_HOST=192.0.2.10
BRIDGE_API_TOKEN=<random-server-only-value>
BRIDGE_REMOTE_TLS=true
BRIDGE_ALLOWED_ORIGINS=https://mission-control.example
```

Only `/health` and `/contract` are public. Public health reports reachability and a
coarse auth state; all auth, read, sync, mutation, OpenAPI, and docs routes require
service authentication in a remote deployment. Put rate limits and request logging
redaction at the reverse proxy, and never log request bodies or authorization headers.
Start the service through `main.py`; if a raw ASGI server overrides the bind address,
non-loopback clients still fail closed, but that is not a supported TLS deployment.

## Session lifecycle

| State | Meaning | Operator action |
| --- | --- | --- |
| `unauthenticated` | No bridge-managed session exists | Start setup from Mission Control or the CLI |
| `connected` | The session passed a live account check | No action |
| `expired` | Monarch rejected the session; persisted state was removed | Authenticate again |
| `degraded` | A session exists but Monarch is temporarily unavailable or returned an unknown failure | Retry, then reauthenticate if it persists |

Startup loads only the bridge-owned session. `GET /auth/status` verifies it against
Monarch. Expired or unreadable sessions are removed. Logout clears in-memory and
persisted state. A cross-process lease prevents a second bridge process from loading
or deleting the session while it is owned. To revoke access held by another device,
revoke Monarch sessions upstream as well.

Browser cookies cannot be refreshed automatically because Monarch does not provide the
bridge a refresh credential. When an upstream request explicitly rejects the session,
the bridge removes it, preserves the `expired` health state, and requires the user to
copy fresh browser cookie values. Transient network/upstream failures retain the
session as `degraded` instead of forcing reauthentication.

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
| GET | `/categories` | Categories |
| GET | `/accounts` | Accounts |
| GET | `/recurring` | Recurring transactions |
| GET | `/cashflow` | Cash-flow summary |
| GET | `/budgets` | Budget status |
