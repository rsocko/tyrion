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
| `@rsocko/tyrion-kid-engine` | Complete supported version 1 API |
| `@rsocko/tyrion-kid-engine/contracts/v1` | Versioned DTOs and strict input parsers |
| `@rsocko/tyrion-kid-engine/policy` | Policy service, repository port, authorization helpers, and secure file adapter |

Consumers must import these entry points rather than package internals. Removing a
field or changing its meaning requires a new major contract version.
The pre-contract prototype modules are not exported by the published package.

## Distribution and consumption

The supported production distribution is the restricted GitHub Packages npm package
`@rsocko/tyrion-kid-engine`. A git dependency is not supported because the package
lives below the repository root. Copying generated declarations or source files into
a consumer is also unsupported.

**Release status:** version `1.0.0` is not installable from GitHub Packages until the
foundation PR is merged and the gated release tag below is pushed. Mission Control
must not add the production dependency before that package version exists. The
package consumer check builds a tarball, creates a clean temporary application with
the exact `"@rsocko/tyrion-kid-engine": "1.0.0"` declaration, installs the tarball
without changing that declaration, and imports all three public entry points. This
verifies package contents and Node resolution without pretending the registry
artifact has already been released.

After a version change is merged to `main`, an authorized maintainer creates and
pushes the exact tag `kid-engine-v<package version>`, such as
`kid-engine-v1.0.0`. `.github/workflows/publish-kid-engine.yml` verifies that the tag
matches `kid-engine/package.json`, verifies the tagged commit is contained in
`origin/main`, reruns package tests and the built-package consumer check, then
publishes with the repository-scoped `GITHUB_TOKEN`. The workflow has only
`contents: read` and `packages: write` permissions.

The package owner must grant the `rsocko/mission-control` repository Actions access
to the GitHub Package once. Mission Control then uses its own repository-scoped
`GITHUB_TOKEN` with `packages: read`; no long-lived package token is required in CI:

```yaml
permissions:
  contents: read
  packages: read

steps:
  - uses: actions/setup-node@v4
    with:
      node-version: "20"
      registry-url: https://npm.pkg.github.com
      scope: "@rsocko"
  - run: npm ci
    env:
      NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Mission Control declares the exact version without a range and commits its updated
lockfile:

```json
{
  "dependencies": {
    "@rsocko/tyrion-kid-engine": "1.0.0"
  }
}
```

Application imports use the public entry points:

```typescript
import {
  attributeTransactionV1,
  createAttributionInputsFromBridgePageV1,
} from '@rsocko/tyrion-kid-engine';
import type {
  AttributionInputV1,
  AttributionResultV1,
  PolicySnapshotV1,
} from '@rsocko/tyrion-kid-engine/contracts/v1';
```

For local development, an operator may set `NODE_AUTH_TOKEN` in the current process
to a GitHub token with `read:packages` and configure
`@rsocko:registry=https://npm.pkg.github.com`. Tokens must never be placed in a
tracked `.npmrc`, dependency URL, image layer, build argument, log, or lockfile.
Production container builds pass package authentication as an ephemeral BuildKit or
CI secret and omit it from the final image.

## Normalized ingestion mapping

The package exports
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
or result. The consumer supplies:

- `householdId`: caller-authorized Tyrion household scope.
- `sourceRef`: opaque stable consumer reference derived outside this package; never
  logged by the engine.
- `instrumentFingerprint`: nullable, irreversible,
  household-scoped fingerprint produced by the integration consumer. Tyrion policy
  never stores raw account identifiers or reusable payment credentials.
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
