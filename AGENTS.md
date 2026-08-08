# Tyrion Agent Instructions

## Solution boundary

Tyrion is Mission Control's household-finance domain. Monarch remains the financial
system of record, and Mission Control remains the user-facing shell.

- Read `docs/PRODUCT-BOUNDARY.md` before changing product scope; it is authoritative.
- `monarch-bridge/` is the sole owner of reusable Monarch session material.
- `triage-app/` is a bounded debug and contract-validation UI, not a separate product.
- Scheduled sync, Mission Control, and MCP callers use the protected bridge contract;
  they must not load or create independent Monarch sessions.
- Preserve the public DTO boundary in `monarch-bridge/contract.py`. Do not expose raw
  upstream response shapes to consumers.

## Sensitive-data rules

Never write credentials, passwords, MFA seeds or codes, authorization values, browser
cookies, session files, private financial records, raw live responses, account or
transaction identifiers, or machine-specific state paths into the repository,
shell transcripts, CI artifacts, issues, pull requests, or screenshots.

- Do not place sensitive values in tracked or untracked environment files. Example
  environment files use blank or clearly bracketed placeholders only.
- Keep runtime sessions outside every Git repository with least-privilege access.
- Do not log authentication request bodies, upstream exception text, session paths,
  account identifiers, or sensitive response bodies.
- Keep bridge service tokens server-only. Never use a `NEXT_PUBLIC_` variable for them.
- Deterministic tests use invented structures and temporary session paths.
- Live tests remain opt-in and process-environment-only. Never capture live payloads
  as fixtures or redirect their output into files.
- Category mutation requires the repository's explicit confirmation gate and must
  verify and restore the original value.
- Before completion, inspect tracked file names and contents for accidentally added
  environment files, sessions, keys, cookies, tokens, or live artifacts.

## Next.js guidance

The debug UI uses the version pinned in `triage-app/package.json`. Before changing
framework APIs or conventions, inspect the relevant installed documentation under
`triage-app/node_modules/next/dist/docs/` and heed deprecation notices.

- Browser code calls the Next.js `/api/bridge/...` proxy.
- Only the server-side proxy may read `BRIDGE_URL` and `BRIDGE_API_TOKEN`.
- Proxy errors must be stable and sanitized; never return raw connection exceptions.
- Preserve loading, unavailable, unauthenticated, expired, degraded, and connected
  states where the affected UI can encounter them.

## Local development

### Monarch bridge

Use demo mode for normal development and automated testing. It must not contact
Monarch or load developer auth state.

```powershell
Set-Location monarch-bridge
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pytest test_auth.py test_bridge.py
.\.venv\Scripts\python.exe main.py --demo
Set-Location ..
.\monarch-bridge\.venv\Scripts\python.exe -m compileall -q monarch-bridge
```

The bridge binds to loopback by default. Do not weaken the non-loopback token and TLS
requirements, restricted CORS policy, auth payload bounds, sanitized errors, external
atomic session storage, or cross-process session lease.

Do not run credentialed live tests unless the user explicitly requests the controlled
run and supplies secrets outside the repository. Never perform a live category
mutation without the separate confirmation required by `test_live_integration.py`.
For auth, session, or upstream-contract changes, review and update
`docs/MONARCH-INTEGRATION-VALIDATION.md`. Keep `monarchmoneycommunity==1.5.2` pinned
unless signatures, synthetic normalizers, deterministic coverage, and the controlled
live matrix are refreshed together.

### Debug UI

```powershell
Set-Location triage-app
npm ci
npm run build
npm run dev -- --hostname 127.0.0.1 --port 3098
```

Use an available loopback port. If local environment configuration is needed, start
from `.env.example` for non-sensitive values only. Pass secrets in the current
operator process; never print, persist, or commit their values.

## Task completion workflow

### Phase 1: Complete the change

- Implement the full requested behavior across bridge, proxy, UI, contracts, tests,
  examples, and operational documentation where relevant.
- Follow existing naming, DTO, error-code, and normalization conventions.
- Avoid unrelated changes and do not rewrite historical design documents unless the
  changed behavior makes them inaccurate.

### Phase 2: Self-review

Review the change for:

- **Correctness:** Logic errors, boundary values, null handling, contract mismatches,
  incomplete flows, and unexpected success-shaped failures.
- **Security:** Authentication bypasses, non-loopback exposure, permissive CORS,
  secret leakage, unsafe session paths or permissions, raw errors, unbounded inputs,
  proxy token exposure, and accidental live access.
- **Runtime sensitive-data exposure:** Secrets and private data emitted through
  application, proxy, test, or CI logs; telemetry; exception text; API error payloads;
  browser output; screenshots; snapshots; and generated artifacts.
- **GitHub and review exposure:** Secrets and private data present in tracked or
  untracked files, the complete PR diff, fixtures, examples, documentation, generated
  output, commit messages, PR titles or descriptions, review comments, and uploaded
  CI artifacts.
- **Session lifecycle:** Creation, atomic replacement, restart reuse, expiry cleanup,
  degraded state, logout, concurrent processes, and recovery.
- **Error handling:** Stable public codes, useful sanitized messages, preserved HTTP
  semantics, and no broad catches or silent failure.
- **Type safety:** Pydantic validation, TypeScript nullability, unsafe casts, and DTO
  drift between Python and TypeScript.
- **Concurrency and performance:** Session races, pagination termination, unbounded
  loops, duplicate upstream calls, and unnecessary client re-renders.
- **UX and accessibility:** Loading and recovery states, keyboard-accessible controls,
  labels, focus behavior, and actionable errors.
- **Repository hygiene:** TODOs, generated output, local state, secrets, and stale docs.

### Phase 3: Coverage

- Add deterministic tests for every changed auth state, error code, endpoint contract,
  and security boundary.
- Tests must not load `.env`, a developer session, or contact Monarch.
- Assert exact status/error behavior; never permit an unexpected `500`.
- Keep credentialed live checks in `test_live_integration.py`, disabled by default.

### Phase 4: Verify

- Run the smallest relevant Python tests and the Next.js build/type checks.
- Run `git diff --check`.
- Re-run sensitive-file/content checks after the final edit. Inspect changed and
  untracked file names and contents, the complete staged and unstaged diff, and any
  commit or PR metadata prepared for GitHub; separately verify that exercised runtime
  paths emit only sanitized logs, errors, telemetry, and artifacts.
- Confirm documentation and example configuration match runtime behavior.

### Phase 5: Specialized review

- Run the `code-review` agent on the completed diff and address confirmed correctness,
  security-boundary, and regression findings.
- When the user explicitly requests an exploitable-vulnerability review, also run the
  `security-review` specialist before making further security conclusions.
