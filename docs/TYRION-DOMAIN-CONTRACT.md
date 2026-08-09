# Tyrion Domain Contract

**Contract version:** `1.0`
**Engine version:** `1.0.0`
**Service:** `POST /api/internal/v1/attribution/batch`

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
[`attribution-service-v1.openapi.json`](./attribution-service-v1.openapi.json).
Removing a field or changing its type or meaning requires a new major API version.

## Protected batch service

Mission Control sends pages in bounded groups to
`POST /api/internal/v1/attribution/batch`; it must not call Tyrion once per
transaction. The route is reachable only by private backend DNS and is excluded from
the public `tyrion.socko.us` routers. It is not a Bridge endpoint and does not change
Monarch Bridge v1 transport.

The request is at most 64 KiB and contains 1-100 unique items. The only accepted
transaction facts are:

- Opaque consumer `sourceRef`
- `occurredOn` calendar date and normalized `merchantName`
- Nullable household-scoped irreversible `instrumentFingerprint`
- `observedAt` timestamp and fixed `mission-control-normalized-v1` provenance
- Optional structured manual action, kid reference, and decision timestamp

The service rejects unknown fields. Raw Bridge pages, Monarch transaction/account
identifiers, account masks, amounts, notes, tags, categories, session material,
credentials, free-form manual explanations, and browser identity/permission claims
are not accepted.

Tyrion derives the actor, household, and sole `attribution:batch` permission from
server configuration for the authenticated service client. It loads the current
`PolicySnapshotV1` and evaluates the complete batch under one policy-version fence.
An optional `expectedPolicyVersion` detects a consumer-observed conflict. Manual
decisions are converted to the internal `AttributionInputV1` with a fixed safe
explanation and retain precedence. Each internal `AttributionResultV1` is flattened
to the strict API result containing only consumer source reference, assignment,
confidence, method, bounded explanation, review state/reasons, decision source,
policy version, engine version, and evaluation timestamp.

### Service assertion

The service signs the lowercase SHA-256 digest of the exact transmitted JSON bytes.
Required headers are:

| Header | Meaning |
| --- | --- |
| `x-tyrion-service-client` | Configured least-privilege client ID |
| `x-tyrion-service-timestamp` | Current Unix timestamp in seconds |
| `x-tyrion-service-nonce` | Unique 22-128 character base64url nonce |
| `x-tyrion-content-sha256` | Lowercase SHA-256 body digest |
| `x-tyrion-service-signature` | Lowercase HMAC-SHA256 signature |

The signed UTF-8 value is the newline-joined uppercase method, pathname, lowercase
private host, client ID, timestamp, nonce, and body digest. Assertions expire after
60 seconds. The external replay store atomically accepts each signed
client/timestamp/nonce tuple once, and the route limits a configured client to 60
requests per minute. Missing configuration returns `503`; missing or invalid
assertions return `401`; replay returns `409`; rate exhaustion returns `429`.

### Failure semantics

Stable errors use `{ "error": { "code": "...", "message": "..." } }` and include
`invalid_request` (400), `attribution_auth_required` or
`attribution_auth_invalid` (401), `attribution_forbidden` (403),
`attribution_route_not_available` (404), `attribution_replay_detected` or
`policy_conflict` (409), `payload_too_large` or `batch_too_large` (413),
`unsupported_media_type` (415), `attribution_rate_limited` (429),
`attribution_auth_not_configured`, `policy_unavailable`, or
`attribution_service_unavailable` (503), and sanitized
`attribution_operation_failed` (500).

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
- `instrumentFingerprint`: nullable, irreversible,
  household-scoped fingerprint produced before the service call. Tyrion policy
  never stores raw account identifiers or reusable payment credentials.
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
- Enabled card rules keyed by opaque instrument fingerprint
- Enabled merchant rules
- Daily, weekly, and monthly limits
- Limit-warning threshold, likely-attribution review policy, and the bounded exception
  signals eligible for Mission Control notification
- Last-update timestamp

`PolicyService` receives authenticated `PolicyActorV1` context from the hosting
server. Household equality and explicit `policy:read` or `policy:write` permissions
are enforced before repository access. Replacements use compare-and-swap through
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
access-restricted, backed up, and mounted by only one application deployment.

## Attribution result and precedence

`attributeTransactionV1` applies this deterministic order:

1. Existing manual assignment or parent-expense decision
2. Enabled payment-instrument rules
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
