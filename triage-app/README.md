# Tyrion Monarch connector operations UI

This Next.js application is the narrowly scoped operational surface for Tyrion's
Monarch bridge. Production exposes bridge reachability, authentication status,
browser-cookie setup, email/password/MFA fallback, logout, and a bounded 30-day
sync/recheck action. Mission Control remains the finance shell, and Monarch remains
the financial system of record.

The production route tree must not expose transactions, accounts, categories,
budgets, bills, kid views, generic triage, chat, or other finance product pages. The
server proxy independently enforces the same boundary. See
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

## Build and test

```powershell
npm ci
npm run build
npm test
```

The production image is `registry.socko.us/tyrion-ui`, listens on port `3000`, runs
as UID/GID `10001`, and reports liveness at `GET /api/health`. Runtime configuration:

| Variable | Purpose |
| --- | --- |
| `BRIDGE_URL` | Private bridge URL, normally `http://tyrion-monarch-bridge:8100` |
| `BRIDGE_API_TOKEN` | Shared server-only bridge token; required for protected operations |
