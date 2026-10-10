# Tyrion Domain Contract

**Contract version:** `2.0`
**Engine version:** `2.0.0`
**Services:** `GET /api/internal/v2/attribution/policy`,
`POST /api/internal/v2/attribution/batch`, and
`POST /api/internal/v2/attribution/actions`, plus the private Quick Review support
operations under `POST /api/internal/v1/finance/quick-review/*`

## Boundary

`kid-engine` is a private module owned and executed only by Tyrion. It connects
normalized attribution facts, household policy, deterministic attribution, and the
Tyrion UI/service runtime. It never owns or loads Monarch credentials, cookies,
sessions, raw upstream responses, or bridge transport.

Mission Control is an API consumer, not a code consumer. It must not install, copy,
publish, or execute `@rsocko/tyrion-kid-engine`. The former private package artifact
is obsolete; repository workflows cannot republish it. Package deletion is a
separate maintainer operation and must not place credentials or artifact details in
repository or PR content.

The machine-readable service contract is
[`attribution-service-v2.openapi.json`](./attribution-service-v2.openapi.json).
Removing a field or changing its type or meaning requires a new major API version.

## Mission Control Quick Review support

Mission Control owns the responsive Quick Review UI, session progress, confirm,
correct, and skip interaction state. Tyrion exposes only three deterministic private
support operations on the same fixed private authority and bearer credential as
attribution:

- `POST /api/internal/v1/finance/quick-review/rank` accepts 1-100 unique opaque
  `sourceRef` values with normalized merchant/date, pending state, bounded attribution
  state, authoritative normalized Monarch review status, and an allowlisted signal
  set. It returns only references, rank, a 0-100 priority score, and reason codes. It
  does not return a transaction, amount,
  account, household identity, or upstream shape.
- `POST /api/internal/v1/finance/quick-review/research` prepares the external lookup
  envelope. The default contains only normalized `vendorName` and optional coarse
  locality/region/two-letter country. Amount and date are included only when both are
  supplied and `disclosure.shown: true` carries a valid `confirmedAt` timestamp.
  Unknown fields are rejected, so account/card details, transaction identifiers,
  household/Kids identities, history, raw responses, and session material cannot be
  smuggled into the envelope. The response requires sources for facts, explicit
  labeling of inference, and forbids fraud assertions.
- `POST /api/internal/v1/finance/quick-review/rule-suggestion` accepts normalized
  merchant name, optional normalized business-entity label, an account reference only
  for selected-account scope, an opaque Tyrion kid reference, and the user's explicit
  `suggestReusableRule` choice. It returns the current `policyVersion` plus either
  `null` or a likely-confidence merchant-rule suggestion with explicit outcome,
  global/selected-account scope, optional business-entity pattern, and
  `requiresConfirmation: true`; it never mutates policy.

All three requests require `application/json`, share the existing 64 KiB body bound,
reject unknown fields, return `Cache-Control: no-store`, and use sanitized error
envelopes. Stable operation errors are `invalid_request` (400),
`attribution_auth_required` or `attribution_auth_invalid` (401),
`attribution_route_not_available` or `quick_review_route_not_available` (404),
`batch_too_large` or `payload_too_large` (413),
`unsupported_media_type` (415), `research_disclosure_required` (422),
`attribution_auth_not_configured` (503), and
`quick_review_operation_failed` (500). These private operations never contact
Monarch, load connector sessions, perform external research, or execute a write.

Category and merchant/payee corrections write through the separately protected
Bridge connector operations. Kids corrections continue through attribution actions.
After a successful confirmed correction, Mission Control calls the verified Bridge
mark-reviewed operation; a failed correction must not mark reviewed. Confirm without
correction also uses that operation. Skip leaves Monarch unchanged. Mission Control
may keep only opaque ephemeral progress/resume state; it must not create a competing
durable reviewed flag. A confirmed rule suggestion uses
`POST /api/internal/v2/attribution/rules`, never the advisory endpoint. The strict
request carries the advisory's positive `expectedPolicyVersion`, an 8-128 character
idempotency key, a fresh explicit confirmation timestamp, and one complete merchant
rule. Tyrion derives a stable rule ID from household, service actor, and idempotency
key; sets `enabled: true`; validates the kid and 1-32 selected accounts against
server-owned state; and atomically increments the policy version. Exact retries return
`outcome: replayed` even after the policy version advances. Reusing the key for a
different rule or creating against a stale version returns `409`. A successful new
rule writes a metadata-only `merchant-rule-created` policy audit event.

Merchant rules have explicit `kid`, `parent-shared`, or `review` outcomes. They apply
globally or to a non-empty bounded account-reference set, and may include an optional
normalized business-entity pattern as an additional required discriminator.
Account-scoped matches override global matches; same-specificity disagreement remains
a `merchant-rule-conflict`. Business-entity identifiers and upstream objects never
enter policy.

Monarch's official transaction-review documentation describes native needs-review
and already-reviewed states, rule-driven review state, dashboard surfacing, and
household-member review assignment:
<https://www.monarch.com/blog/transaction-review> and
<https://www.monarch.com/blog/assign-transactions-to-a-household-member-for-review>.
The pinned `monarchmoneycommunity==1.6.0` implementation independently confirms the
read/filter/mutation fields used above. Neither that client nor the reviewed official
documentation establishes a cleared/reconciled transaction field or a native
statement-reconciliation workflow, so Tyrion does not expose one.

Review assignment complements but cannot replace Tyrion Kids attribution. In the
pinned client, transaction list/detail queries expose `ownedByUser` and
`ownershipOverriddenAt` separately from detail-only `needsReviewByUser`; the detail
query resolves the latter through `myHousehold.users`. The client can list household
members and set transaction ownership, but ownership is distinct from review
assignment and is not evidence of the physical spender. The review mutation accepts
`needs_review` and `reviewed`; it has no review-assignee parameter.
Transaction tags are independent household labels managed by
`get_transaction_tags()` and `set_transaction_tags(transaction_id, tag_ids)`.
The client can read complete transaction rules but has no rule mutation API that
establishes spender identity. Tyrion does not import or compare those rules: Monarch's
priority-ordered transaction-management criteria and actions do not map safely to a
Tyrion kid, confidence, or conflict outcome. The bounded product-fit analysis and
reconsideration gate are recorded in
[`MONARCH-TRANSACTION-RULE-EVALUATION.md`](MONARCH-TRANSACTION-RULE-EVALUATION.md).

Therefore no verified upstream field says which child made a purchase. Account
ownership identifies a Monarch household owner, review assignment identifies who
must perform workflow review, and tags/rules are generic user configuration. Tyrion
continues to derive Kids attribution from its own account/merchant policy and manual
decisions. The normalized Monarch `reviewAssignee` may help Mission Control route the
review task, but it must never be converted to a Tyrion `kidId`, treated as spending
ownership, or used as attribution evidence.

Attribution v1 is retired rather than reinterpreted. Authenticated calls to the old
batch and actions paths return `410 contract_version_retired`. Roll out Tyrion v2
while the connector remains disabled, then update Mission Control to generate
`accountRef` and call v2, verify the deterministic contract, and only then enable the
connector. No production deployment is part of this repository change.

`contractVersion: "2.0"` and the mutable policy `policyVersion` are independent.
Production currently reports policy version 2, so they happen to coincide for this
rollout; neither value is derived from the other.

## Mission Control attribution actions

Mission Control explains and resolves one synchronized attribution through
`POST /api/internal/v2/attribution/actions`. The route uses the same private authority,
server-only bearer credential, body bound, fixed service actor, and public-router
exclusion as batch attribution.

Every request carries contract/provenance versions, an opaque consumer `sourceRef`,
and `expectedPolicyVersion`. `explain` is read-only. State-changing actions additionally
require `confirm: true`, `expectedStateVersion`, and a bounded idempotency key:

- `assign-kid` assigns or corrects an active policy kid.
- `mark-parent-expense` records a manual parent decision.
- `unassign` records an explicit manual unassignment without editing Monarch.
- `resolve-exception` confirms a current suggested kid.
- `defer-exception` preserves the attribution and defers its open reasons for no more
  than 30 days.

The response contains the understandable attribution explanation, exception state,
active assignable kid references, available native actions, metadata for an
authoritative Monarch transaction deep link, Monarch/Bridge/Tyrion provenance, and
the latest metadata-only action audit. It never returns normalized transaction input,
raw Monarch data, credentials, or reusable session material. Ordinary transaction
editing remains an `open-in-monarch` workflow.

`AttributionActionRepository` is the consumer-owned state port. Its implementation
loads the synchronized input/result and atomically applies a mutation only when the
expected state version still matches. Successful writes persist the updated structured
manual decision, resolved or deferred exception state, and audit metadata. Repeated
idempotency keys with the same canonical mutation parameters replay the original
result, including after later actions. Reusing a key with different parameters returns
`idempotency_conflict`. The repository must check retained replay history before the
state version in the same atomic write transaction. Tyrion executes the write inside
the policy version fence; changed policy returns `policy_conflict`, while changed
consumer state returns `attribution_state_conflict`.

## Protected batch service

Mission Control discovers the active policy metadata through
`GET /api/internal/v2/attribution/policy` once at the start of an attribution
operation. The route uses the same private authority, bearer credential, and fixed
service actor as batch attribution. A successful response is non-cacheable and
contains exactly `contractVersion`, `engineVersion`, the positive `policyVersion`,
`policyUpdatedAt`, the required `householdCurrency`, and `subjects`. The currency is
sourced from the same Tyrion-owned policy configuration used by the operations UI
and is an exact supported uppercase ISO-4217 code. `subjects` contains all active
profiles from that same policy snapshot in configured order as
`{ "kidId": string, "name": string }`; it may be empty and is limited to 100 entries.
`kidId` uses the existing 1-128 character identifier constraint and `name` uses the
configured 1-100 character display-name constraint. Inactive profiles, rules,
account defaults, merchant rules, household identity, and other policy contents are
not exposed. Missing or invalid policy state, invalid currency, or more than 100
active profiles returns `policy_unavailable` rather than a partial/default response.
Mission Control sends the discovered version as `expectedPolicyVersion` on every
batch in that operation; a later policy change therefore fails the operation's next
batch with `policy_conflict`.

Mission Control sends pages in bounded groups to
`POST /api/internal/v2/attribution/batch`; it must not call Tyrion once per
transaction. The route is reachable only by private backend DNS and is excluded from
the public `tyrion.socko.us` routers. It is not a Bridge endpoint and does not change
Monarch Bridge v1 transport.

The request is at most 64 KiB and contains 1-100 unique items. The only accepted
transaction facts are:

- Opaque consumer `sourceRef`
- `occurredOn` calendar date and normalized `merchantName`
- Required direct Bridge `accountRef`, equal to the normalized Account DTO `id`
- `observedAt` timestamp and fixed `mission-control-normalized-v2` provenance
- Optional structured manual action, kid reference, and decision timestamp

The service rejects unknown fields. Raw Bridge pages, Monarch transaction/account
identifiers, account masks, amounts, notes, tags, categories, session material,
credentials, free-form manual explanations, and browser identity/permission claims
are not accepted.

Tyrion derives the fixed Mission Control service actor, homelab household, and sole
`attribution:batch` permission from implementation constants after authenticating the
private caller. It loads the current
the current policy snapshot and evaluates the complete batch under one policy-version fence.
An optional `expectedPolicyVersion` detects a consumer-observed conflict. Manual
decisions are converted to the internal `AttributionInputV1` with a fixed safe
explanation and retain precedence. Each internal `AttributionResultV1` is flattened
to the strict API result containing only consumer source reference, assignment,
confidence, method, bounded explanation, review state/reasons, decision source,
policy version, engine version, and evaluation timestamp.

### Private service authentication

Mission Control calls `http://tyrion-operations-ui:3000` over the private Docker
backend network and sends `Authorization: Bearer <BRIDGE_API_TOKEN>`. Tyrion requires
the same minimum-32-character server-only token already used by the protected bridge
contract. No client ID, actor, household, timestamp, nonce, body digest, signature, or
replay-store configuration is part of this contract.

The endpoint accepts only the exact private service authority. If
`x-forwarded-host` is present, it must identify that same private authority. This
provides application-level defense in depth behind the Compose rule that excludes
`/api/internal/` from all public Traefik routers. Missing server token configuration
returns `503`; missing or invalid credentials return `401`; a non-private authority
returns `404`.

### Failure semantics

Stable errors use `{ "error": { "code": "...", "message": "..." } }` and include
`invalid_request` (400), `attribution_auth_required` or
`attribution_auth_invalid` (401), `attribution_forbidden` (403),
`attribution_route_not_available` (404), `policy_conflict` (409),
`payload_too_large` or `batch_too_large` (413), `unsupported_media_type` (415),
`attribution_auth_not_configured`, `policy_unavailable`, or
`attribution_service_unavailable` (503), and sanitized
`attribution_operation_failed` (500).

The actions route additionally returns `attribution_not_found` (404),
`attribution_state_conflict` or `action_not_available` (409),
`kid_not_assignable` or `invalid_defer_window` (422), and
`attribution_state_unavailable` or `attribution_state_invalid` (503).

Mission Control treats every non-200 response as an attribution-only failure. It
persists transaction generation with pending review and retries attribution later;
it never tombstones the synchronized transaction because attribution was unavailable.

## Normalized ingestion mapping

The Tyrion-internal module exports
`createAttributionInputFromBridgeTransactionV1(transaction, context)` and
`createAttributionInputsFromBridgePageV1(page, householdId, recordContexts)`.
They strictly validate the Monarch Bridge v1 transaction/page DTO before mapping it
to `AttributionInputV1`. The page adapter uses bridge `provenance.fetchedAt` as the
observation timestamp and requires exactly one consumer mapping context per
transaction. Additive Bridge v1 fields are accepted and ignored, as required by the
bridge contract; all required fields and consumed values remain validated.

The adapter deliberately copies only the normalized merchant name, optional normalized
business-entity display label, and calendar date from a bridge transaction. Amount,
notes, tags, category, raw transaction ID, raw
account ID, display name, mask, pending state, recurring state, logo, and pagination
cursor are validated but never copied into attribution input, policy, explanation,
or result. Business-entity identifiers, types, and raw objects are also excluded.
Tyrion's internal adapter supplies:

- `householdId`: server-authorized Tyrion household scope.
- `sourceRef`: opaque stable consumer reference derived outside this package; never
  logged by the engine.
- `accountRef`: the exact case-sensitive `id` from Tyrion's normalized Bridge Account
  DTO. It is a trimmed 1-128 character identifier matching
  `[A-Za-z0-9][A-Za-z0-9._:-]*`. Mission Control passes this value verbatim and must
  not hash, namespace, or derive it from its identity state. It remains distinct from
  transaction `sourceRef` and must not be logged unnecessarily.
- `historicalAttributions`: empty for the v1 service request.
- `existingManualDecision`: safe structured manual context, when present.

Runtime parsers reject unknown fields, invalid versions, unsupported identifiers,
oversized collections, inconsistent manual decisions, dangling kid references,
duplicate rule IDs or limit periods, and currency mismatches.

## Policy snapshot

`PolicySnapshotV1` contains only Tyrion-owned data:

- Contract, engine, household, and monotonically increasing policy versions
- IANA timezone and ISO currency
- Kid profiles
- One optional direct account default per Bridge account: `child`, `parent-shared`,
  or `rule-based`
- Enabled merchant rules with explicit global or selected-account scope, optional
  business-entity pattern, and kid, parent/shared, or review outcome
- Daily, weekly, and monthly limits
- Limit-warning threshold, likely-attribution review policy, and the bounded exception
  signals eligible for Mission Control notification
- Last-update timestamp

`PolicyService` receives the hosting server's fixed local-operator `PolicyActorV1`
context. Household equality and explicit `policy:read` or `policy:write` permissions
remain enforced before repository access. Replacements use compare-and-swap through
`expectedPolicyVersion`; each successful mutation writes a metadata-only
`PolicyAuditEventV1` with actor, action, prior/new version, and timestamp.

`PolicyRepository` is the production persistence port. A database-backed Tyrion
deployment must implement its `load`, atomic `save`, and `listAudit` methods using
household-scoped authorization and transactional version checks.
`withPolicyVersionFence` must hold the same mutation fence while a bounded
re-attribution apply runs, so a policy replacement cannot commit between the final
version comparison and application.
`FilePolicyRepository` is the smallest durable single-deployment adapter. It:

- Requires an absolute state path outside the application checkout
- Uses an ownership-tracked, heartbeat-backed exclusive mutation lease and atomic
  replacement
- Applies restrictive directory/file modes where supported
- Bounds the persisted store size
- Strictly validates reloaded snapshots
- Returns stable sanitized errors without paths or persisted content

The file adapter stores policy and audit data only. Its state path must be external,
access-restricted, backed up, and mounted by only one application deployment. When
the fixed homelab identity first opens a store containing exactly one policy under
the superseded configurable household ID, the adapter atomically rewrites that
policy and its audit household scope to `homelab-household`. The adapter deletes obsolete v1 `cardRules` and v2 `accountRules` during migration
because neither legacy reference can be safely converted to a direct Bridge account
ID. Every migrated policy starts with an empty `accountDefaults` array; operators
configure only the small set of defaults they still need from the current catalog.
No fingerprint sidecar or parity check is used.

## Attribution result and precedence

`attributeTransactionV1` applies this deterministic order:

1. Existing manual assignment or parent-expense decision
2. Matching account-scoped merchant rules, including conflict handling
3. Matching global merchant rules, including conflict handling
4. Account default (`child`, `parent-shared`, or no decision for `rule-based`)
5. Historical attribution aggregate
6. Unassigned review

Manual decisions always win and are returned as `method: "manual"` with resolved
review state. Specific merchant rules override every account default. A child default
returns a definite `account-default` attribution. A parent/shared default returns
`status: "unassigned"`, `confidence: "definite"`, `method: "account-default"`, and
`review.status: "not-required"`; it never produces `no-match`. Rule-based accounts
continue to history and then `no-match`. Rules matching multiple kids produce a
conflict reason rather than first-item wins. The same applies when equally specific
rules disagree between kid, parent/shared, and review outcomes. Likely matches and
historical ties remain pending review.

Every `AttributionResultV1` includes:

- Assignment status, kid, confidence, method, and a bounded human-readable
  explanation
- Review status and stable reason codes
- Policy version, engine version, decision source, matched rule IDs, and evaluation
  timestamp

If policy or engine evaluation is unavailable,
`createUnavailableAttributionResultV1` returns `status: "pending"` and
`method: "unavailable"`. Transaction ingestion remains successful and can retry
attribution later. A supplied manual decision is still preserved.

## Controlled re-attribution

Rule or policy changes use a two-step server flow:

1. Parse `ReattributionPreviewRequestV1`, require
   `reattribution:preview`, verify the expected policy version, evaluate the explicit
   bounded source selection, persist a short-lived preview, and return dispositions:
   `unchanged`, `would-update`, `manual-preserved`, or `pending-review`.
2. Parse `ReattributionApplyRequestV1`, require `confirm: true` and
   `reattribution:apply`, reload the policy and persisted preview, and reject changed,
   missing, mismatched, or expired state before applying.

`ReattributionRepository.applyPreviewIfPolicyVersion` is the consumer's
transaction-store port. Its implementation must atomically compare the active policy
version, apply the persisted preview, remain idempotent, and recheck that no newer
manual decision is overwritten. A false version comparison returns `null` and forces
a new preview. `ReattributionService` also executes this call inside the
`PolicyRepository` version fence, making policy replacement and apply mutually
exclusive. Mission Control may initiate and present this workflow, but Tyrion owns
the policy and evaluation semantics.
