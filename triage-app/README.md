# Tyrion operations and configuration UI

This Next.js application is Tyrion's bounded money-domain administration surface.
`/` owns Monarch connector setup and operations. `/configuration` owns household kid
profiles, attribution rules, limits, exception policy, policy versioning, and
controlled re-attribution. Mission Control remains the daily finance shell, and
Monarch remains the financial system of record.

The Monarch connector is independent and unofficial. It is not affiliated with,
endorsed by, sponsored by, or supported by Monarch Money, Inc. See the repository's
[licensing, terms-risk, dated owner acceptance, and provenance review](../docs/LICENSING-AND-PROVENANCE.md).
Live mode remains opt-in, and the community client license does not authorize
access to Monarch's service.

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

## Mission Control reconnect handoff

Mission Control links the operator to
`https://[tyrion-host]/?source=mission-control` for connector recovery. It does not
send cookie values, bearer credentials, session material, a return URL, or other
state in that link. Tyrion treats only that exact single query parameter as a recovery
entry and continues to own cookie-based authentication and external session storage.

The recovery UI does not report completion after login alone. It clears cookie,
password, and MFA fields as soon as the authentication request starts, verifies live
`/auth/status`, requires one successful 30-day `/sync`, and rechecks authentication.
Only the connected-plus-synced state exposes a return link.

The optional return destination is fixed by server configuration:

| Variable | Requirement |
| --- | --- |
| `MISSION_CONTROL_RETURN_URL` | Exact HTTPS Mission Control page; no credentials, query, or fragment |
| `MISSION_CONTROL_RETURN_ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins allowed for the configured return |

Both values must validate, and the URL origin must be allowlisted. Otherwise Tyrion
shows manual-return guidance and never uses a destination from the browser URL.
Mission Control must verify its connector health and resume its projections after the
operator returns; the browser handoff carries no recovery assertion or secret.

## Mission Control connector gateway

Mission Control server and worker processes use
`https://tyrion.socko.us/api/connector/v1`, not `/api/bridge/...`. Every request,
including health and contract, must carry the same server-only `BRIDGE_API_TOKEN` as a
Bearer credential. The token must be at least 32 characters and must never enter
browser code. Requests with browser-origin metadata are rejected even when they carry
the credential.

The gateway exposes only `GET /health`, `GET /contract`, bounded transaction
list/detail/splits, `PATCH` category mutation, account/category-group/category/tag/
recurring/budget reads, and `POST /sync?days=1..365`. It rejects `/auth/*`, cash flow,
OpenAPI/docs, policy, internal attribution, arbitrary passthrough, unknown methods,
query expansion, bodies on bodyless operations, request bodies above 1 KiB, and
responses above 8 MiB. Bridge JSON bodies, status, and safe contract headers are
preserved after validation; proxy and invalid-response failures are sanitized.

Connector `GET /health` is composed rather than passed through. The server makes one
protected Bridge `/auth/status` verification with `BRIDGE_API_TOKEN`, bounds the
response to 4 KiB, validates its explicit v1 shape and contract version, then
returns only `contractVersion`, `status`, `mode`, `reachable`, `authenticated`, and
`authState`. A successful verification sets reachability, supplies mode and auth
state, and derives `ok` for connected/unauthenticated or `degraded` for
expired/degraded. Email is never returned.
Non-2xx, timeout/network, invalid, oversized, and contract-mismatch failures are
sanitized non-success responses. `/api/connector/v1/auth/status` remains blocked by
both route policy and Traefik.

The production Traefik contract routes `/api/connector/v1/` separately over TLS
without the UI's private-network middleware. All other UI routes retain that
middleware, and every public router continues to exclude `/api/internal/`. Traefik
enumerates the connector paths and stamps an internal marker; the Next.js proxy checks
that marker after URL normalization to block encoded traversal into any private API.

## Policy security and persistence

The supported production boundary is one trusted, single-household homelab, not a
public or multi-tenant application. Compose publishes no direct UI port. Browser
access goes through Traefik's `trusted-private-networks` middleware, and every public
router excludes `/api/internal/`.

Policy routes use fixed server-derived `homelab-household` and `local-operator`
identities with the bounded policy/re-attribution permissions. Browser identity,
household, permission, and `x-tyrion-*` headers are ignored. Mutations still require
same-origin browser metadata, and `PolicyService` still enforces household equality
and each v1 permission.

`TYRION_POLICY_STORE_PATH` must be an absolute access-restricted path outside the
application checkout. The file adapter provides atomic replacement, a cross-process
lease, metadata-only audit events, and compare-and-swap policy versions. On first
access it atomically adopts a sole policy and its audit events from the superseded
configurable household ID into `homelab-household`.
Raw integration references are accepted only by the protected fingerprint endpoint.
On first startup, Tyrion derives a domain-separated HMAC key from the required
server-only `BRIDGE_API_TOKEN` and persists only that derived key beside the protected
policy store with restrictive permissions. Later bridge-token rotation reuses the
derived key, so current card rules remain stable. Tyrion fingerprints each reference
with household scope, then discards the raw value without returning or persisting it.
Existing card-rule fingerprints created with the superseded standalone fingerprint
key remain private but cannot be converted; re-enroll those card rules once during
this contract transition.

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

Production re-attribution and Mission Control attribution actions use the server-only
`TYRION_REATTRIBUTION_URL`/`TYRION_REATTRIBUTION_TOKEN` adapter. It calls fixed
internal `POST` operations under `/v1/reattribution/` to resolve records, persist and
resolve previews, and atomically apply a preview, plus
`/v1/attribution-actions/records:resolve` and
`/v1/attribution-actions/actions:resolve` to replay prior actions, and
`/v1/attribution-actions/actions:apply` for versioned exception state. That
implementation must preserve newer manual decisions, retain replay history, bind each
idempotency key to the original mutation parameters, enforce state versions, and
compare the active policy version in its transaction.
HTTPS is required unless
`TYRION_REATTRIBUTION_ALLOW_INSECURE_INTERNAL=true` explicitly authorizes private
network HTTP. Re-attribution fails closed when this optional adapter is absent;
policy CRUD and connector operations remain available.

## Internal attribution services

Mission Control calls `POST /api/internal/v1/attribution/batch` and
`POST /api/internal/v1/attribution/actions` by private backend DNS. These are Tyrion
domain endpoints, not Bridge proxies or browser routes. The
public `tyrion.socko.us` Traefik routers must exclude `/api/internal/`; the service
also requires `Host: tyrion-operations-ui:3000` and, when present, the same value in
`x-forwarded-host`.

The exact v1 request, response, header, status, and schema contract is
[`../docs/attribution-service-v1.openapi.json`](../docs/attribution-service-v1.openapi.json).
Requests are limited to 64 KiB; batch requests contain at most 100 unique items.
Mission Control sends the
existing server-only
`BRIDGE_API_TOKEN`/finance-manager token as a standard bearer credential. Tyrion
derives the fixed `mission-control-finance-manager` actor, `homelab-household` scope,
and least-privilege `attribution:batch` and `attribution:actions` permissions
internally; request headers and bodies cannot override them. Mission Control must
treat any non-200 response as an
attribution-only failure: persist the transaction with pending review, do not
tombstone transaction generation, and retry according to the stable error code.

For deterministic local development only, set `TYRION_POLICY_DEMO_MODE=true` while
`NODE_ENV` is not `production`. Demo mode uses invented in-memory policy and record
state, never contacts Monarch, and never loads developer auth state. Production
rejects demo mode.

## Build and test

```powershell
npm ci
npm --prefix ../kid-engine ci --no-audit --no-fund
npm --prefix ../kid-engine run build
npm --prefix ../kid-engine run audit
npm run lint
npm run typecheck
npm run build
npm test
npm run audit
```

Next.js 16 requires Node.js 20.9 or newer. Development and production builds use
Turbopack by default. The build retains standalone output rooted at the repository so
the local Tyrion domain package is traced into the production image. The production
image listens on port `3000`, runs as UID/GID `10001`, and reports liveness at
`GET /api/health`. Trusted `main` pushes publish it as
`ghcr.io/rsocko/tyrion-ui:sha-<commit>`, `build-N`, `main`, and `latest` from one
manifest digest without rebuilding. Canonical Compose follows `latest`; `build-N`,
the commit tag, and the digest support rollback and pinning.

The approved development registry currently resolves Next.js 16.2.12 and Nano ID
3.3.16. Sharp is independently overridden to patched 0.35.3. The UI and kid-engine
development graphs pin PostCSS 8.5.25. Their audit policy permits only
GHSA-2v37-7h3g-55p8 through 2026-09-09: PostCSS imports the non-secure Nano ID entry
point and calls only `nanoid(6)`, never the affected zero-size custom generators.
The policy fails on any other high-severity advisory, changed dependency or call
shape, or expiration. Replace the exception with Nano ID 3.3.17 or newer as soon as
the approved registry carries it.

Runtime configuration:

| Variable | Purpose |
| --- | --- |
| `BRIDGE_URL` | Private server-side bridge endpoint |
| `BRIDGE_API_TOKEN` | Shared server-only bridge/finance-manager token (minimum 32 characters); authenticates the public connector gateway and private attribution, and domain-separates fingerprinting |
| `MISSION_CONTROL_RETURN_URL` | Optional exact HTTPS return page shown only after verified authentication and bounded sync |
| `MISSION_CONTROL_RETURN_ALLOWED_ORIGINS` | Optional exact HTTPS origin allowlist for the return page |
| `TYRION_POLICY_STORE_PATH` | External absolute policy/audit store path |
| `TYRION_REATTRIBUTION_URL` | Optional protected internal re-attribution and attribution-action state service |
| `TYRION_REATTRIBUTION_TOKEN` | Optional server-only attribution-state integration token |
