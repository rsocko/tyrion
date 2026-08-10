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
On 2026-08-09, the owner accepted the identified account and contract risk and
retained the existing opt-in live mode for personal, non-commercial use. That
decision does not treat the community client's license as authorization to access
Monarch's service. Demo mode remains the default for development and automation;
live tests remain disabled by default and subject to the controlled gates below.

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
| Transactions/filter/detail | Mission Control strict DTO parity; 366-day window; 1-500 page; 5,000-item normalized-filter scan; bounded opaque cursor; exact account, category, merchant, tag, amount, pending, and recurring filters; duplicate/unknown-query rejection; detail; empty/error shapes; malformed upstream rejection | Existing read contract completed 2026-08-08; issue #140 filter expansion requires controlled live validation |
| Transaction splits | Normalized split identity, signed amount, merchant name, nullable category, 100-item hard limit, empty/not-found/malformed/over-limit shapes, and sanitized expiry/timeout/rate-limit/upstream failures | Controlled live validation required for issue #140 |
| Accounts/category groups/categories/transaction tags/recurring/cashflow/budgets | Normalized synthetic current-upstream structures; stable reference IDs; additive transaction tag references; explicit budget period; authoritative-empty, malformed, and dataset-bound behavior | Accounts/categories/recurring/cashflow/budgets completed 2026-08-08; category groups, transaction tags, additive category/tag identity, and explicit budget periods require the next controlled read-only validation |
| Sync | Pagination and auth-error preservation | Controlled sync completed 2026-08-08 |
| Category write-back | Rejected writes are never success-shaped | Completed 2026-08-08 with explicit confirmation, read-back, and verified restoration |
| Remote transport | Token required, TLS acknowledgement required, restricted CORS | Homelab smoke test through TLS proxy |
| Public connector gateway | Constant-time bearer validation; exact Traefik and v1 route/method/query/body allowlists; post-normalization ingress-marker check; browser rejection; 1 KiB request and 8 MiB general response bounds; composed health with one 4 KiB `/auth/status` verification, explicit v1 shape/version validation, derived status/reachability, no auth-field leakage, and sanitized non-success failures; status/body/safe-header preservation for passthrough operations; separation from UI proxy and internal APIs | TLS smoke test from a backend client using invented/demo data only |
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

Mission Control authenticates with the existing server-only
`BRIDGE_API_TOKEN`/finance-manager bearer credential on the private Docker network.
Tyrion derives the fixed `mission-control-finance-manager` actor and
`homelab-household` scope internally, loads the current policy snapshot server-side,
and evaluates the whole batch under one policy-version fence. Attribution failure
does not change bridge sync success: Mission Control persists the transaction with
pending attribution review and retries later. No controlled live Monarch validation
is required for attribution service changes; deterministic tests use invented
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
- Reference and current-snapshot reads are complete-or-error. The bridge accepts an
  authoritative empty collection, rejects missing/non-array/invalid/oversized
  collections as sanitized `502 upstream_error`, and never publishes a truncated
  success. Deterministic limits are 1,000 accounts, 250 category groups, 2,000
  categories, 1,000 transaction tags, 5,000 recurring obligations, and 5,000 current
  budget rows.

## Contract refresh

When upgrading `monarchmoneycommunity`, pin the exact version, verify method
signatures, update synthetic normalizer inputs, run deterministic tests, then perform
the controlled live matrix. Never capture a real response as a fixture. Reconstruct
only the minimum structural shape with invented identifiers and values.

The next controlled read-only matrix must call `/category-groups`, `/tags`, and
`/budgets`; verify stable IDs, category `groupId`, transaction `tagReferences`,
explicit full-month `periodStart`/`periodEnd`, empty shapes, and the documented bounds;
and record only pass/fail plus date. It must not capture identifiers or response
payloads.

For the issue #140 controlled read refresh, run the opt-in read contract against a
dedicated connected bridge. Confirm bounded search parameters are accepted by the
pinned `get_transactions` signature and normalized merchant/amount pagination is
correct, then request split detail for one transaction through
`get_transaction_splits(transaction_id)`. Record only pass/fail and the validation
date. Do not record the query values, source identifiers, merchant names, amounts,
split contents, response bodies, or upstream exception text.

## Container deployment validation

Pull-request CI builds both production containers without credentials and does not
publish them. A separate GitHub-hosted workflow publishes both production images from
trusted `main` pushes using only the run-scoped `GITHUB_TOKEN`. The image contract is:

| Runtime | Write-once commit tag | Numbered release | Immutable reference |
| --- | --- | --- | --- |
| Bridge | `ghcr.io/rsocko/tyrion-bridge:sha-<40-character-git-sha>` | `ghcr.io/rsocko/tyrion-bridge:build-N` | `ghcr.io/rsocko/tyrion-bridge@sha256:<manifest-digest>` |
| UI | `ghcr.io/rsocko/tyrion-ui:sha-<40-character-git-sha>` | `ghcr.io/rsocko/tyrion-ui:build-N` | `ghcr.io/rsocko/tyrion-ui@sha256:<manifest-digest>` |

After both digest-addressed images are published, `build-N`, `main`, and `latest` are
promoted from those same digests without rebuilding. `N` is the positive bounded
decimal `${{ github.run_number }}` assigned by GitHub Actions to this publication
workflow. It increases for each new workflow run and remains unchanged on rerun, but
successful publications can have gaps and the number is neither globally contiguous
nor guaranteed reset-proof if workflow history or file identity changes.

Canonical Compose follows `latest` by default and accepts one shared
`TYRION_IMAGE_TAG` override for both images. `latest` is convenient for moving
deployments; `build-N`, `main`, the full commit tag, and the manifest digest support
rollback or pinning. The publication summary makes the numbered tag and digest for
each image explicit. New GHCR packages are private by default; the repository owner
must make each package public once through its package settings because GitHub's
documented package API exposes no visibility update operation and the workflow
intentionally stores no PAT. See
[`DEPLOYMENT-TRUST-BOUNDARY.md`](./DEPLOYMENT-TRUST-BOUNDARY.md).

The bridge container contract is port `8100`, public `GET /health`, non-root UID/GID
`10001`, and a writable external mount at `/var/lib/tyrion` with
`SESSION_FILE=/var/lib/tyrion/monarch-session.json`. The session file and adjacent
lease must survive container replacement and must never enter an image layer, CI
artifact, log, or repository. Only one bridge process may mount and own a given
session directory at a time. The image defaults
`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`, `BRIDGE_REMOTE_TLS=true`,
`BRIDGE_LOAD_DOTENV=false`, and `DEFAULT_TRANSACTION_DAYS=90`; the homelab stack
repeats these settings and selects the image with the shared `TYRION_IMAGE_TAG`,
defaulting to `latest`. It has no host port or Traefik route. The image's default
command starts `main.py`; the stack does not override it.

The UI container contract is port `3000`, `GET /api/health`, non-root UID/GID
`10001`, a read-only root filesystem, and runtime-only `BRIDGE_URL` plus
`BRIDGE_API_TOKEN`. It uses the same `TYRION_IMAGE_TAG` as the bridge and is the only
production ingress target at `https://tyrion.socko.us`. Its `/api/bridge/...` proxy
permits only health, auth setup/status/logout, and sync limited to 90 days; the
rendered UI fixes sync to 30 days. Broad finance routes return `404`.

Mission Control server and sync workers use
`https://tyrion.socko.us/api/connector/v1` with the shared bearer credential. That
separate public TLS route reaches the UI container without the browser private-network
middleware, authenticates every request, rejects browser metadata, and forwards only
the documented connector allowlist to private `BRIDGE_URL`. The raw bridge remains
unrouted. `/api/internal/` remains excluded from all public routers and private
attribution retains its Docker-authority check.

For a controlled homelab smoke test, inject the same `BRIDGE_API_TOKEN` into both
containers and retain `BRIDGE_REMOTE_TLS=true` and
`BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us`. Confirm bridge startup fails when the
token is absent or `BRIDGE_REMOTE_TLS` is explicitly overridden to `false`, the
bridge has no ingress route, UI `/api/health` is reachable through the private UI
router, and the connector route requires valid backend bearer auth over TLS. Exercise
every allowlisted connector path against demo/invented data; confirm missing/invalid
auth, browser metadata, unknown routes/methods/query/body expansion, oversized
requests/responses, `/auth/*`, `/api/internal/*`, and broad `/api/bridge/...` finance
operations fail without a bridge call. Confirm Bridge status/body/contract headers
survive and synthetic network/invalid-response details do not. Restart must reuse the
external session. Do not run live login or mutation, capture responses, or inspect the
mounted session as part of image publishing.
