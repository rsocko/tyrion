# Monarch Integration Validation

## Evidence status

- Supported client: `monarchmoneycommunity==1.5.2`
- Deterministic validation: **2026-08-08**
- Controlled live validation: **pending an operator-run test account session**
- Repository policy: no credentials, cookies, session material, private financial
  records, raw upstream payloads, or machine-specific session paths

The repository intentionally contains synthetic structures only. A live operator may
record pass/fail and the validation date, but must not record account identifiers,
merchant names, balances, transaction values, response bodies, cookies, or tokens.

## Coverage matrix

| Contract | Deterministic evidence | Opt-in live evidence |
| --- | --- | --- |
| Password login | Success, invalid credentials, MFA challenge, CAPTCHA, timeout, rate limit | `TYRION_LIVE_AUTH_METHOD=password` |
| MFA completion | Success and invalid/expired code | Password live run with process-only MFA code |
| Cookie login | Success shape, invalid input, sanitized upstream failure | `TYRION_LIVE_AUTH_METHOD=cookies` |
| Saved-session restart | Load, verification, and connected state | Restart bridge, then run live auth-health check |
| Expiry and recovery | Expired cleanup and degraded retention | Revoke controlled session, verify `expired`, then set up again |
| Logout | In-memory and persisted state removal | Auth-flow live test verifies `unauthenticated` |
| Health/auth state | All four auth states and public reachability | `test_live_auth_health` |
| Transactions/filter/detail | Pagination, filters, detail, empty/error shapes | `test_live_read_and_sync_contracts` |
| Accounts/categories/recurring/cashflow/budgets | Normalized synthetic current-upstream structures | `test_live_read_and_sync_contracts` |
| Sync | Pagination and auth-error preservation | Seven-day controlled sync |
| Category write-back | Rejected writes are never success-shaped | Confirmed test mutation, read-back, and restoration |
| Remote transport | Token required, TLS acknowledgement required, restricted CORS | Homelab smoke test through TLS proxy |
| Production image | Non-root bridge-only runtime, public loopback health check, external session mount, no auth state in build context | Pull immutable image, mount restricted state, and smoke test through TLS proxy |
| Redaction | Stable errors omit upstream/session values | Review application and proxy logs after controlled failures |

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
- MFA codes are short-lived and cannot be stored or replayed.
- Session lifetime is controlled by Monarch and is not published.
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

The production image is `registry.socko.us/tyrion`. CI builds it without
credentials for pull requests; a successful `main` CI run publishes
`sha-<full-commit>`, `main`, and `latest` from the trusted homelab builder.
Existing SHA tags are never overwritten, and moving-tag promotion is serialized
and rechecks the current `main` revision.

The container contract is port `8100`, public `GET /health`, non-root UID/GID
`10001`, and a writable external mount at `/var/lib/tyrion` with
`SESSION_FILE=/var/lib/tyrion/session.json`. The session file and adjacent lease
must survive container replacement and must never enter an image layer, CI
artifact, log, or repository. Only one bridge process may mount and own a given
session directory at a time. The homelab stack selects the image with
`TYRION_IMAGE_TAG`, uses `BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`, sets
`BRIDGE_REMOTE_TLS=true`, `BRIDGE_LOAD_DOTENV=false`, and
`DEFAULT_TRANSACTION_DAYS=90`, and exposes no host port; private Traefik routing
at `https://tyrion.socko.us` is the only production ingress. The image's default
command starts `main.py`; the stack does not override it.

For a controlled homelab smoke test, inject `BRIDGE_API_TOKEN` and retain the
image defaults `BRIDGE_REMOTE_TLS=true` and
`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`. Confirm direct startup fails when
the token is absent or `BRIDGE_REMOTE_TLS` is explicitly overridden to `false`,
`/health` is reachable through the reverse proxy, protected endpoints reject
missing service authentication, and restart reuses the external session. Do not
run login, capture responses, or inspect the mounted session as part of image
publishing.
