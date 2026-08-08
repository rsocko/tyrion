# Tyrion Domain Contract

**Contract version:** `1.0`
**Engine version:** `1.0.0`
**Package:** `@rsocko/tyrion-kid-engine`

## Boundary

This package is the Tyrion-owned boundary between normalized connector ingestion,
household policy, deterministic kid attribution, and Mission Control's operational
surfaces. Monarch remains the financial system of record. The package never owns or
loads Monarch credentials, cookies, sessions, raw upstream responses, or bridge
transport.

Public entry points:

| Import | Surface |
| --- | --- |
| `@rsocko/tyrion-kid-engine` | Complete supported public API |
| `@rsocko/tyrion-kid-engine/contracts/v1` | Versioned DTOs and strict input parsers |
| `@rsocko/tyrion-kid-engine/policy` | Policy service, repository port, authorization helpers, and secure file adapter |

Consumers must import these entry points rather than package internals. Removing a
field or changing its meaning requires a new major contract version.

## Normalized ingestion mapping

The ingestion consumer maps each normalized Monarch Bridge transaction to
`AttributionInputV1`:

- `householdId`: caller-authorized Tyrion household scope.
- `source.recordRef`: opaque stable consumer reference; never logged by the engine.
- `source.system`: always `monarch-bridge`.
- `transaction.merchantName`: normalized bridge merchant display text.
- `transaction.instrumentFingerprint`: nullable, irreversible,
  household-scoped fingerprint produced by the integration consumer. Tyrion policy
  never stores raw account identifiers or reusable payment credentials.
- `transaction.occurredOn`: ISO calendar date.
- `historicalAttributions`: minimum aggregate counts needed for deterministic
  historical matching.
- `existingManualDecision`: the persisted human decision, when present.

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
- Last-update timestamp

`PolicyService` receives authenticated `PolicyActorV1` context from the hosting
server. Household equality and explicit `policy:read` or `policy:write` permissions
are enforced before repository access. Replacements use compare-and-swap through
`expectedPolicyVersion`; each successful mutation writes a metadata-only
`PolicyAuditEventV1` with actor, action, prior/new version, and timestamp.

`PolicyRepository` is the production persistence port. A database-backed Tyrion
deployment must implement its `load`, atomic `save`, and `listAudit` methods using
household-scoped authorization and transactional version checks.
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
a new preview. Mission Control may initiate and present this workflow, but Tyrion
owns the policy and evaluation semantics.
