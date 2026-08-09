# Monarch Integration Validation

## Evidence status

- Supported client: `monarchmoneycommunity==1.5.2`
- Deterministic validation: **2026-08-08**
- Controlled live validation: **2026-08-08** for browser-cookie setup, auth status,
  every supported read/sync contract, restart reuse, logout cleanup, and reversible
  category write-back
- Password live validation: **blocked by an ambiguous upstream `403`** on an account
  with MFA disabled; retained as a best-effort fallback
- Live category mutation: **completed 2026-08-08** with explicit confirmation,
  read-back verification, and restoration verification
- Repository policy: no credentials, cookies, session material, private financial
  records, raw upstream payloads, or machine-specific session paths

This validation establishes observed technical compatibility, not authorization from
Monarch Money, Inc. Tyrion is independent and unofficial. The service terms reviewed
on 2026-08-09 restrict programmatic access and related activity; see
[`LICENSING-AND-PROVENANCE.md`](LICENSING-AND-PROVENANCE.md#monarch-terms-and-affiliation).
Before live use, the account owner must review the then-current terms and decide
whether to obtain written permission, accept the account/contract risk, or keep the
bridge disabled.

The repository intentionally contains synthetic structures only. A live operator may
record pass/fail and the validation date, but must not record account identifiers,
merchant names, balances, transaction values, response bodies, cookies, or tokens.

## Coverage matrix

| Contract | Deterministic evidence | Opt-in live evidence |
| --- | --- | --- |
| Password login | Success, invalid credentials, MFA challenge, CAPTCHA, timeout, rate limit | Attempted 2026-08-08; blocked by ambiguous upstream `403` |
| MFA completion | Success and invalid/expired code | Password live run with process-only MFA code |
| Cookie login | Success shape, invalid input, sanitized upstream failure | Completed 2026-08-08 through the operational setup UI and server proxy |
| Saved-session restart | Load, verification, and connected state | Completed 2026-08-08 |
| Expiry and recovery | Expired cleanup and degraded retention | Revoke controlled session, verify `expired`, then set up again |
| Logout | In-memory and persisted state removal | Completed 2026-08-08; state and external session removal verified |
| Health/auth state | All four auth states and public reachability | `test_live_auth_health` |
| Transactions/filter/detail | Mission Control strict DTO parity, 1-500 page bound, bounded opaque cursor, filters, detail, empty/error shapes, malformed upstream rejection | Read contract completed 2026-08-08 |
| Accounts/categories/recurring/cashflow/budgets | Normalized synthetic current-upstream structures | Completed 2026-08-08 |
| Sync | Pagination and auth-error preservation | Controlled sync completed 2026-08-08 |
| Category write-back | Rejected writes are never success-shaped | Completed 2026-08-08 with explicit confirmation, read-back, and verified restoration |
| Remote transport | Token required, TLS acknowledgement required, restricted CORS | Homelab smoke test through TLS proxy |
| Production images | Separate non-root bridge/UI runtimes, route allowlist, loopback health checks, external session mount, no auth state in build contexts | Pull immutable images, mount restricted state, and smoke test private bridge plus TLS UI ingress |
| Redaction | Stable errors omit upstream/session values | Review application and proxy logs after controlled failures |

## Tyrion domain integration boundary

`kid-engine` is private Tyrion-internal code. Mission Control calls
`POST /api/internal/v1/attribution/batch` on the private Tyrion service network and
never installs or executes the engine. Each bounded request contains only an opaque
consumer source reference, normalized merchant name, calendar date,
household-scoped irreversible instrument fingerprint, observation timestamp, fixed
provenance marker, and optional structured manual-decision context. It cannot carry
Bridge pages, raw transaction/account identifiers, masks, amounts, notes, tags,
categories, session material, or credentials.

The Tyrion service derives actor and household scope from its signed service-client
configuration, loads the current policy snapshot server-side, and evaluates the
whole batch under one policy-version fence. Attribution failure does not change
bridge sync success: Mission Control persists the transaction with pending
attribution review and retries later. No controlled live Monarch validation is
required for attribution service changes; deterministic tests use invented
structures only.

## Safe live procedure

1. Use a dedicated controlled account and transaction where possible.
2. Revoke historical sessions before testing and create a fresh bridge-owned session.
3. Export sensitive values only into the current process; do not use tracked `.env`
   files, shell transcripts, CI variables with broad access, or command arguments.
4. Run `test_live_integration.py` without output capture or fixture-generation tools.
5. Enable mutation only after reviewing the dedicated transaction and confirmation
   phrase. Verify the test restores the original category.
6. Inspect logs for event codes only. Stop if any upstream body, filesystem path,
   account identifier, email, cookie, authorization value, or credential appears.
7. Revoke the controlled session after testing when it is not needed.

## Known upstream limitations

- Monarch's API is private and may change without notice.
- CAPTCHA can block password login; cookie setup is a recovery path, not a second
  session owner.
- The supported client currently maps most login `403` responses to an MFA challenge.
  When account MFA is disabled, treat that response as an ambiguous programmatic-login
  rejection and use the browser-cookie recovery path.
- MFA codes are short-lived and cannot be stored or replayed.
- Session lifetime is controlled by Monarch and is not published.
- The community client reports that saved sessions may last several months, but no
  fixed TTL is guaranteed: https://pypi.org/project/monarchmoneycommunity/
- Browser `Expires`/`Max-Age` metadata is visible manually in DevTools but is not
  available through normal page JavaScript with the cookie values omitted:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- `monarchmoneycommunity==1.5.2` replays its saved cookie dictionary and does not
  capture rotated `Set-Cookie` responses. Tyrion therefore detects expiry from an
  explicit upstream authentication rejection instead of predicting it.
- Rate limits are not published; the bridge maps observed throttling to a stable
  `upstream_rate_limited` response.
- Network timeouts and unknown upstream failures produce `degraded`; explicit
  authentication rejection produces `expired` and removes persisted state.
- Category updates are non-transactional upstream. Live validation always reads back
  the change and restores the original category.

## Contract refresh

When upgrading `monarchmoneycommunity`, pin the exact version, verify method
signatures, update synthetic normalizer inputs, run deterministic tests, then perform
the controlled live matrix. Never capture a real response as a fixture. Reconstruct
only the minimum structural shape with invented identifiers and values.

## Container deployment validation

The production images are `registry.socko.us/tyrion-bridge` and
`registry.socko.us/tyrion-ui`. CI builds both without credentials for pull requests;
a successful `main` CI run publishes `sha-<full-commit>`, `main`, and `latest` for
each from the trusted homelab builder. Existing SHA tags are never overwritten, and
moving-tag promotion is serialized, rechecks the current `main` revision, and waits
for both immutable builds before promoting both image families from the same commit.

The bridge container contract is port `8100`, public `GET /health`, non-root UID/GID
`10001`, and a writable external mount at `/var/lib/tyrion` with
`SESSION_FILE=/var/lib/tyrion/monarch-session.json`. The session file and adjacent
lease must survive container replacement and must never enter an image layer, CI
artifact, log, or repository. Only one bridge process may mount and own a given
session directory at a time. The image defaults
`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`, `BRIDGE_REMOTE_TLS=true`,
`BRIDGE_LOAD_DOTENV=false`, and `DEFAULT_TRANSACTION_DAYS=90`; the homelab stack
repeats these settings and selects the image with `TYRION_BRIDGE_IMAGE_TAG`. It has
no host port or Traefik route. The image's default command starts `main.py`; the
stack does not override it.

The UI container contract is port `3000`, `GET /api/health`, non-root UID/GID
`10001`, a read-only root filesystem, and runtime-only `BRIDGE_URL` plus
`BRIDGE_API_TOKEN`. It is selected with `TYRION_UI_IMAGE_TAG` and is the only
production ingress at `https://tyrion.socko.us`. Its proxy permits only health,
auth setup/status/logout, and sync limited to 90 days; the rendered UI fixes sync
to 30 days. Broad finance routes return `404`.

Mission Control does not use the UI ingress as a bridge origin. Its server and sync
worker join `tyrion-backend`, call
`http://tyrion-monarch-bridge:8100`, and send the shared service token as a bearer
credential. The public UI origin intentionally returns `404` for `/health`; its
allowlisted `/api/bridge/health` route only confirms private bridge reachability for
operations.

For a controlled homelab smoke test, inject the same `BRIDGE_API_TOKEN` into both
containers and retain `BRIDGE_REMOTE_TLS=true` and
`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`. Confirm bridge startup fails when the
token is absent or `BRIDGE_REMOTE_TLS` is explicitly overridden to `false`, the
bridge has no ingress route, UI `/api/health` is reachable through TLS, protected
proxy operations work, broad proxy/UI routes return `404`, and restart reuses the
external session. Do not run login, capture responses, or inspect the mounted
session as part of image publishing.
