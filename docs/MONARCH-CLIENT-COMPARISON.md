# Monarch Client Comparison

**Status:** Source-verified engineering comparison

**Inspected:** 2026-10-10

**Decision boundary:** [PRODUCT-BOUNDARY.md](PRODUCT-BOUNDARY.md)

**Receipt boundary:** [RECEIPT-RECONCILIATION-ARCHITECTURE.md](RECEIPT-RECONCILIATION-ARCHITECTURE.md)

## Purpose and scope

This document compares the client Tyrion currently consumes with
[`erikrubstein/monarch-api2`](https://github.com/erikrubstein/monarch-api2). It is
organized by user scenario rather than by method inventory. The comparison uses
public source, package manifests, tests, and project documentation at the exact
revisions below. It does not claim that a private Monarch operation is stable,
supported, or authorized.

No live account was used for this review. No credentials, private identifiers,
financial records, raw live responses, session paths, or asset URLs were inspected or
recorded.

## Repository and package identity

The name relationship is easy to state incorrectly:

- [`hammem/monarchmoney`](https://github.com/hammem/monarchmoney) is the original
  project and historical upstream.
- Tyrion does **not** install a package released directly from that repository. It
  pins
  [`monarchmoneycommunity==1.6.0`](https://pypi.org/project/monarchmoneycommunity/1.6.0/),
  published from
  [`bradleyseanf/monarchmoneycommunity`](https://github.com/bradleyseanf/monarchmoneycommunity),
  a GitHub fork of `hammem/monarchmoney`. The installed import namespace remains
  `monarchmoney`.
- [`erikrubstein/monarch-api2`](https://github.com/erikrubstein/monarch-api2) is an
  independent implementation. Its distribution/project name is `monarch-api2` and
  its import namespace is `monarch_api`; it is not a fork, release, or successor
  package for `monarchmoneycommunity`.

Evidence for the pinned artifact is the
[`v1.6.0` setup manifest](https://github.com/bradleyseanf/monarchmoneycommunity/blob/5ae0b1e330504b5563f7674c165f05658447b5f1/setup.py),
which declares the distribution name `monarchmoneycommunity`, repository, author,
and installed packages. Consequently, the contribution target for changes Tyrion
wants in its current PyPI dependency is `bradleyseanf/monarchmoneycommunity`, not
`hammem/monarchmoney` or `erikrubstein/monarch-api2`.

## Revisions inspected

| Source | Exact revision | Role in this comparison |
| --- | --- | --- |
| `hammem/monarchmoney` | [`98a6e0d009c575188ffa28f00e6b9f8e2d41c11b`](https://github.com/hammem/monarchmoney/tree/98a6e0d009c575188ffa28f00e6b9f8e2d41c11b) | Current public historical upstream baseline |
| `bradleyseanf/monarchmoneycommunity` | [`5ae0b1e330504b5563f7674c165f05658447b5f1`](https://github.com/bradleyseanf/monarchmoneycommunity/tree/5ae0b1e330504b5563f7674c165f05658447b5f1), tag `v1.6.0` | Exact source for Tyrion's pinned package |
| `erikrubstein/monarch-api2` | [`ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961`](https://github.com/erikrubstein/monarch-api2/tree/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961) | Independent comparison implementation |

The remainder compares Tyrion's exact `monarchmoneycommunity` tag with
`monarch-api2`; the `hammem` revision is used where the fork relationship or a
fork-added capability matters.

### Primary source map

The principal files inspected at those revisions were:

- `hammem/monarchmoney`:
  [`monarchmoney/monarchmoney.py`](https://github.com/hammem/monarchmoney/blob/98a6e0d009c575188ffa28f00e6b9f8e2d41c11b/monarchmoney/monarchmoney.py),
  its setup manifest, README, tests, and synthetic fixtures.
- `bradleyseanf/monarchmoneycommunity`:
  [`monarchmoney/monarchmoney.py`](https://github.com/bradleyseanf/monarchmoneycommunity/blob/5ae0b1e330504b5563f7674c165f05658447b5f1/monarchmoney/monarchmoney.py),
  [`typedmonarchmoney`](https://github.com/bradleyseanf/monarchmoneycommunity/tree/5ae0b1e330504b5563f7674c165f05658447b5f1/typedmonarchmoney),
  setup/manifest files, README, tests, fixtures, hooks, and repository automation.
- `erikrubstein/monarch-api2`:
  [`functions/auth.py`](https://github.com/erikrubstein/monarch-api2/blob/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961/src/monarch_api/functions/auth.py),
  [`functions/common.py`](https://github.com/erikrubstein/monarch-api2/blob/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961/src/monarch_api/functions/common.py),
  [`functions/transactions.py`](https://github.com/erikrubstein/monarch-api2/blob/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961/src/monarch_api/functions/transactions.py),
  [`functions/receipts.py`](https://github.com/erikrubstein/monarch-api2/blob/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961/src/monarch_api/functions/receipts.py),
  corresponding `types` modules,
  [`pyproject.toml`](https://github.com/erikrubstein/monarch-api2/blob/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961/pyproject.toml),
  README, contributor guidance, and tests.

## Executive comparison

| Matching scenario | `monarchmoneycommunity==1.6.0` | `monarch-api2` | Practical difference |
| --- | --- | --- | --- |
| Authenticate and retain a session | Async class; password, MFA, interactive login, TOTP-secret support, browser-cookie fallback, CAPTCHA-specific error; pickle persistence | Sync functions; password and caller-supplied MFA code; JSON persistence; no cookie or CAPTCHA flow | The community fork supports Tyrion's current recovery path, but neither persistence model satisfies Tyrion's full storage policy by itself |
| Read accounts and transactions | Async methods return GraphQL dictionaries | Sync domain functions map responses into slotted dataclasses and retain a selective `raw` field | `monarch-api2` has the cleaner consumer API; Tyrion must still keep its stricter DTO boundary |
| Page transactions | `GetTransactionsList`; `offset`, `limit`, `filters`, `orderBy`; response includes `totalCount` | Same backend pagination pattern and defaults | Matching backend scenario with different normalization style |
| Read and change budgets | Core budget reads plus a typed convenience layer | Broader read/settings/month and category/group mutation surface | Breadth in `monarch-api2` is outside Tyrion's current product boundary |
| Upload a transaction attachment | Full three-step signed Cloudinary upload workflow | Same workflow, exposed in the transaction domain | Equivalent backend scenario; byte/path input and URL derivation differ |
| Retrieve or delete a transaction attachment | No public list/get/download/delete methods | Public list/get/download/delete methods | A concrete capability gap in the pinned package |
| Upload a receipt for processing | Bulk retail-sync shell, multipart upload, start processing | Single retail-sync shell, multipart upload, start, then best-effort refetch | Same native subsystem, different create mutation and eventual-state handling |
| Operate the receipt inbox | Upload only | List/get/update/delete/match/unmatch/settings, including uploaded and emailed sources | `monarch-api2` is substantially more complete |
| Retry transient failures | No automatic retry/backoff | No automatic retry/backoff | Tyrion must own bounded retries and unknown-outcome handling |
| Stream uploads/downloads | Uploads are caller-provided in-memory bytes; no attachment download API | File paths are read into memory; downloads return buffered bytes and may also write them | Neither implementation supplies Tyrion's required bounded streaming contract |

## Matching scenarios and implementation differences

### Authentication, MFA, CAPTCHA, cookies, and session state

| Concern | `monarchmoneycommunity==1.6.0` | `monarch-api2` |
| --- | --- | --- |
| API authority | Uses `https://api.monarch.com`, correcting the historical `hammem` value `https://api.monarchmoney.com` | Uses `https://api.monarch.com` |
| Main surface | Stateful `MonarchMoney` instance | `create_session(...) -> AuthSession`; session passed explicitly to domain functions |
| MFA | `multi_factor_authenticate`, interactive login, caller code, or generated TOTP from an MFA secret | Caller repeats `create_session` with `mfa_code`; no TOTP-secret generation |
| Trusted device | Requests `trusted_device=True` and rejects persistence of a token that looks like a short-lived feature JWT | `trusted_device=True` default; returns token metadata in `AuthSession` |
| Cookie auth | `login_with_cookies` requires `session_id` and `csrftoken`, adds CSRF and web-client headers | Not implemented |
| CAPTCHA | Dedicated `CaptchaRequiredException` directs callers toward cookie auth | Not implemented |
| Persistence | Pickle containing token, auth mode, and cookies | Plain JSON containing token and session metadata |
| Ownership | Mutable auth state belongs to the client object | Session is an explicit value supplied to each call |

**Observed consequence:** only the community fork covers Tyrion's current
browser-cookie recovery scenario. Both projects persist reusable credentials without
confidentiality protection, and pickle additionally must never be loaded from an
untrusted path.

**Tyrion policy:** the Bridge remains the sole session owner. It must continue to use
an external, least-privilege, atomically replaced session file, reject repository
paths, redact auth inputs and errors, and distinguish explicit expiry from transient
degradation. Browser cookies remain an operator recovery mechanism, not a public
consumer capability. Library persistence is not a replacement for those controls.

### Transport, timeouts, retries, and errors

| Concern | `monarchmoneycommunity==1.6.0` | `monarch-api2` |
| --- | --- | --- |
| GraphQL transport | `gql` 4.0 over `aiohttp`; async | Direct HTTPX calls; synchronous |
| Non-GraphQL transport | Auth and upload flows use HTTP endpoints directly; receipt files post to `/retail-sync/{id}/files`; transaction assets post to Cloudinary | Generic REST helper plus direct receipt-file, Cloudinary, and asset requests |
| Client lifetime | GraphQL transport belongs to the stateful client flow | A new `httpx.Client` context is created per REST request |
| Default timeout | Client default is 10 seconds; operations can supply/derive longer limits | 30 seconds for the generic REST helper; 60 seconds in binary transfer paths |
| Retry/backoff | None | None |
| Public errors | Library-specific login/MFA/CAPTCHA exceptions plus transport/GraphQL failures | Domain exceptions cover selected HTTP/GraphQL failures; HTTPX transport and JSON-decoding exceptions can still escape |

Neither project defines idempotent retries, jitter/backoff, mutation-outcome
reconciliation, or stable consumer error codes. A timeout after a mutation is
therefore an unknown result, not a safe failure.

**Tyrion policy:** retain stable sanitized error codes, bounded polling and
pagination, explicit timeout/rate-limit mapping, authoritative read-back, and
`degraded` versus `expired` state. Do not expose upstream exception text. Do not
blindly retry receipt creation, file upload, or any mutation after an ambiguous
transport result.

### Transaction listing and normalization

Both clients target the same transaction scenario and backend shape:

| Detail | `monarchmoneycommunity==1.6.0` | `monarch-api2` |
| --- | --- | --- |
| Operation | `GetTransactionsList` | `LIST_TRANSACTIONS_QUERY` over the same `allTransactions` shape |
| Variables | `offset`, `limit`, `filters`, `orderBy` | `offset`, `limit`, filters and ordering arguments |
| Default page size | 100 | 100 |
| Termination evidence | `totalCount` plus result length | `totalCount` plus result length |
| Result shape | Raw GraphQL dictionary using upstream field names | `Transaction` and related slotted dataclasses with normalized names |
| Raw escape hatch | Raw response is the default | Backend-backed return types may retain an explicit `raw` dictionary |

The community fork's unique `find_duplicate_transactions` walks these pages and
groups candidates heuristically by date, amount, Plaid name, and account identity.
Its own documentation warns about false positives such as connection repair and
legitimate repeated transactions. It returns candidates rather than deleting them,
but its grouping is not proof of duplication.

**Tyrion policy:** neither raw dictionaries nor a general `raw` escape hatch may
cross `monarch-bridge/contract.py`. Keep strict normalized DTOs, collection bounds,
opaque cursors, and deterministic malformed-response rejection. Duplicate detection
must remain explainable review evidence and must never trigger automatic deletion.

### Accounts, household, investments, and budgets

| Matching scenario | `monarchmoneycommunity==1.6.0` | `monarch-api2` | Tyrion consequence |
| --- | --- | --- | --- |
| Accounts | Account lists/details, balances, types, holdings, manual accounts, and related mutations on the central client | Account functions and typed account results | Keep only the bounded account-reference contract needed by Tyrion |
| Household | Household-member lookup and ownership-related transaction capability | Household, members, current user, and preference reads/updates | Ownership and household identity are not physical-spender attribution; do not import as Kids policy |
| Investments | Includes `get_all_holdings`, added after the `hammem` baseline | Portfolio, holdings, securities, performance, and manual-holding CRUD | Investments remain in Monarch under the product boundary |
| Budgets | Raw budget reads plus optional typed wrapper; the community fork documents a corrected budget query | Budget/month/settings/category/flex-rollover reads and numerous category/group amount, variability, rollover, create/reset/clear mutations | The broader mutation surface would duplicate Monarch and should not enter the Bridge |

The presence of a method does not move responsibility into Tyrion. These scenarios
are useful compatibility evidence, not a roadmap.

### Transaction attachments

Both implementations use the same three-stage scenario:

1. `Common_GetTransactionAttachmentUploadInfo(transactionId: UUID!)` obtains
   short-lived Cloudinary upload parameters.
2. The client posts multipart file bytes directly to Cloudinary.
3. `Common_AddTransactionAttachment(input:
   TransactionAddAttachmentMutationInput!)` registers the resulting asset against
   the transaction.

| Detail | `monarchmoneycommunity==1.6.0` | `monarch-api2` |
| --- | --- | --- |
| Public upload | `upload_attachment(transaction_id, file_content, filename)` | `upload_transaction_attachment(transaction_id, file_path, ...)` |
| Upload URL | Hard-coded Monarch Cloudinary upload authority | Derived from the backend-provided upload path |
| Input buffering | Caller supplies complete bytes | Function reads the complete file path into bytes |
| List | Not exposed | `list_transaction_attachments` via transaction detail |
| Detail | Not exposed | `get_transaction_attachment` using `Mobile_GetAttachmentDetails` |
| Download | Not exposed | `download_transaction_attachment`; buffers response bytes and optionally writes a path |
| Delete | Not exposed | `delete_transaction_attachment` using `Web_TransactionDrawerDeleteAttachment` |
| Mutation verification | Returns mutation result; no authoritative read-back | Attachment CRUD returns parsed results, but does not establish Tyrion-style drift detection and restoration |

The GraphQL operation names show that `monarch-api2` combines "Common", "Mobile", and
"Web" private documents to present one user-facing domain. Tyrion should not expose
those operation names in its public contract.

Asset URLs and signed upload fields are transient secrets or sensitive capabilities
until their exact lifetime and authorization behavior are proven. Neither client
provides the Bridge's required host allowlist, redirect refusal, MIME/length bounds,
streamed byte cap, or URL suppression as a public contract.

### Receipt inbox and receipt-to-transaction matching

Both projects identify Monarch's `RetailSync` subsystem, but they expose different
parts of it.

#### Upload scenario

| Stage | `monarchmoneycommunity==1.6.0` | `monarch-api2` |
| --- | --- | --- |
| Create shell | `Common_CreateBulkRetailSync`, input `{"count": 1}` | `Common_CreateRetailSync`, single-item input |
| Upload file | Multipart `POST /retail-sync/{opaque-id}/files` with an order identifier, `vendor: user_import`, `payloadType: order`, and content type | Same REST path and metadata concept |
| Start processing | `Common_StartRetailSync(syncId: ID!)` | Same operation |
| Return state | Returns the started result, commonly before processing is complete | Best-effort full refetch after start, with the started result as fallback |

`monarch-api2` explicitly documents receipt processing as eventually consistent: an
initial result may still be `in_progress`, so callers must fetch again. The community
fork has no public follow-up receipt query despite starting the asynchronous work.

#### Lifecycle scenario

| Scenario | `monarchmoneycommunity==1.6.0` | `monarch-api2` implementation |
| --- | --- | --- |
| List uploaded receipts | Not exposed | `Common_RetailSyncsQueryWithTotal` |
| Include emailed receipts | Not exposed | Maps `email_import` and `user_import` to typed receipt sources |
| Get/poll one receipt | Not exposed | `Common_RetailSyncQuery(syncId: ID!)` |
| Delete receipt | Not exposed | Receipt delete mutation |
| Match to transaction | Not exposed | `Common_MatchRetailTransaction` |
| Unmatch | Not exposed | `Web_UnmatchRetailTransaction` |
| Edit extracted order | Not exposed | `Common_UpdateRetailOrder` |
| Read/update receipt behavior | Not exposed | Retail extension/vendor settings, including categorization/split and note preferences |

When no source filter is supplied, Monarch's backend query accepts one vendor source
at a time. `monarch-api2` therefore:

1. fetches uploaded and emailed streams separately through `offset + limit`;
2. merges and sorts them by creation time and identity;
3. slices the combined list to the requested page; and
4. sums the two source totals.

This behavior is covered by
[`tests/test_receipts.py`](https://github.com/erikrubstein/monarch-api2/blob/ffa6ac493bb3a01a6d41b6c75ec7e762f5ffa961/tests/test_receipts.py).
The combined count is a client-composed total, not one server-side snapshot.
Concurrent source changes can therefore shift later pages.

Receipt normalization selects the first order and attachment as conveniences while
retaining the raw response. That is practical for exploration but is insufficient for
Tyrion: multiple orders or attachments must be represented deliberately or rejected,
never silently treated as equivalent to the first.

**Tyrion policy:** Paperless remains canonical, OWL owns durable provenance and
document-to-payment history, Monarch owns native receipt processing and native
transaction links, and Tyrion owns only a bounded adapter. The validated internal
probe may inform a future contract, but no receipt method from either client should
become a public Bridge route without versioned DTOs, idempotency/source-revision
rules, bounded streaming, live evidence, mutation read-back, and cleanup/restoration
behavior.

## Capabilities unique at the inspected revisions

This table records source-observed public surfaces, not product recommendations.
"Unique" means no equivalent public method was found in the other compared package at
the pinned revisions.

| Package | Source-observed unique capability | Notes |
| --- | --- | --- |
| `monarchmoneycommunity` | Browser-cookie login and CAPTCHA-specific fallback | Required by Tyrion's current operator recovery path |
| `monarchmoneycommunity` | Interactive login and optional TOTP-secret generation | `monarch-api2` requires a caller-supplied code |
| `monarchmoneycommunity` | Heuristic duplicate-transaction finder | Review aid only; not deletion proof |
| `monarchmoneycommunity` | Credit-history/Spinwheel read | Not represented in `monarch-api2`; outside Tyrion scope |
| `monarchmoneycommunity` | Transaction-rule reads | Deliberately omitted by `monarch-api2`; not a safe substitute for Tyrion policy |
| `monarchmoneycommunity` | Optional `typedmonarchmoney` wrapper | Layered over the raw central client |
| `monarch-api2` | Full transaction-attachment list/get/download/delete | Community package exposes upload only |
| `monarch-api2` | Full receipt list/get/update/delete/match/unmatch/settings lifecycle | Community package exposes upload only |
| `monarch-api2` | Uploaded/email receipt-source merge pagination | Recent tests specifically cover this behavior |
| `monarch-api2` | Broad budget configuration and mutation surface | Outside Tyrion's product boundary |
| `monarch-api2` | Broad household/current-user/preferences surface | Do not conflate with spender attribution |
| `monarch-api2` | Broader portfolio, security, performance, and manual-holding operations | Outside Tyrion's product boundary |

Representative exact `monarch-api2` methods behind these unique capabilities include
`list_transaction_attachments`, `get_transaction_attachment`,
`download_transaction_attachment`, `delete_transaction_attachment`,
`list_receipts`, `get_receipt`, `update_receipt`, `delete_receipt`, `match_receipt`,
`unmatch_receipt`, `get_receipt_settings`, `update_receipt_settings`,
`list_budget_months`, `get_budget_settings`, `get_budget_category`,
`get_flex_rollover_settings`, `list_investment_accounts`, `get_portfolio`,
`list_holdings`, `get_holding`, `search_securities`, `get_security`, and
`get_holding_performance`. The corresponding notable community-only entry points are
`login_with_cookies`, `find_duplicate_transactions`, `get_credit_history`,
`get_transaction_rules`, and `get_all_holdings`.

`monarch-api2` also explicitly defers rules/automation setup, risky bulk or
destructive workflows, provider-specific account-link flows, and
invitation/subscription/advisor/security/account-administration edges. These are
intentional boundaries, not necessarily missing work.

## Architecture, maintenance, dependencies, typing, and tests

| Dimension | `monarchmoneycommunity==1.6.0` | `monarch-api2` |
| --- | --- | --- |
| API architecture | One large stateful `MonarchMoney` class with method-per-operation | Domain modules with plain functions accepting `AuthSession` |
| Async model | Async | Sync |
| Response typing | Raw dictionaries by default; optional separate typed wrapper for selected domains | Slotted dataclasses from the start; selective `raw` retention |
| Packaging | Legacy setuptools; PyPI releases through 1.6.0 | Hatchling/PEP 517; project version 0.2.0; source/git installation documented |
| Python declaration | No explicit minimum in setup manifest | Python 3.11 or newer |
| Runtime dependencies | `aiohttp>=3.14.3`, `gql==4.0`, `oathtool>=2.4.0` | `httpx>=0.27` |
| Maintenance signal at inspection | Fork releases, expanded tests, hooks, Dependabot and workflows; tag published 2026-10-09 | Two-commit young project, no tags/releases, no workflow directory observed |
| Automated test evidence | Expanded original suite, typed-wrapper tests, static synthetic fixtures, and repository-process tests | One receipt-focused test module with four tests |

The `hammem` baseline has a smaller original test module and static account, holding,
budget, and transaction-summary fixtures. The community fork materially expands that
test and process surface. `monarch-api2` exposes a broad API but currently provides
automated evidence only for receipt source and pagination behavior. Documentation and
method presence alone are not compatibility proof.

## Security, privacy, and raw-response consequences

| Risk | Source fact | Tyrion requirement |
| --- | --- | --- |
| Reusable session exposure | Community pickle and `monarch-api2` JSON are not encrypted | External restricted state, atomic replacement, repository-path rejection, single owner, no values in logs or artifacts |
| Unsafe deserialization | Community persistence uses pickle | Never load an attacker-writable session file; keep path and ownership controls |
| Cookie capture | Only the community fork accepts reusable browser cookies | Same-request handling, no logging, no browser return, clear UI fields, operator-only recovery |
| Raw private fields | Community methods return raw GraphQL dictionaries; `monarch-api2` dataclasses may retain `raw` | Public DTO allowlists remain mandatory; raw fields never cross the Bridge contract |
| Direct asset capability | Receipt/attachment objects include direct asset URLs; exact expiry/auth semantics remain unknown | Validate HTTPS authority, reject redirects, never persist or expose URLs, enforce byte and MIME limits |
| Signed upload parameters | Both clients receive per-upload Cloudinary parameters | Keep in memory only; never log or expose |
| Unbounded buffering | Both implementations materialize upload/download bytes | Tyrion must stream downloads through explicit size limits and use bounded upload inputs |
| Mutation uncertainty | Neither package supplies Tyrion's general verify-and-restore discipline | Read back exact state, preserve unknown outcomes, and restore only under explicit controlled gates |

These libraries are unofficial clients of a private interface. Their MIT licenses do
not authorize service access. Tyrion's dated risk acceptance, opt-in live mode, and
non-affiliation language remain governed by
[LICENSING-AND-PROVENANCE.md](LICENSING-AND-PROVENANCE.md#monarch-terms-and-affiliation).

## Recommendations for Tyrion

### Candidates to contribute to `monarchmoneycommunity`

These are library-level capabilities that could improve the package without moving
product ownership into Tyrion:

1. Symmetric transaction-attachment list, detail, bounded download, and delete
   methods alongside the existing upload method.
2. Receipt list/detail/status and explicit eventual-consistency documentation.
3. Receipt delete, match, unmatch, and source filtering after operation shapes and
   restoration behavior receive deterministic and controlled-live coverage.
4. Typed receipt and attachment return models that do not make raw responses the
   default consumer interface.
5. Dependency-injected or shared transfer clients, explicit timeouts, and documented
   retry safety rather than per-request clients or implicit transport behavior.

The implementation should be independently written and tested from observed
operation contracts; this document is not permission to copy source.

### Policy that must remain in Tyrion

- Sole Bridge ownership of reusable Monarch session state.
- Stable public DTOs and strict normalization in `monarch-bridge/contract.py`.
- Complete-or-error collection bounds and bounded pagination/polling.
- Sanitized errors, no upstream exception text, and explicit degraded/expired states.
- Server-only service authentication, restricted CORS, and non-loopback TLS gates.
- Paperless-first artifact ownership and OWL-owned durable reconciliation history.
- Asset authority checks, redirect refusal, MIME/length validation, streaming byte
  caps, and no asset URL exposure.
- Explicit mutation confirmation, exact read-back, drift detection, and reversible
  controlled-live restoration.
- Synthetic deterministic tests and process-only opt-in live checks.

### Behavior not to import

- Raw GraphQL responses or `raw` escape hatches in consumer-facing Tyrion contracts.
- Either project's session persistence as a complete security design.
- Automatic duplicate deletion based on transaction heuristics.
- Broad budget, investment, household-administration, or account-link workflows that
  duplicate Monarch.
- Blind retries for non-idempotent operations.
- Whole-file buffering without Tyrion's explicit limits.
- Operation names, backend type names, direct asset URLs, or signed upload fields in
  public DTOs.
- A second Monarch session owner in Mission Control, scheduled jobs, MCP callers, or
  the operations UI.

## Unknowns and validation gates

The source review cannot establish:

- Cloudinary asset URL lifetime, authentication, public visibility, single-use
  behavior, or behavior beyond Tyrion's separately recorded controlled checks.
- Effective upstream file-size, page-size, rate, and retention limits.
- Whether receipt email ingestion preserves stable identity through every processing
  transition.
- Whether a pending transaction keeps the same linked identity after posting.
- Atomicity of receipt matching, transaction edits, or attachment deletion.
- Broad live compatibility of `monarch-api2`; its repository tests cover receipt
  source/pagination logic, not its full public surface.

Do not resolve these unknowns by capturing live payloads. Use the controlled,
sanitized procedures in
[MONARCH-INTEGRATION-VALIDATION.md](MONARCH-INTEGRATION-VALIDATION.md), record only
pass/fail and date, and refresh this comparison when either inspected revision or
Tyrion's pinned client changes.
