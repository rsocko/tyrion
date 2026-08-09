# Tyrion operations and configuration UI

This Next.js application is Tyrion's bounded money-domain administration surface.
`/` owns Monarch connector setup and operations. `/configuration` owns household kid
profiles, attribution rules, limits, exception policy, policy versioning, and
controlled re-attribution. Mission Control remains the daily finance shell, and
Monarch remains the financial system of record.

The production route tree must not expose transactions, accounts, categories,
budgets, bills, dashboards, generic triage, chat, or reporting pages. The bridge
proxy independently enforces the same boundary. See
[`../docs/PRODUCT-BOUNDARY.md`](../docs/PRODUCT-BOUNDARY.md).

## Local development

Run the bridge in deterministic demo mode, then start the UI:

```powershell
Set-Location ..\monarch-bridge
.\.venv\Scripts\python.exe main.py --demo

Set-Location ..\triage-app
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3098
```

`BRIDGE_URL` and `BRIDGE_API_TOKEN` are server-only. Browser code calls only
`/api/bridge/...`; never create a `NEXT_PUBLIC_` token variable. The proxy permits:

| Method | Proxy path | Bridge operation |
| --- | --- | --- |
| GET | `/api/bridge/health` | Reachability and coarse state |
| GET | `/api/bridge/auth/status` | Verified authentication state |
| POST | `/api/bridge/auth/login-with-cookies` | Preferred setup |
| POST | `/api/bridge/auth/login` | Password/MFA fallback |
| POST | `/api/bridge/auth/logout` | Session removal |
| POST | `/api/bridge/sync?days=1..90` | Bounded sync; UI uses 30 |

All other bridge paths, methods, and query expansion are rejected before an upstream
call. Proxy failures use stable sanitized JSON and never return connection exceptions.

## Policy security and persistence

Browser requests never supply a trusted household, actor, or permission. A trusted
ingress/auth service must remove any inbound `x-tyrion-*` assertion headers and add:

| Header | Value |
| --- | --- |
| `x-tyrion-actor` | Authenticated bounded actor ID |
| `x-tyrion-household` | Authorized household ID |
| `x-tyrion-permissions` | Ordered comma-separated v1 permissions |
| `x-tyrion-auth-timestamp` | Current Unix timestamp in seconds |
| `x-tyrion-auth-signature` | Lowercase HMAC-SHA256 signature |

The signature key is `TYRION_POLICY_AUTH_SECRET` and the signed UTF-8 payload is the
newline-joined request method, pathname, actor ID, household ID, permissions string,
and timestamp. Assertions expire after 60 seconds and are bound to the route and
method. Missing deployment configuration returns `503`; missing, stale, malformed,
or invalid assertions return `401`. Mutations also require same-origin browser
metadata. `PolicyService` independently enforces household equality and each v1
permission.

`TYRION_POLICY_STORE_PATH` must be an absolute access-restricted path outside the
application checkout. The file adapter provides atomic replacement, a cross-process
lease, metadata-only audit events, and compare-and-swap policy versions.
`TYRION_INSTRUMENT_FINGERPRINT_KEY` must contain at least 32 characters. Raw
integration references are accepted only by the protected fingerprint endpoint,
HMAC-fingerprinted with household scope, discarded, and never returned or persisted.

Policy browser endpoints are:

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/policy` | `policy:read` |
| `PUT` | `/api/policy` | `policy:write` |
| `POST` | `/api/policy/instruments/fingerprint` | `policy:write` |
| `POST` | `/api/policy/reattribution/preview` | `reattribution:preview` |
| `POST` | `/api/policy/reattribution/apply` | `reattribution:apply` |

Policy writes require `expectedPolicyVersion`. Preview accepts 1-100 explicit opaque
record references and returns only policy/version/expiry metadata plus deterministic
impact counts. Apply requires a separately authorized request with `confirm: true`,
an unexpired persisted preview, and the same policy version.

Production re-attribution uses the server-only
`TYRION_REATTRIBUTION_URL`/`TYRION_REATTRIBUTION_TOKEN` adapter. It calls fixed
internal `POST` operations under `/v1/reattribution/` to resolve records, persist and
resolve previews, and atomically apply a preview. That implementation must preserve
newer manual decisions and compare the active policy version in its transaction.
HTTPS is required unless
`TYRION_REATTRIBUTION_ALLOW_INSECURE_INTERNAL=true` explicitly authorizes private
network HTTP. Re-attribution fails closed when this optional adapter is absent;
policy CRUD and connector operations remain available.

## Internal batch attribution service

Mission Control calls `POST /api/internal/v1/attribution/batch` by private backend
DNS. This is a Tyrion domain endpoint, not a Bridge proxy or browser route. The
public `tyrion.socko.us` Traefik routers must exclude `/api/internal/`; the service
also rejects any host other than `TYRION_ATTRIBUTION_INTERNAL_HOST`.

The exact v1 request, response, header, status, and schema contract is
[`../docs/attribution-service-v1.openapi.json`](../docs/attribution-service-v1.openapi.json).
Requests are limited to 64 KiB and 100 unique items. A dedicated service assertion
binds method, path, private host, configured client ID, Unix timestamp, random nonce,
and lowercase SHA-256 body digest with HMAC-SHA256. Assertions expire after 60
seconds, each nonce is accepted once through the external replay store, and the
service permits 60 requests per minute per configured client.

Actor ID, household ID, and the sole `attribution:batch` permission come from Tyrion
server configuration; request headers and bodies cannot override them. Mission
Control must treat any non-200 response as an attribution-only failure: persist the
transaction with pending review, do not tombstone transaction generation, and retry
according to the stable error code.

For deterministic local development only, set `TYRION_POLICY_DEMO_MODE=true` while
`NODE_ENV` is not `production`. Demo mode uses invented in-memory policy and record
state, never contacts Monarch, and never loads developer auth state. Production
rejects demo mode.

## Build and test

```powershell
npm ci
npm --prefix ../kid-engine run build
npm run build
npm test
```

The production image is `registry.socko.us/tyrion-ui`, listens on port `3000`, runs
as UID/GID `10001`, and reports liveness at `GET /api/health`. Runtime configuration:

| Variable | Purpose |
| --- | --- |
| `BRIDGE_URL` | Private bridge URL, normally `http://tyrion-monarch-bridge:8100` |
| `BRIDGE_API_TOKEN` | Shared server-only bridge token; required for protected operations |
| `TYRION_POLICY_STORE_PATH` | External absolute policy/audit store path |
| `TYRION_POLICY_AUTH_SECRET` | Shared HMAC key used only by trusted auth integration and Tyrion |
| `TYRION_INSTRUMENT_FINGERPRINT_KEY` | Server-only household fingerprint HMAC key |
| `TYRION_REATTRIBUTION_URL` | Optional protected internal re-attribution repository service |
| `TYRION_REATTRIBUTION_TOKEN` | Optional server-only integration token |
| `TYRION_ATTRIBUTION_CLIENT_ID` | Configured least-privilege Mission Control service client |
| `TYRION_ATTRIBUTION_ACTOR_ID` | Server-derived service actor used for safe manual-decision provenance |
| `TYRION_ATTRIBUTION_HOUSEHOLD_ID` | Household scope assigned to the service client |
| `TYRION_ATTRIBUTION_AUTH_SECRET` | Server-only HMAC key shared with the one service client |
| `TYRION_ATTRIBUTION_INTERNAL_HOST` | Private service authority accepted by the endpoint |
| `TYRION_ATTRIBUTION_REPLAY_STORE_PATH` | External directory for short-lived atomic nonce records |
