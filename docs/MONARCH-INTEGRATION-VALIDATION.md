# Monarch Integration Validation

## Bill matching contract

`POST /api/connector/v1/bill-matches` derives a bounded Bridge v1
`GET /transactions` lookup from strict normalized bill fields and scores only the
normalized transaction DTO. Deterministic automated coverage uses invented transactions
and verifies paid, pending, unmatched, ambiguous, authorization, browser rejection,
invalid caller scope, malformed response, and unavailable dependency behavior. No live
bill or transaction fixture is permitted.

For a future Bridge client-version upgrade, the controlled read-only live matrix must
also confirm that the existing transaction DTO still provides `id`, `date`, `amount`,
`merchant.name`, `account.id`, and `isPending`. Do not capture the response or add it as
a fixture. Bill matching does not add a live mutation.

## Evidence status

- Supported client: `monarchmoneycommunity==1.6.0`
- Deterministic validation: **2026-10-09**
- Controlled live validation: **2026-08-08** for browser-cookie setup, auth status,
  every supported read/sync contract, restart reuse, logout cleanup, and reversible
  category write-back
- Password live validation: **blocked by an ambiguous upstream `403`** on an account
  with MFA disabled; retained as a best-effort fallback
- Live category mutation: **completed 2026-08-08** with explicit confirmation,
  read-back verification, and restoration verification
- Controlled receipt create/upload/process/list/get/download/delete:
  **completed 2026-10-10** with invented PNG content, stable sanitized output, and
  verified cleanup; match/unmatch was not enabled
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
| Mission Control reconnect handoff | Exact source marker; no caller-supplied return; server HTTPS origin allowlist; secret-field clearing; verified auth plus bounded sync completion gate; manual fallback when return is unavailable | Use the existing controlled expiry procedure, then verify Mission Control health and projection recovery without recording payloads |
| Logout | In-memory and persisted state removal | Completed 2026-08-08; state and external session removal verified |
| Health/auth state | All four auth states and public reachability | `test_live_auth_health` |
| Transactions/filter/detail | Mission Control strict DTO parity; optional bounded business-entity display label with no upstream identifier/type leakage; 366-day window; 1-500 page; 5,000-item normalized-filter scan; bounded opaque cursor; exact account, category, merchant, tag, amount, pending, and recurring filters; duplicate/unknown-query rejection; detail; empty/error shapes; malformed upstream rejection | Existing read contract completed 2026-08-08; issue #140 filter expansion and business-entity label require controlled read-only live validation |
| Transaction splits | Normalized split identity, signed amount, merchant name, nullable category, 100-item hard limit, empty/not-found/malformed/over-limit shapes, and sanitized expiry/timeout/rate-limit/upstream failures | Controlled live validation required for issue #140 |
| Accounts/category groups/categories/transaction tags/recurring/cashflow/budgets | Normalized synthetic current-upstream structures; stable reference IDs; additive transaction tag references; explicit budget period; authoritative-empty, malformed, and dataset-bound behavior | Accounts/categories/recurring/cashflow/budgets completed 2026-08-08; category groups, transaction tags, additive category/tag identity, and explicit budget periods require the next controlled read-only validation |
| Sync | Pagination and auth-error preservation | Controlled sync completed 2026-08-08 |
| Category write-back | Rejected writes are never success-shaped | Completed 2026-08-08 with explicit confirmation, read-back, and verified restoration |
| Merchant/payee write-back | Normalized 1-120 character input, unknown-field/control-character rejection, exact mutation-response verification, deterministic demo response, connector body allowlisting, and sanitized failures | Controlled live validation required with explicit confirmation, read-back, and restoration |
| Transaction review | Pinned-client `needsReview`, `reviewStatus`, `needsReviewByUser`, household directory, `needs_review` filter, and `reviewed=True` mutation inspected; normalized status/assignee, strict mark-reviewed body, exact mutation verification, missing-capability failure, deterministic demo response, and connector allowlisting | Controlled live validation required on a dedicated needs-review transaction; do not run without accepting that the authoritative review action is not safely reversible |
| Receipts and attachment retrieval | Isolated internal probe covers uploaded/email sources; `in_progress`, `pending`, `pending_matches`, `completed`, and `failed`; list/get opaque-ID correlation; safe recent matched-PDF candidate selection; exact unmatch/rematch restoration; bounded transaction-attachment list/get/upload/download/delete; PNG/PDF generation and byte comparison; duplicate classification; failed-receipt deletion; immediate/delayed asset reuse classification; capped pagination and polling; strict malformed/oversized rejection; independent cleanup; and stable sanitized output. The probe adds no public Bridge DTO or route. | Base create/upload/process/list/get/download/delete completed 2026-10-10 with stable `receipt_probe_ok`, empty stderr, and no retained synthetic object. The expanded matrix has not run. It requires the separate receipt/attachment enable and mutation confirmation gates, exactly one safe recent manually matched uploaded PDF candidate, a bridge-owned external session, verified cleanup, and sanitized summary output. Email ingestion and pending-to-posted identity are explicitly skipped until their prerequisites exist. |
| Kids tag projection | Stable kid-to-tag mapping; collision/deletion/rename handling; reassignment, shared purchase, parent expense, retry/idempotency, partial failure, unrelated-tag preservation, optimistic drift refusal, exact read-back, action replay recovery, and re-attribution convergence use invented deterministic state only | Controlled live tag-set validation requires `TYRION_TEST_TRANSACTION_ID`, a pre-created `TYRION_TEST_TAG_ID`, and the reversible mutation confirmation; the test restores and verifies the complete original tag set. Managed-tag creation is not performed live because the pinned client exposes no verified deletion contract |
| Remote transport | Token required, TLS acknowledgement required, restricted CORS | Homelab smoke test through TLS proxy |
| Public connector gateway | Constant-time bearer validation; exact Traefik and v1 route/method/query/body allowlists; post-normalization ingress-marker check; browser rejection; 1 KiB request and 8 MiB general response bounds; composed health with one 4 KiB `/auth/status` verification, explicit v1 shape/version validation, derived status/reachability, no auth-field leakage, and sanitized non-success failures; status/body/safe-header preservation for passthrough operations; separation from UI proxy and internal APIs | TLS smoke test from a backend client using invented/demo data only |
| Production images | Separate non-root bridge/UI runtimes, route allowlist, loopback health checks, external session mount, no auth state in build contexts | Pull immutable images, mount restricted state, and smoke test private bridge plus TLS UI ingress |
| Redaction | Stable errors omit upstream/session values | Review application and proxy logs after controlled failures |

## Tyrion domain integration boundary

`kid-engine` is private Tyrion-internal code. Mission Control calls
`GET /api/internal/v2/attribution/policy` once at operation start, then calls
`POST /api/internal/v2/attribution/batch` on the private Tyrion service network and
never installs or executes the engine. Each bounded request contains only an opaque
consumer source reference, normalized merchant name, calendar date, the exact direct
normalized Bridge Account DTO `id`, optional normalized business-entity display label,
observation timestamp, fixed
provenance marker, and optional structured manual-decision context. It cannot carry
Bridge pages, raw transaction/account identifiers, masks, amounts, notes, tags,
categories, session material, or credentials.

Mission Control authenticates with the existing server-only
`BRIDGE_API_TOKEN`/finance-manager bearer credential on the private Docker network.
Tyrion derives the fixed `mission-control-finance-manager` actor and
`homelab-household` scope internally, loads the current policy snapshot server-side,
and returns only contract, engine, policy version, policy update timestamp, and the
exact supported uppercase ISO-4217 household currency from Tyrion's authoritative
policy configuration. Mission Control sends that exact positive version on every
batch in the operation, and Tyrion evaluates each whole batch under one policy-version
fence. Discovery never returns other policy contents and fails closed with
`policy_unavailable` when policy or currency configuration is missing or invalid.
Attribution failure
does not change bridge sync success: Mission Control persists the transaction with
pending attribution review and retries later. No controlled live Monarch validation
is required for attribution service changes; deterministic tests use invented
structures only.

The protected finance insight service follows the same separation. Mission
Control uploads only completed normalized projection generations; Tyrion
evaluates the promoted local projection and never calls Monarch Bridge, imports
`monarch-bridge/contract.py`, or loads reusable Monarch session material.
Finance-insight service validation is therefore deterministic and uses invented
facts plus temporary external state paths. It does not add a credentialed live
test requirement.

Mission Control reconnects by opening the Tyrion operations root with only
`source=mission-control`. Tyrion never accepts a return URL, connector credential, or
Monarch session value from that link. Cookie values remain in the bounded same-origin
auth proxy and bridge process, are cleared from visible form state when submission
starts, and are never returned. Recovery requires a live connected auth status and one
successful bounded 30-day sync. The optional return link is an exact server-configured
HTTPS URL whose origin is present in the server-configured allowlist; it carries no
recovery assertion or secret. Mission Control independently verifies connector health
and resumes its projections after return.

## Safe live procedure

1. Use a dedicated controlled account and transaction where possible.
2. Revoke historical sessions before testing and create a fresh bridge-owned session.
3. Export sensitive values only into the current process; do not use tracked `.env`
   files, shell transcripts, CI variables with broad access, or command arguments.
4. Run `test_live_integration.py` without output capture or fixture-generation tools.
5. Enable mutation only after reviewing the dedicated transaction and confirmation
   phrase. Category, merchant/payee, and transaction-tag tests must verify and restore
   the original value or complete tag set.
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
- `monarchmoneycommunity==1.6.0` replays its saved cookie dictionary and does not
  capture rotated `Set-Cookie` responses. Tyrion therefore detects expiry from an
  explicit upstream authentication rejection instead of predicting it.
- Rate limits are not published; the bridge maps observed throttling to a stable
  `upstream_rate_limited` response.
- Network timeouts and unknown upstream failures produce `degraded`; explicit
  authentication rejection produces `expired` and removes persisted state.
- Category and merchant/payee updates are non-transactional upstream. Live validation
  always reads back the change and restores the original value.
- The pinned client exposes Monarch's native transaction `needsReview`,
  `reviewStatus`, `needsReviewByUser`, and `reviewedAt` response fields, a
  `needs_review` list filter, and `update_transaction(..., reviewed=True)`. Tyrion
  exposes only the verified normalized state and assignee plus mark-reviewed; it does
  not expose `reviewedByUser`, raw household objects, an unverified reassignment
  mutation, or a fabricated cleared/reconciled state.
- Pinned-client source inspection distinguishes `ownedByUser` and
  `ownershipOverriddenAt` from detail-only `needsReviewByUser`, exposes household
  members, and permits transaction ownership updates. It implements tags as generic
  set membership and can read complete transaction rules, but supplies no
  review-assignee or rule mutation signature. None of these fields or mutations
  safely identifies the physical spender or replaces Tyrion Kids attribution.
- Reference and current-snapshot reads are complete-or-error. The bridge accepts an
  authoritative empty collection, rejects missing/non-array/invalid/oversized
  collections as sanitized `502 upstream_error`, and never publishes a truncated
  success. Deterministic limits are 1,000 accounts, 250 category groups, 2,000
  categories, 1,000 transaction tags, 5,000 recurring obligations, and 5,000 current
  budget rows.

### Receipt and attachment validation slice

The current public source of `erikrubstein/monarch-api2` was inspected at commit
`ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961` as reference code only. Tyrion does
not install or import that project. The isolated `monarch-bridge/receipt_probe.py`
adapter accepts only the client returned by the existing Bridge session manager and
does not add a production endpoint or change `contract.py`.

The deterministic probe implements these private operations:

| Purpose | Operation |
| --- | --- |
| List receipts by uploaded/email source | `Common_RetailSyncsQueryWithTotal` |
| Get and poll one opaque receipt identity | `Common_RetailSyncQuery` |
| Create an uploaded receipt shell | `Common_CreateRetailSync` |
| Start receipt processing | `Common_StartRetailSync` |
| Delete the synthetic unmatched receipt | `Common_DeleteRetailSync` |
| Optional reversible match | `Common_MatchRetailTransaction` |
| Restore the optional match | `Web_UnmatchRetailTransaction` |
| List one posted transaction and bounded attachments | `GetTransactionDrawer` |
| Get transaction attachment metadata | `Mobile_GetAttachmentDetails` |
| Request transaction attachment upload parameters | `Common_GetTransactionAttachmentUploadInfo` |
| Register an uploaded transaction attachment | `Common_AddTransactionAttachment` |
| Delete the synthetic transaction attachment | `Web_TransactionDrawerDeleteAttachment` |

Receipt file transfer uses the referenced bounded
`POST /retail-sync/{opaque-id}/files` workflow with the bridge-owned client's
authenticated transport state. Receipt and transaction attachment downloads use
`originalAssetUrl` only transiently after HTTPS Cloudinary host validation. Normalized
results expose `downloadAvailable`, never the URL. Downloads reject redirects,
unknown MIME types, invalid lengths, and bodies over 10 MiB while streaming. Upload
input is limited to 2 MiB. These values are validation safety bounds, not claims about
Monarch's product limits.

Run deterministic coverage only during normal development:

```powershell
Set-Location monarch-bridge
python -m pytest test_receipt_probe.py
```

The controlled-live runner is deliberately not a pytest test and is not collected by
CI. It requires all values in the current process:

```powershell
$env:BRIDGE_LOAD_DOTENV = "false"
$env:SESSION_FILE = "<external bridge-owned session path>"
$env:TYRION_LIVE_RECEIPT_TESTS = "1"
$env:TYRION_LIVE_RECEIPT_MUTATION_CONFIRM = "I_ACCEPT_RECEIPT_ATTACHMENT_PROBE_MUTATIONS"
python live_receipt_probe.py
```

Candidate discovery accepts no receipt or transaction ID. It examines at most two
25-item uploaded-receipt pages in a 14-day window and proceeds only when exactly one
recent matched receipt has a PDF attachment. Zero or multiple eligible candidates
fail closed with stable codes. The runner unmatches that receipt, verifies the link is
absent, rematches the exact original posted transaction, verifies exact restoration,
and independently retries restoration in `finally` whenever mutation outcome is
ambiguous. It never deletes the manual receipt.

Using only that linked posted transaction, the runner snapshots all existing
transaction-attachment metadata, uploads invented PNG content, verifies list/get and
in-memory byte fidelity, classifies immediate and two-second delayed asset reuse,
deletes the synthetic attachment, verifies absent read-back, and verifies the original
attachment snapshot is unchanged. It never creates or otherwise edits a transaction.

Receipt scenarios create readable deterministic PNG and minimal PDF files using only
the standard library, classify downloaded bytes as `identical` or `transformed`,
classify duplicate identical content as `distinct`, `coalesced`, or `rejected`, and
attempt a failed-receipt deletion with invented non-receipt text. Every synthetic
identity is held only in memory. Cleanup attempts are independent, successful deletes
require absent read-back, and any cleanup or attachment drift failure overrides an
otherwise successful result. The runner prints one JSON object containing only stable
result/classification fields. It suppresses HTTP, GraphQL, and transport request
logging before the first live call. Do not redirect output or enable the runner in CI.
Be prepared to inspect Monarch manually if
`receipt_attachment_cleanup_failed` is returned.

Email ingestion is always reported as `skipped_no_configuration`; the matrix does not
attempt it because no Monarch receipt-email setup exists. Pending-to-posted identity
is always reported as `skipped_no_pending_transaction`; the matrix never creates or
fakes a transaction.

The successful 2026-10-10 base receipt run established create, PNG upload, processing,
list/get correlation, download, and delete behavior. It returned only
`receipt_probe_ok`, emitted no stderr, and verified absent read-back after deletion.
Match/unmatch was deliberately disabled for that run. The following expanded
questions remain unknown until the controlled matrix runs:

- Whether Monarch currently accepts the deterministic minimal PDF; effective size and
  page limits remain unknown for both PNG and PDF.
- Whether `originalAssetUrl` is public, cookie-authenticated, token-authenticated,
  signed, single-use, or time-limited beyond the immediate and two-second checks;
  Tyrion does not persist or expose it.
- Whether receipt and transaction-attachment downloads preserve bytes or transform
  them.
- Email ingestion timing, sender/address requirements, threading behavior, and
  attachment selection; no email-ingestion configuration currently exists.
- Duplicate-upload detection and whether duplicate content creates one or multiple
  receipt identities.
- Whether a pending transaction's linked identity changes when it posts and how long
  receipt correlation remains stable; no pending candidate currently exists.
- Exact deletion behavior for processing, failed, matched, and unmatched receipts,
  including whether attachment assets are deleted synchronously. The base controlled
  run verified deletion and absent read-back only for its completed unmatched
  synthetic receipt.
- Whether transaction attachment retrieval uses the same URL lifetime,
  authentication, transformation, and deletion semantics as receipt attachments.

This slice now establishes observed compatibility only for the completed controlled
path above. It does not establish the remaining behaviors or authorize a production
Mission Control receipt workflow.

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

### 1.6.0 capability decisions

The 1.6.0 source and wheel were reviewed on 2026-10-09. Existing Bridge calls remain
signature-compatible, and deterministic tests pin the installed version, required
signatures, synthetic upstream shapes, normalized DTO equality, auth/session
lifecycle, pagination, sync, category mutation, and sanitized failure behavior.
The optional normalized `businessContext` transaction field is additive. It carries
only a bounded display label and omits upstream IDs, types, and raw objects. Controlled
live validation remains required before claiming that Monarch supplies it consistently.

| Addition | Decision |
| --- | --- |
| `get_all_holdings` | Defer. Investments remain in Monarch under the product boundary; the Bridge does not need a holdings DTO or concurrent fan-out. |
| `get_transaction_rules` | Defer from the Bridge contract and from Tyrion policy import/comparison. The priority-ordered Monarch criteria/action model has no safe mapping to kid attribution, ownership/review state is not spender identity, and a partial projection would be misleading. The invented-fixture analysis and reconsideration gate are documented in [`MONARCH-TRANSACTION-RULE-EVALUATION.md`](MONARCH-TRANSACTION-RULE-EVALUATION.md). |
| Transaction `businessEntity` | Adopt only its bounded display name as optional transaction `businessContext`. Never expose the raw object, identifier, or GraphQL type. The context is secondary display metadata and a low-trust Houston lookup hint. It must not drive automatic inference, canonical payee identity, recurrence, or reconciliation confidence, but a parent may explicitly confirm it as an additional discriminator in a deterministic merchant attribution rule. Malformed, blank, control-character, and oversized names normalize to `null` without failing the transaction. Deterministic fixtures prove the raw fields and identifier cannot cross the DTO boundary. |
| Household-member lookup and transaction ownership updates | Do not expose. Monarch ownership is distinct from review assignment and physical-spender attribution; exposing the mutation would add an unapproved, non-reversible write surface. |
| Typed budgets | Keep the raw client plus Tyrion's strict `normalize_budgets` boundary. The typed helper is a convenience API, not a replacement for complete-or-error bounds and stable public DTOs. |
| Proxy-aware aiohttp sessions | Adopt through 1.6.0. `trust_env=True` improves operator-controlled proxy compatibility without changing Bridge request or response contracts. aiohttp may discover proxy settings from process environment and proxy credentials from those URLs or the bridge OS account's netrc; deployments must review that ambient configuration. Tyrion does not configure, persist, or log proxy credentials. |
| Aggregate-snapshot fixes | Adopt transitively but do not expose. Tyrion does not currently call snapshot APIs, and Monarch remains the reporting system of record. |

The remaining controlled live matrix is required before claiming observed 1.6.0 live
compatibility. Run the existing opt-in procedure with process-only inputs and record
only pass/fail plus the validation date. In addition to the existing matrix, verify
password and cookie auth, saved-session restart, expiry recovery, logout, transactions,
accounts, categories, tags, recurring data, budgets, sync, reversible category
mutation, and sanitized timeout/rate-limit/upstream failures. Do not exercise deferred
holdings, rule, ownership, typed-client, or aggregate-snapshot capabilities.
Transaction rules remain outside both deterministic live-contract claims and the
controlled live matrix; no credentialed rule read is needed for the documented defer
decision.

For the issue #140 controlled read refresh, run the opt-in read contract against a
dedicated connected bridge. Confirm bounded search parameters are accepted by the
pinned `get_transactions` signature and normalized merchant/amount pagination is
correct, then request split detail for one transaction through
`get_transaction_splits(transaction_id)`. Record only pass/fail and the validation
date. Do not record the query values, source identifiers, merchant names, amounts,
split contents, response bodies, or upstream exception text.

For merchant/payee mutation validation, use the same explicit
`I_ACCEPT_REVERSIBLE_MONARCH_MUTATION` gate, one dedicated transaction, and an
invented temporary merchant name supplied only through the operator process. Verify
the mutation response, read the transaction back, restore the original merchant name
in `finally`, and verify restoration. Record only pass/fail plus date; never record
the transaction identifier, original or temporary merchant name, response body, or
upstream exception text.

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
