# Tyrion Domain Contract

**Contract version:** `2.0`
**Engine version:** `2.0.0`
**Services:** `POST /api/internal/v2/attribution/batch` and
`POST /api/internal/v2/attribution/actions`

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

Mission Control sends pages in bounded groups to
`POST /api/internal/v2/attribution/batch`; it must not call Tyrion once per
transaction. The route is reachable only by private backend DNS and is excluded from
the public `tyrion.socko.us` routers. It is not a Bridge endpoint and does not change
Monarch Bridge v1 transport.

The request is at most 64 KiB and contains 1-100 unique items. The only accepted
transaction facts are:

- Opaque consumer `sourceRef`
- `occurredOn` calendar date and normalized `merchantName`
- Required connector-generated opaque `accountRef`
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

The adapter deliberately copies only the normalized merchant name and calendar date
from a bridge transaction. Amount, notes, tags, category, raw transaction ID, raw
account ID, display name, mask, pending state, recurring state, logo, and pagination
cursor are validated but never copied into attribution input, policy, explanation,
or result. Tyrion's internal adapter supplies:

- `householdId`: server-authorized Tyrion household scope.
- `sourceRef`: opaque stable consumer reference derived outside this package; never
  logged by the engine.
- `accountRef`: required stable `account-v1:` opaque reference generated by Mission
  Control from connector-owned identity state. It is distinct from transaction
  `sourceRef`. Tyrion stores and compares it exactly and never receives raw Monarch
  account identifiers, masks, or reusable payment credentials.
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
- Enabled account rules keyed by opaque connector-generated account reference
- Enabled merchant rules
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
policy and its audit household scope to `homelab-household`. The v2 adapter also
upgrades a v1 policy only when its legacy `cardRules` array is empty. A non-empty
legacy array fails closed because a card fingerprint cannot be converted into an
account reference. No fingerprint sidecar or parity check is used.

## Attribution result and precedence

`attributeTransactionV1` applies this deterministic order:

1. Existing manual assignment or parent-expense decision
2. Enabled account rules
3. Enabled merchant rules
4. Historical attribution aggregate
5. Unassigned review

Manual decisions always win and are returned as `method: "manual"` with resolved
review state. Rule arrays are sorted before evaluation. Rules matching multiple kids
produce a conflict reason rather than first-item wins. Likely matches and historical
ties remain pending review.

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
