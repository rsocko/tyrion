# Monarch Integration Validation

## Evidence status

- Supported client: `monarchmoneycommunity==1.5.2`
- Deterministic validation: **2026-08-08**
- Controlled live validation: **2026-08-08** for browser-cookie setup, auth status,
  read/sync contracts, restart reuse, and logout cleanup
- Password live validation: **blocked by an ambiguous upstream `403`** on an account
  with MFA disabled; retained as a best-effort fallback
- Live category mutation: **not run**
- Repository policy: no credentials, cookies, session material, private financial
  records, raw upstream payloads, or machine-specific session paths

The repository intentionally contains synthetic structures only. A live operator may
record pass/fail and the validation date, but must not record account identifiers,
merchant names, balances, transaction values, response bodies, cookies, or tokens.

## Coverage matrix

| Contract | Deterministic evidence | Opt-in live evidence |
| --- | --- | --- |
| Password login | Success, invalid credentials, MFA challenge, CAPTCHA, timeout, rate limit | Attempted 2026-08-08; blocked by ambiguous upstream `403` |
| MFA completion | Success and invalid/expired code | Password live run with process-only MFA code |
| Cookie login | Success shape, invalid input, sanitized upstream failure | Completed 2026-08-08 through the Settings UI and server proxy |
| Saved-session restart | Load, verification, and connected state | Completed 2026-08-08 |
| Expiry and recovery | Expired cleanup and degraded retention | Revoke controlled session, verify `expired`, then set up again |
| Logout | In-memory and persisted state removal | Completed 2026-08-08; state and external session removal verified |
| Health/auth state | All four auth states and public reachability | `test_live_auth_health` |
| Transactions/filter/detail | Pagination, filters, detail, empty/error shapes | Read contract completed 2026-08-08 |
| Accounts/categories/recurring/cashflow/budgets | Normalized synthetic current-upstream structures | Completed 2026-08-08 |
| Sync | Pagination and auth-error preservation | Controlled sync completed 2026-08-08 |
| Category write-back | Rejected writes are never success-shaped | Confirmed test mutation, read-back, and restoration |
| Remote transport | Token required, TLS acknowledgement required, restricted CORS | Homelab smoke test through TLS proxy |
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
- The supported client currently maps most login `403` responses to an MFA challenge.
  When account MFA is disabled, treat that response as an ambiguous programmatic-login
  rejection and use the browser-cookie recovery path.
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
