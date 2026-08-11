# Finance Insights Cross-Repository Delivery Plan

**Status:** Proposed execution plan for issues #22, #23, and #24

**Design source:** [`FINANCE-INSIGHTS-UX.md`](./FINANCE-INSIGHTS-UX.md)

**Authoritative boundary:** [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md)

**Repositories:** `rsocko/tyrion`, `rsocko/mission-control`, and final rollout
configuration in `rsocko/homelab-config`

This document turns the approved UX direction into reviewable implementation slices.
It is a planning artifact, not an authorization to deploy, contact Monarch, or process
live household data. All examples and proposed test records are invented.

## 1. Fixed product decisions

The implementation must preserve these decisions throughout the stack:

- Tyrion owns detector rules, baselines, explanations, confidence, baseline
  sufficiency, source occurrence lifecycle, suppression policy, and detector
  persistence.
- Mission Control owns rendering, local read/dismiss/snooze disposition,
  notification delivery and grouping, responsive filtering, and safe external
  navigation.
- Monarch remains the financial system of record and owns full transaction,
  recurring-item, category, and reporting workflows.
- `monarch-bridge/` remains the sole owner of reusable Monarch session material.
  Every evaluator uses its protected normalized contract; no worker, Mission Control
  process, or new Tyrion module may import the community client or load a session.
- Bridge DTOs remain the public Monarch boundary. This plan requires no Bridge v1 DTO
  expansion and never exposes an upstream response shape.
- OWL evidence is optional and normalized. A missing document cannot make an
  otherwise valid Monarch evaluation fail. Original documents stay in OWL.
- `triage-app/` may host the protected Tyrion service runtime and operational status,
  but it remains a bounded operations/configuration and contract-validation UI. It
  does not gain daily insight cards, a ledger, reports, or a second finance product.
- `/finance` is the durable Mission Control home. Large transactions are
  notification-first; recurring changes and monthly movers persist on `/finance`;
  material monthly movers also form one grouped digest.
- `/finance/review` remains attribution-only. Insight disposition must not reuse
  attribution resolution.
- Finance insights remain `notificationOnly`. No insight creates a Mission Control
  task or My Day work item.
- Every comprehensive workflow leaves Mission Control through a typed, allowlisted
  Monarch target. Tyrion never returns a URL.

## 2. Target architecture and data flow

```text
Mission Control scheduled connector sync
  -> protected Monarch Bridge v1 operations
  -> transaction and reference dataset generations complete
  -> atomic Mission Control publication generation captures exact constituents
  -> protected, staged Tyrion source-generation upload
       -> strict Bridge-derived fact batches and complete manifest
       -> atomic Tyrion generation promotion
       -> optional normalized OWL evidence port
       -> deterministic Tyrion evaluation
       -> occurrence/lifecycle repository
  -> Mission Control polls the protected Tyrion insight contract
  -> local upsert by occurrence identity and delivery revision
  -> /finance, notifications, and typed external target builders
```

Bridge v1 does not expose a generation-pinned multi-page snapshot. Tyrion therefore
must not refetch live Bridge pages and claim that they match the completed Mission
Control generation. Mission Control currently synchronizes transaction windows and
reference datasets independently and may finish partially. It must first create a
`FinanceInsightPublicationGenerationV1` that atomically captures the exact successful
transaction-window, account, category, tag, and recurring generation IDs used for one
publication. It refuses gaps, overlaps, partial/failed constituents, unacceptable
freshness skew, or a constituent that changes before the capture commits.

Mission Control reads upload facts only from those captured immutable generations and
uploads strict Bridge-derived source facts and a complete manifest to Tyrion's private
staging contract. Tyrion validates and promotes that immutable publication before
evaluating it. `sourceAsOf` is the conservative minimum reliable source timestamp
across the captured constituents, not the latest successful endpoint timestamp.

This transport does not make Mission Control a detector owner. Mission Control
publishes only the normalized source generation it already synchronizes; it does not
calculate baselines, exclusions, confidence, explanations, or lifecycle. The upload
contains no raw upstream response, notes, account masks, reusable session material, or
arbitrary document content.

The first release supports exactly one configured Monarch connector. Both services
must represent that as an explicit validated selection, not as a fake connector or an
implicit global. Zero or multiple matching connectors produces a stable unavailable
state and no new alert.

## 3. Tyrion Finance Insight contract v1

### 3.1 Service boundary and endpoints

Add a private, versioned Tyrion domain contract under
`/api/internal/v1/finance/insights`. It is not a Bridge route, connector-gateway
operation, or browser route.

| Method and route | Purpose |
| --- | --- |
| `POST /source-generations` | Idempotently begin staging one completed normalized connector generation and its expected manifest. |
| `PUT /source-generations/{generationId}/batches/{batchIndex}` | Idempotently upload one bounded, typed source-fact batch. |
| `POST /source-generations/{generationId}/commit` | Validate the complete manifest, atomically promote the generation, and enqueue its initial evaluation. |
| `POST /evaluations` | Idempotently retry an unavailable/failed evaluation under the source generation's originally assigned detector and policy versions. |
| `GET /occurrences` | Read a bounded, snapshot-paginated summary list. |
| `GET /occurrences/{occurrenceId}` | Read one bounded explanation and evidence view. |
| `POST /occurrences/{occurrenceId}/actions` | Apply a confirmed, structured Tyrion action such as expected, not useful, suppress, or undo suppression. |

The implementation should publish an executable
`docs/finance-insights-service-v1.openapi.json` and strict runtime parsers. JSON uses
`camelCase`, rejects unknown fields, returns collections as arrays, and represents
unavailable values as explicit `null` or states rather than falsey substitutes.
Removing or reinterpreting a field requires a new major contract version.

The service uses the same private-authority and minimum-length server-token posture as
the attribution service. It is excluded from every public router. The browser never
calls it.

### 3.2 Source generation, evaluation, and idempotency

`SourceGenerationCreateRequestV1` contains:

- `contractVersion: "1.0"`
- `connectorRef`: the actual configured Mission Control connector reference,
  normalized and bounded to 160 characters
- `sourceGeneration`: an opaque, stable completed-sync generation, bounded to 160
  characters
- `sourceSequence`: a positive, connector-scoped sequence assigned transactionally by
  Mission Control when the composite publication generation commits
- `sourceAsOf`: the connector's UTC source timestamp
- `coverageStart` and `coverageEnd`: inclusive calendar dates
- the single configured household currency and Bridge contract version
- the bounded captured constituent generation references and freshness timestamps
- a manifest of expected typed batch counts, item counts, and canonical digests
- `idempotencyKey`: 16-160 normalized characters, stable for the exact source
  generation and manifest

Each `SourceFactBatchV1` has one kind (`transaction`, `recurring`, `category`,
`account`, or `tag`), a zero-based index, 1-250 strict normalized facts, a canonical
digest, and its own idempotency key. Transaction facts include only the Bridge-derived
fields required by detection: opaque source reference, date, amount in minor units,
normalized merchant name, nullable category/account references, pending/recurring
state, and bounded stable tag references. Recurring/reference facts remain strict
projections of Bridge DTOs. Unknown fields, duplicate source references, gaps,
overlaps, changed retries, and manifest mismatches fail closed.

Each request is at most 256 KiB. One generation is bounded to 50,000 transactions,
5,000 recurring items, 2,000 categories, 1,000 accounts, and 1,000 tags. These are
safety limits, not truncation rules: an over-limit generation fails before promotion
and must be narrowed or explicitly versioned.

`commit` succeeds only when every manifest batch validates and the canonical digests
match. It atomically promotes the staging generation and enqueues one initial
evaluation under the then-effective detector and policy versions. Partial staging
data expires and is never detector input.

Promotion uses compare-and-swap on the connector's current `sourceSequence`. A higher
sequence becomes authoritative. A delayed lower sequence may be retained as historical
ingestion evidence but cannot become current, enqueue publishable evaluation, mutate
an occurrence, or create delivery. Reusing a sequence for different content is a
conflict.

`EvaluationRequestV1` is reserved for retrying an unavailable/failed evaluation and
contains the promoted `sourceGeneration`, its originally assigned
`detectorSetVersion` and `expectedPolicyVersion`, and an `idempotencyKey` stable for
that complete tuple. Tyrion rejects a later policy/detector version for an existing
generation. It creates one evaluation key:

```text
(household scope, connectorRef, sourceGeneration, detector set version, policy version)
```

Source upload and evaluation idempotency are separate namespaces. A retry returns the
existing source generation or evaluation and cannot create another occurrence,
notification candidate, or policy action. Reusing either idempotency key with
different normalized input returns `409 idempotency_conflict`. A policy or detector
change applies only to source generations accepted after that version becomes
effective; it does not conflict with, overwrite, or relabel any prior evaluation.

Tyrion assigns a monotonic connector-scoped `evaluationSequence` when it accepts an
initial evaluation or explicit reevaluation of the current source generation. The
accepted tuple becomes the publication fence. Evaluation completion uses
compare-and-swap against that fence and the current source sequence. A delayed older
source, policy, or detector evaluation remains immutable history but cannot regress
current lifecycle, delivery revision, explanation, or notification eligibility.

### 3.3 Identity model

Identity has three levels:

1. `insightId` is a stable series identity for a detector kind and canonical Tyrion
   entity. It is generated server-side from a versioned, keyed digest of household
   scope, detector kind, entity kind, and opaque source reference. It is not a raw
   Monarch identifier.
2. `occurrenceId` is a stable episode identity within that series. Its discriminator
   is detector-specific: recurring obligation plus billing period and source-revision
   lineage, transaction source reference plus source-revision lineage, or
   category/merchant plus comparison period, direction, and relevant classification
   lineage.
3. `deliveryRevision` is a monotonically increasing integer. It changes only when an
   allowlisted source value crosses a configured materiality boundary or source
   classification changes. Ordinary reevaluation timestamps, severity-only changes,
   contributor ordering, and lifecycle display changes do not change it.

The opaque IDs use a version prefix and a server-held key stored outside the
repository. The versioned key is access-restricted, backed up with the Tyrion state
store, and restored before evaluation; losing or silently rotating it is a blocking
identity fault. Logs and metrics never contain the IDs or their source inputs.

`sourceRevisionRef` is a versioned keyed digest of the canonical material source fact
and its predecessor lineage. An unchanged replay derives the same value; a classified
source correction derives one deterministic successor. The correction successor is
part of `occurrenceId`, so it can supersede the old occurrence without collision.
Ordinary non-correction evidence accumulation does not change `sourceRevisionRef` and
may use `deliveryRevision` only when source value/classification crosses the approved
materiality rule.

Mission Control uses one stable notification row per occurrence:

```text
sourceId = finance-insight:{connectorRef}:{occurrenceId}
sourceActivityKey/occurrenceKey = {occurrenceId}:{deliveryRevision}
```

The notification service updates/reopens that row according to the explicit source
activity policy, so an earlier revision cannot remain as a second active notification.
A monthly digest similarly uses:

```text
sourceId = finance-insight-digest:{connectorRef}:{periodStart}
sourceActivityKey/occurrenceKey = {periodStart}:{digestRevision}
```

The digest revision changes only when the bounded member occurrence/revision set
changes materially. This eliminates random identity while allowing a corrected or
materially changed occurrence to resurface predictably.

A dismissed insight may resurface only for a new occurrence or a delivery revision
caused by materially changed source value/classification. Source corrections never
silently rewrite the old occurrence: they resolve it when corrected evidence no longer
qualifies or supersede it with a deterministic correction-lineage occurrence when the
corrected evidence still qualifies.

### 3.4 Summary and detail DTOs

`InsightOccurrenceSummaryV1` contains:

- `insightId`, `occurrenceId`, `deliveryRevision`, `kind`, and `entity`
- `analysisState`: `analyzing`, `qualified`, `insufficientBaseline`, or `unavailable`
- nullable `sourceLifecycle`: `open`, `resolved`, or `superseded`
- nullable `resolutionReason` and `supersededByOccurrenceId`
- `severity`: `info`, `medium`, or `high`
- `confidence`: `low`, `medium`, or `high`
- `baselineSufficiency`: `insufficient`, `limited`, or `sufficient`
- bounded `reasonCodes` and a concise normalized `headline` and `explanation`
- observation/baseline periods, observed value, expected range, absolute delta,
  nullable percentage delta, and currency
- source freshness, provenance, detector and policy versions
- zero to four typed external targets
- `createdAt`, `updatedAt`, and nullable `resolvedAt`

`entity` is a discriminated union with kind `recurring`, `transaction`, `category`,
or `merchant`, an opaque `sourceRef`, a normalized display name of at most 120
characters, and `identityQuality: stableSource | configuredAlias | normalizedName`.
Transactions, recurring items, and categories use stable Bridge references. Bridge v1
has no stable merchant ID, so Tyrion uses a versioned normalized-name key unless a
Tyrion-owned alias mapping supplies a stable canonical merchant. A merchant rename
without an alias starts a new series and resolves/supersedes the old one; confidence
must reflect normalized-name identity.

Money uses `{ "currency": "USD", "amountMinor": 184000 }`. Percentage changes use
integer basis points and are `null` when a zero or unavailable baseline makes the
ratio meaningless. Bridge v1 assumes one account currency and exposes no
per-transaction currency. V1 therefore requires one exact household currency on the
complete source generation and rejects a generation that conflicts with Tyrion
policy; it does not claim to detect transaction-level currency mismatch or convert
currency.

`InsightOccurrenceDetailV1` adds:

- the exact detector rule results and whether each triggered, reinforced, or was
  informational
- baseline method, window, sample count, active-period count, robust center and
  dispersion, expected range, and exclusion counts
- at most 36 comparison rows
- at most 10 ranked contributors with opaque source references
- at most 12 stable reason codes and 12 exclusions
- at most eight normalized evidence records
- structured lifecycle history, suppression status, and available Tyrion actions

Explanations are generated from stable reason codes and bounded normalized facts.
They do not contain account numbers, free-form transaction notes, document text, raw
provider errors, or raw response fragments.

### 3.5 Baseline sufficiency and confidence

These fields are deliberately independent:

- **Baseline sufficiency** describes only whether the requested comparison has enough
  representative samples and coverage. `insufficient` blocks an adaptive alert;
  `limited` permits a labeled result only where the detector policy allows it; and
  `sufficient` meets the detector's versioned coverage rule.
- **Confidence** is a deterministic qualitative conclusion from source completeness,
  identity quality, baseline sufficiency, agreement among eligible comparisons, and
  exclusion ambiguity. It is not a probability and must include stable reason codes.

An explicit household amount rule may qualify a large transaction without an adaptive
baseline. That result still reports `baselineSufficiency: insufficient` and cannot
claim an adaptive anomaly. A recurring seasonal comparison with insufficient seasonal
history remains a non-alert analysis even if rolling context is available.

### 3.6 Provenance and freshness

Every occurrence includes:

- actual `connectorRef` and `sourceGeneration`
- Bridge contract version and normalized provider class
- `sourceAsOf`, coverage start/end, and completeness
- detector, method, explanation-template, and policy versions
- evaluation start/completion timestamps
- optional evidence source, normalized evidence type, observed timestamp, and opaque
  document reference
- freshness state: `fresh`, `stale`, `partial`, or `unavailable`

Freshness thresholds are versioned Tyrion policy. A stale, partial, or unavailable
generation cannot open a new occurrence or increment a delivery revision. The last
reliable result may remain visible with its original `sourceAsOf` and an explicit
warning. V1 permits new alerts only when `sourceAsOf` is no more than 48 hours old.
Recovery reevaluates before clearing the warning.

### 3.7 Typed external target descriptors

Tyrion returns only these closed unions:

```text
MonarchTransactionTargetV1  = monarch + transaction + opaque sourceRef
MonarchRecurringTargetV1    = monarch + recurring + opaque sourceRef
MonarchReportFilterTargetV1 = monarch + reportFilter + report kind +
                              bounded period + optional category sourceRef or
                              normalized merchant key
MonarchSafeRootTargetV1     = monarch + safeRoot + transactions/recurring/reports
OwlDocumentTargetV1         = owl + document + opaque sourceRef
```

No descriptor contains a scheme, host, port, path, URL, arbitrary query name/value,
or display-provided navigation target. Mission Control maps each supported union
through a connector-specific allowlist, encodes every component, and owns the trusted
origin. It uses verified entity-specific transaction, recurring, or report formats
when available. A valid typed target whose entity-specific format is unsupported falls
back to the corresponding allowlisted Transactions, Recurring, or Reports root. An
unknown connector, invalid target kind, or malformed reference omits the action and
emits a metadata-only diagnostic; it never falls back to a supplied string.

### 3.8 Pagination and filtering

`GET /occurrences` defaults to open, qualified occurrences sorted by
`updatedAt DESC, occurrenceId ASC`.

Allowed filters are:

- repeated `kind`, at most four unique enum values
- repeated `sourceLifecycle`, at most three unique values
- repeated `analysisState`, at most four unique values
- repeated `severity` and `baselineSufficiency`, at most three each
- one `connectorRef`
- one UTC `updatedAfter`
- `limit` from 1-100, default 50
- one opaque cursor of at most 512 characters

Unknown, duplicated singleton, empty, malformed, or over-limit parameters fail before
repository access. The cursor binds a read snapshot, normalized filter digest, and
last sort key. It must be passed unchanged with the same filters. New evaluations do
not enter an in-progress traversal. `nextCursor: null` ends the traversal, and cursors
expire after a bounded interval.

### 3.9 Source and delivery lifecycle

Tyrion and Mission Control maintain separate state:

```text
Tyrion analysis: analyzing -> qualified | insufficientBaseline | unavailable
Tyrion source:   open -> resolved | superseded
Mission Control: unread -> read | snoozed | dismissed
```

- A no-longer-qualifying open occurrence resolves with a structured reason.
- A correction resolves the old occurrence or supersedes it with a deterministic
  correction-lineage occurrence and names the replacement.
- Dismiss and snooze never call a Tyrion lifecycle mutation.
- `expected` is a confirmed Tyrion action that records a structured reason and may
  resolve the current occurrence.
- `notUseful` records bounded feedback and does not mutate thresholds.
- `suppress` requires `confirm: true`, an allowlisted occurrence/entity/category
  scope, a duration of exactly 30, 90, or 180 days, expected policy version, and an
  idempotency key. It records the fixed single operator, reason, scope, creation,
  expiry, and undo state.
- The current product is single-user and has no account/permission model. The fixed
  operator may use every structured feedback and timed suppression action; v1 must not
  invent elevated permissions. Permanent suppression is prohibited, and every active
  suppression has an undo action.

The action endpoint rejects stale occurrence revisions and policy versions with `409`.
It never accepts free-form financial notes.

### 3.10 Stable sanitized errors

Errors use:

```json
{
  "contractVersion": "1.0",
  "error": {
    "code": "insight_source_unavailable",
    "message": "Finance insight source data is unavailable"
  }
}
```

Required codes include:

| Status | Codes |
| --- | --- |
| 400/422 | `invalid_request`, `invalid_filter`, `invalid_cursor`, `invalid_date_range`, `unsupported_target`, `unsupported_action` |
| 401/403/404 | `insight_auth_required`, `insight_auth_invalid`, `insight_forbidden`, `insight_route_not_available`, `occurrence_not_found` |
| 409 | `idempotency_conflict`, `source_generation_conflict`, `source_batch_conflict`, `source_currency_conflict`, `stale_source_generation`, `stale_evaluation`, `occurrence_revision_conflict`, `policy_conflict` |
| 413/415 | `payload_too_large`, `page_too_large`, `source_generation_too_large`, `unsupported_media_type` |
| 429 | `evaluation_in_progress` with bounded `Retry-After` |
| 503 | `insight_service_not_configured`, `insight_source_unavailable`, `insight_store_unavailable` |
| 500 | `insight_operation_failed` |

No error response or log includes upstream exception text, credentials, session
paths, source identifiers, connector identifiers, merchant names, amounts, document
content, private hosts, or request/response bodies.

## 4. Tyrion persistence and evaluation runtime

Create a Tyrion-private `finance-insights/` TypeScript module rather than expanding
the attribution-specific `kid-engine`. It contains strict contracts, detector ports,
deterministic algorithms, explanation templates, and repository interfaces. It never
loads Monarch sessions.

Use a transactional SQLite store at an absolute, access-restricted path outside the
repository and image. Schema migrations create:

- promoted source generations and staging status
- normalized transaction, recurring, and reference projections
- recurring-obligation identity associations
- optional normalized document evidence references
- detector evaluations and exclusion summaries
- insight series, immutable occurrence history, and delivery revisions
- structured feedback, suppressions, and policy audit metadata

The store must support atomic generation promotion, unique evaluation keys,
compare-and-swap lifecycle transitions, snapshot list reads, and restart-safe
idempotency. Repository interfaces permit a future database adapter without changing
detector code.

The server runtime may live behind `triage-app` private routes, as the existing
attribution service does, but no insight data is rendered by the Tyrion browser UI.
Evaluation is invoked by the protected endpoint or a bounded operator command. It is
not performed during a user-facing GET.

Backfill is initiated through Mission Control's existing connector sync/projection
path in Bridge-compliant date windows and bounded pages. Mission Control publishes
only a completed durable generation through the same staged contract. Publication
runs with insight delivery disabled and aborts rather than promoting a partial
generation. OWL evidence is accessed through an optional `DocumentEvidencePort`; the
default adapter returns no evidence.

## 5. Shared detector rules

All detectors:

- evaluate posted, normalized Bridge transactions in the household timezone
- use exact decimal/minor-unit arithmetic and deterministic ordering
- apply the versioned Tyrion source classifier below before baseline construction
- preserve stable transaction, recurring, and category references; use a versioned
  normalized merchant key or explicit Tyrion alias and report its identity quality
- use robust medians, median absolute deviation (MAD), and empirical ranks rather
  than local arithmetic mean and standard deviation
- emit the rule result, comparison contribution, exclusions, sample counts, and
  versioned explanation reason codes
- produce no new alert from partial, stale, or unavailable data, and reject a source
  generation whose single declared currency conflicts with policy
- cap comparison rows and contributors before persistence and response

Thresholds are policy inputs, not literals hidden in detector code.

### 5.1 Versioned source classification

Bridge v1 does not supply a universal transfer/refund/correction type. Tyrion therefore
owns `TransactionClassifierV1`, evaluated from normalized amount/sign, stable
category/account/tag references, recurring association, prior versions of the same
source reference, and versioned Tyrion policy sets. It emits one of:
`postedSpend`, `pending`, `transfer`, `income`, `refund`, `unclassifiedCredit`,
`knownRecurring`, or `policyExcluded`, plus bounded reason codes and classifier
version.

Rules are deterministic:

- pending state always wins and is not baseline input
- exact policy category/tag sets identify transfers, income, refunds, and explicit
  exclusions; an account-pair heuristic may reinforce but never independently classify
  a transfer
- a positive credit not identified by policy is `unclassifiedCredit` and is excluded
  rather than guessed as income or refund
- the same source reference in a newer generation is a revision/correction of that
  source; ingestion rejects a duplicate reference inside one generation
- two different references with similar date, amount, or merchant are not
  automatically deduplicated; only a stable policy/source relationship may classify
  one as an excluded duplicate
- recurring association classifies a known obligation for the large-transaction
  exclusion without removing it from the recurring-bill detector

Classification is stored with policy and classifier versions and recomputed during an
explicit reevaluation. Ambiguous classification lowers confidence or blocks an
adaptive alert; it is never silently treated as ordinary spend.

| Classification case | Invented normalized facts | Expected result |
| --- | --- | --- |
| Pending purchase | Negative amount with `isPending=true` | `pending`; no detector baseline. |
| Configured transfer | Stable category/tag in the transfer policy set | `transfer`; excluded with exact reason. |
| Mirrored account movement only | Similar amounts across two accounts with no configured transfer reference | Not classified as transfer by heuristic alone. |
| Configured refund | Positive amount with a refund category/tag mapping | `refund`; excluded from current and baseline spend. |
| Unknown credit | Positive amount with no matching policy mapping | `unclassifiedCredit`; excluded and confidence reason retained. |
| Source revision | Same source reference changes amount in a higher source sequence | Correction/revision, not a second transaction. |
| Similar distinct records | Same date/amount/merchant but different references | Both retained unless explicit duplicate relationship exists. |
| Known recurring obligation | Recurring association matches a posted transaction | Excluded from large detector and eligible for recurring detector. |

## 6. Detector for issue #22: recurring bill amount

### 6.1 Algorithm

1. Establish a Tyrion recurring-obligation identity. Prefer the stable normalized
   Bridge recurring reference. Associate posted recurring transactions by exact
   normalized merchant, account/category context, cadence, and configured identity
   overrides. Ambiguous candidates remain unassociated and cannot create an adaptive
   alert.
2. Build up to 37 months of posted amount history. Convert spending to positive minor
   units only inside the detector.
3. Form the same-season cohort from the equivalent calendar month plus the configured
   adjacent-month window across prior years. Keep rolling history as separately
   labeled context; do not substitute it for missing seasonal coverage.
4. When normalized OWL facts provide valid billing-period dates, compare 30-day
   equivalent amounts and retain the original amount for display. When both usage and
   period facts exist, decompose amount movement into usage and unit-cost context.
   Missing or malformed optional evidence is ignored with a reason code.
5. Compute seasonal median and scaled MAD. The expected interval is the median plus or
   minus the greater of the configured MAD multiple and minimum spread. Zero-MAD
   cohorts use the configured minimum spread and receive an explanation reason.
6. Require both configured absolute and relative movement beyond the expected range.
   V1 analyzes both directions but only increases may open an alert; decreases remain
   visible as non-alert analysis.
7. Open one occurrence per recurring obligation and billing period. A source
   correction resolves that occurrence or supersedes it with a deterministic
   correction-lineage occurrence if corrected evidence still qualifies. An unchanged
   rerun retains both ID and revision.

### 6.2 Deterministic test matrix

| Case | Invented input | Expected result |
| --- | --- | --- |
| Expected summer bill | Current 20500 minor units; seasonal range 17000-21500 | Qualified=false; sufficient baseline; no occurrence. |
| Material seasonal spike | Current 28640; center 19530; both configured gates exceeded | Open high-severity occurrence with both reason codes. |
| Material seasonal decrease | Current is below both configured lower gates | Analysis records the decrease; no v1 alert or notification. |
| Rolling spike but no season | Two comparable periods and 12 rolling bills | `insufficientBaseline`; rolling context shown; no adaptive alert. |
| Long billing period | 35-day current period normalizes inside expected range | No alert; period-normalization exclusion/explanation present. |
| Usage explains increase | Amount and usage rise proportionally in normalized OWL facts | Policy-specific result with usage contributor; never raw document text. |
| OWL absent | Same Monarch facts with no document evidence | Same core seasonal result, lower/equal confidence, no failure. |
| Ambiguous obligation join | Two recurring identities match one transaction | Non-alert unavailable/ambiguous identity reason. |
| Same-period correction | Open occurrence followed by a corrected amount in the same episode | Old occurrence resolves or is superseded by a deterministic correction-lineage occurrence. |
| Reassigned correction | Corrected source moves to another obligation or billing period | Old occurrence superseded; replacement ID deterministic. |
| Material non-correction change | New same-period evidence crosses the material-value boundary | Same occurrence receives one delivery revision and may resurface. |
| Retry | Same generation, detector, and policy evaluated twice | Same evaluation, occurrence ID, and delivery revision. |
| Stale generation | Qualifying amount in stale coverage | No new alert; last reliable result remains visibly stale. |

## 7. Detector for issue #23: unusually large transaction

### 7.1 Algorithm

1. Evaluate only `postedSpend` transactions after the generation/evaluation fence.
   Exclude classifier-identified pending, income, transfer, refund, and known recurring
   records, plus approved merchants and policy-suppressed scopes.
2. Evaluate the explicit household amount rule independently.
3. Build prior-window robust comparisons for merchant, category, account, and
   household spending. Each comparison reports sample count, median, scaled MAD,
   empirical percentile, ratio, and whether it triggered, reinforced, or was
   informational.
4. Below the explicit dollar rule, adaptive qualification requires the configured
   meaningful-dollar floor and agreement from at least two eligible baselines among
   merchant, category, account, and household. No single comparison can trigger.
   Sparse dimensions report insufficient baseline rather than silently disappearing.
5. Severity follows impact policy. Confidence follows source completeness, explicit
   rule status, eligible baseline sufficiency, and signal agreement.
6. Open one occurrence for the stable transaction source lineage. A source correction
   resolves it or supersedes it with a deterministic correction-lineage occurrence;
   it never increments the corrected occurrence in place. Reevaluation alone does not
   alter identity or revision.
7. Explanation copy always says household spending exception and never says fraud,
   suspicious, compromised, or card-security alert.

### 7.2 Deterministic test matrix

| Case | Invented input | Expected result |
| --- | --- | --- |
| Explicit and adaptive | Posted 184000; 100000 rule; merchant/category comparisons exceed policy | Open occurrence; explicit and adaptive reasons; high confidence. |
| Explicit only | Posted 120000; sparse new merchant/category | Open rule-based occurrence; adaptive baseline insufficient and labeled. |
| Adaptive only | Below explicit rule; merchant and category robust gates agree | Open when the meaningful-dollar floor is met because two eligible baselines agree. |
| One adaptive baseline | Below explicit rule; only merchant baseline triggers | No alert because fewer than two eligible baselines agree. |
| Account only | Large relative to account but ordinary merchant/category value | No adaptive alert; account marked informational. |
| Expected obligation | Invented mortgage-like recurring transaction | Excluded with known-recurring reason. |
| Approved merchant | Otherwise qualifying merchant is policy-approved | No occurrence; suppression provenance retained. |
| Pending then posted | Pending record later becomes posted | No pending alert; exactly one posted occurrence. |
| Transfer/refund/income | Large non-spending records | Excluded deterministically. |
| Corrected amount | Posted value changes materially in a later generation | Old occurrence resolves or is superseded; any replacement/resurface is deterministic. |
| Retry and order | Same records arrive in different page order and are reevaluated | Identical IDs, reason ordering, confidence, and revision. |

## 8. Detector for issue #24: category and merchant variance

### 8.1 Algorithm

1. Determine the household-local current calendar period. For an incomplete month,
   compare day 1 through the current completed day with the same elapsed-day slice in
   each prior month. A completed month compares with completed prior months.
2. Aggregate classifier-approved `postedSpend` separately by stable category
   reference and Tyrion's canonical merchant key. Carry merchant identity quality into
   confidence. Report transfer, refund, credit, and other exclusion counts. Reapply
   the current normalized category projection before aggregation so a source
   recategorization does not split identity silently.
3. For each entity, require configured active-month and transaction sample coverage.
   Compute the median equivalent-period total, scaled MAD, expected range, absolute
   delta, relative delta where meaningful, and robust deviation score.
   V1 uses six prior months, requires activity in at least three months and at least
   three baseline transactions for a limited baseline, and requires all six active
   months plus at least six baseline transactions for a sufficient baseline. Six
   completely covered zero-spend periods are representative for the separate
   new-spend rule. A 5000-minor-unit minimum spread prevents zero-MAD histories from
   producing unbounded significance.
4. Qualification requires all configured gates: meaningful absolute impact, relative
   movement, and robust deviation. A zero baseline uses a separate new-spend rule and
   never reports an infinite percentage.
5. Rank qualified movers deterministically by severity, absolute impact, confidence,
   entity kind, and stable entity identity. Cap persistent results and digest members.
   Positive and negative directions remain explicit.
6. Select at most 10 transaction contributors by estimated contribution to delta,
   then date and opaque identity. Contributors explain the result but do not alter the
   aggregate.
7. Maintain one occurrence per entity, calendar period, and direction. Equivalent
   daily updates revise the same occurrence only when materiality rules change the
   delivery revision. Direction reversal or a source recategorization that invalidates
   identity supersedes it.
8. Mission Control groups the bounded current member set into one deterministic
   monthly digest; Tyrion remains the owner of each source occurrence.

### 8.2 Deterministic test matrix

| Case | Invented input | Expected result |
| --- | --- | --- |
| Equivalent partial period | Day 1-10 total 62430; prior day 1-10 center 40210 | Compare equivalent slices, not full months. |
| Material increase | Absolute, relative, and robust gates all pass | Open upward category occurrence with ranked contributors. |
| Percentage-only noise | 100 to 250 minor units | No alert because meaningful-dollar gate fails. |
| Dollar-only movement | Large delta but small relative movement | No alert because relative gate fails. |
| Zero baseline | Prior equivalent totals are zero; current meets new-spend policy | Null percentage, explicit new-spend reason, no infinity. |
| Sparse merchant | Activity in too few prior months | Limited/insufficient baseline according to policy; no overstated confidence. |
| Refund and transfer | Current period contains both | Excluded consistently from current and baseline; counts explained. |
| Category correction | Source recategorizes a contributor in a newer generation | Old occurrence resolves/supersedes; aggregates are recomputed once. |
| Bounded ranking | More movers/contributors than limits | Deterministic top set and exact omitted count. |
| Digest retry | Same monthly member/revision set is delivered twice | Same digest ID/revision; no duplicate notification. |

## 9. Approved v1 defaults and canary tuning

The candidate values in the approved mockups are the versioned, feature-gated v1
defaults. Canary tuning creates a new policy version and affects only source
generations accepted after that version becomes effective. Prior occurrences are never
retroactively relabeled.
Robust-statistic implementation constants not listed as product thresholds must still
be deterministic, versioned, and covered by detector tests.

| Decision | Approved v1 default |
| --- | --- |
| Recurring absolute/relative gates | 7000 minor units and 2500 basis points; analyze both directions and alert only on increases |
| Seasonal cohort and coverage | Adjacent-month window, 37-month horizon, and at least two prior seasonal years |
| Robust range | Median plus the versioned scaled-MAD multiple and minimum-spread safeguard |
| Large transaction explicit rule | 100000 minor units |
| Adaptive large-transaction agreement | Meaningful-dollar floor plus agreement from at least two eligible merchant/category/account/household baselines |
| Variance gates | 15000 minor units, 3000 basis points, and the versioned robust-deviation gate |
| Variance comparison coverage | Six prior months; limited at three active months and three transactions; sufficient at six active months and six transactions |
| Variance zero-MAD safeguard | 5000 minor units minimum spread |
| Persistent and digest bounds | Top 10 occurrences and top 10 contributors |
| Freshness | `sourceAsOf` no more than 48 hours old for a new alert |
| Delivery | Large transaction immediate; grouped monthly digest on day 2 at 9:00 AM household-local time |
| Medium-confidence movers | Visible on `/finance`; excluded from notifications and the notifying digest |
| Suppression | Fixed operator may use 30/90/180-day timed suppression with undo; permanent suppression prohibited |

Policy snapshots are immutable, monotonically versioned, validated, and included in
every evaluation. A threshold edit never retroactively relabels history. A retry of a
promoted generation uses the detector and policy versions originally assigned to that
generation.

## 10. Mission Control implementation and hazard retirement

Mission Control consumes the contract through a server-only client. Its bounded local
projection stores connector, insight, occurrence and revision identity; grouping and
local disposition; timestamps; and only the summary fields needed for outage-safe
cards: kind, headline, entity label, observed/expected/delta values, severity,
confidence, baseline sufficiency, lifecycle, freshness, source-as-of, and typed target
descriptors. It does not store comparison rows, contributors, source facts, document
evidence, or a second baseline model. Detail remains Tyrion-owned and live-fetched.
Each connector projection is transactionally replaced and capped at 500 active/recent
summary rows; an over-limit response fails without partial replacement. Cached cards
may show financial summary fields for at most seven days after `sourceAsOf`, then
collapse to a metadata-only unavailable state. Summary payloads are purged after 30
days without a successful refresh. Minimal resolved/superseded identity/disposition
tombstones expire after 90 days and are capped at 1,000 per connector with
oldest-resolved-first eviction. Dismiss never resolves Tyrion lifecycle.

### 10.1 Existing Mission Control integration points

Implementation should extend these current boundaries rather than create a parallel
Finance stack:

- `docs/development/decisions.md` contains Mission Control's controlling Finance
  decision.
- `src/app/finance/page.tsx` and
  `src/components/finance/FinanceOverview.tsx` own the durable `/finance` home.
- `src/app/finance/review/page.tsx` and
  `src/components/finance/FinanceReview.tsx` own attribution-only review and remain
  unchanged in meaning.
- `src/lib/connectors/monarch-money/index.ts::FinanceManagerConnector` declares the
  canonical `finance-manager` connector and `notificationOnly` capability.
  `src/app/api/features/route.ts` already excludes notification-only connectors from
  task destinations.
- `src/lib/connectors/monarch-money/client.ts::MonarchBridgeClient` remains scoped to
  the public connector gateway and must not call private insight routes. Add a
  `TyrionFinanceInsightClient` modeled on the private-authority client in
  `src/lib/connectors/monarch-money/attribution-service.ts`. It uses the fixed private
  Tyrion service authority, strict Zod schemas, contract-version checks, response
  bounds, redirect/authority rejection, timeout/retry policy, cursor handling, and
  sanitized errors.
- `src/lib/connectors/monarch-money/finance-request.ts` provides trusted Finance read
  checks for the Mission Control proxy route. New insight reads must fail closed on
  invalid credentials and cross-site requests.
- `src/db/finance-schema.ts` and generated Drizzle migrations own the bounded local
  projection. Follow the snapshot/freshness migrations and tests rather than creating
  an unjournaled table.
- `src/lib/notifications/service.ts`, `src/lib/notifications/lifecycle.ts`, and
  `src/lib/notifications/providers/finance.ts` own notification persistence,
  lifecycle, and presentation. New Finance code must not insert notification rows
  directly. The provider registry must resolve canonical `finance-manager` and legacy
  `monarch-money` aliases rather than only the old `finance` source type.
- `src/lib/notifications/templates.ts` currently gives some legacy Finance templates
  a `create_task` action despite the connector's notification-only capability. Provider
  cleanup must remove every Finance task action and test all Finance aliases.
- `src/lib/finance/external-links.ts` owns allowlisted Finance external origins and
  roots. Typed entity builders belong there; optional document targets should follow
  document-hub mapping patterns while adding Finance-specific origin validation.
- `src/lib/notifications/query.ts` and `query-server.ts` are the shared notification
  filter DTO and SQL builder. Category/merchant parity must extend them instead of
  introducing a Finance-only query parser.

The generic `/insights` route is task-productivity UI and is not a Finance surface.

### 10.2 Presentation

- Add a failure-isolated Spending insights section below Needs attention on
  `/finance`. `FinanceOverview` should load it as a third independent request beside
  the existing overview and connector-health requests. A Tyrion failure must not clear
  overview attention, attribution access, connector health, or Monarch roots.
- Render persistent groups for recurring changes, recent/open large transactions,
  and category/merchant movers. Compact cards retain value, confidence, baseline
  sufficiency, lifecycle, and freshness text.
- Open detail in the approved Finance/notification context, not
  `/finance/review`. Reuse shared card, dialog, status, focus, and notification
  primitives instead of finance-only replacements.
- Provide both the canonical notification detail route and a `/finance` drawer. They
  render one shared Finance insight detail component and therefore cannot drift in
  evidence, provenance, lifecycle, actions, or accessibility behavior.
- Preserve the same category and merchant filter choices and active-filter count on
  desktop and mobile. Narrow layouts put the queue before detail, stack facts/actions,
  and allow evidence tables to scroll.
- Build Monarch and OWL actions only through typed target registries. Missing target
  support removes that action without hiding the insight.
- Never create a task. Assert that the finance provider emits only notifications and
  local Finance records.
- Build the monthly movers digest as one bounded rich notification. Mission Control
  stores `groupKey`, but the current notification UI does not visually aggregate
  separate notifications by that field.

### 10.3 Existing hazards and explicit retirement gates

| Hazard | Retirement work | Acceptance gate |
| --- | --- | --- |
| Local mean/standard-deviation anomaly detector | Remove `src/lib/finance-notifications/index.ts::checkAnomalies`, which uses merchant average and local standard deviation, from `runNotificationChecks` and `src/lib/finance-notifications/scheduler.ts`. Delete it after canary. Do not improve or use it as outage fallback. | No production import/call remains; an insight outage leaves existing Finance content available with an unavailable warning and creates no local anomaly. |
| Random/no-dedupe finance notification identity | Replace `createFinanceNotification` timestamp/random IDs and `persistNotification` direct inserts with `createNotification`/`createNotifications`. Use connector + occurrence as stable `sourceId`, delivery revision as source activity/occurrence key, and the equivalent stable monthly digest identity. | Replaying the same Tyrion page and restarting the worker creates zero duplicate notifications; a material revision updates/reopens one row and creates at most one resurface. |
| Fake connector identity | Remove `persistNotification`'s `finance-alerts` connector reference. Resolve the one actual enabled connector and persist its configuration ID and canonical `finance-manager` type on every occurrence/delivery. | Zero or multiple connector matches is an unavailable state; no placeholder connector string is accepted or rendered; `/finance` finds the delivery by its selected connector. |
| Missing mobile finance-category filter parity | Fix `src/app/notifications/page.tsx` and `src/components/mobile/MobileNotificationsScreen.tsx`, which currently drop category on the mobile fetch. Extend the shared query DTO/server builder with a bounded merchant filter and give desktop/mobile the same applied-filter and clear behavior. | Desktop/mobile contract tests expose identical choices, selected state, result count, clear behavior, and keyboard labels. |

### 10.4 Mission Control projection and notification conventions

Add `src/app/api/finance/insights/route.ts` as a trusted server proxy and a separate
private-authority `TyrionFinanceInsightClient`; do not route insight traffic through
`MonarchBridgeClient` or the public connector gateway. The local projection is keyed
by actual connector ID plus Tyrion occurrence ID, with `insightId` as a grouping/index
field. This allows multiple episodes in one series to coexist while retaining only
the bounded summary context defined above.

Generate the `src/db/finance-schema.ts` change through the existing Drizzle workflow,
including SQL, journal, and snapshot. Migration tests execute generated statements
against isolated SQLite and must prove replay and startup migration behavior.

Create notifications only through the notification service. Use stable
connector-plus-occurrence `sourceId`, actual `connectorInstanceId`, `templateKey`,
`sourceActivityAt`, revision-bearing `sourceActivityKey`, `groupKey`, `dedupeKey`,
internal `navigationTarget`, and revision-bearing `occurrenceKey`. Preserve the
independent read, local disposition, source activity, and synchronization dimensions
in `src/lib/notifications/lifecycle.ts`. Push delivery continues to dedupe by channel,
notification ID, and occurrence key.

Extend `financeNotificationProvider` with explicit large-transaction,
recurring-change, and monthly-movers signatures. `NotificationCard` already bounds
metadata chips, rich content, and primary/secondary actions; add Finance provider/card
tests instead of a second card renderer. Register the provider for canonical
`finance-manager`, legacy `monarch-money`, and persisted migration alias `finance`.
Normalize those three as one Finance source family for provider resolution and source
filtering until M6. No Finance signature or template may expose `create_task`.

For filter parity, category must round-trip through mobile route consumption and show
an applied-filter/clear affordance. Merchant is a new bounded exact filter through
`src/lib/notifications/query.ts`, `query-server.ts`, the notifications API, desktop,
and mobile. Store only a normalized allowlisted merchant key/label in presentation
metadata, use parameterized exact extraction, and bound any merchant facets.

### 10.5 Legacy notification cutover

Random legacy finance notifications cannot be safely inferred as the same occurrence.
Cut over per connector in this order:

1. Transactionally disable the legacy producer and record `cutoverAt`.
2. Expire still-open legacy anomaly notifications by the exact legacy provider/type,
   without touching tasks, attribution review, or unrelated finance notifications.
3. Import only the latest Tyrion revision per open occurrence at or after the
   connector cutover generation.
4. Enable deterministic delivery and record one metadata-only cutover result.
5. Never translate legacy dismissals into Tyrion resolution or suppression.

Rollback disables new delivery and presentation but leaves Tyrion evaluation and
history intact. It must not reactivate the legacy detector automatically.

## 11. Migration, rollout, and safe fallback

### 11.1 Feature gates

Use separate server-side gates:

- Tyrion evaluation/write
- Tyrion read API
- Mission Control shadow ingest
- Mission Control `/finance` presentation
- large-transaction immediate notifications
- monthly digest notifications
- confirmed Tyrion actions

No gate value, token, private host, or state path is browser-visible. Gates fail
closed for writes and notification creation.

### 11.2 Rollout sequence

1. Apply Tyrion schema migration with all gates off.
2. Backfill invented/demo and then operator-controlled live normalized history with
   publication off. Validate counts and detector invariants without logging records.
3. Enable Tyrion evaluation and read API; run Mission Control shadow ingest without
   UI or notifications.
4. Compare metadata-only totals, lifecycle transitions, freshness, and replay dedupe.
5. Enable `/finance` persistent presentation.
6. Enable immediate large-transaction notification for the single connector.
7. Enable the grouped monthly digest after a complete dry run, scheduled for day 2 at
   9:00 AM household-local time; medium-confidence movers remain `/finance`-only.
8. Enable confirmed expected/suppression actions for the fixed operator.
9. Remove legacy Mission Control detector/provider paths and temporary gates.

### 11.3 Fallback behavior

- Tyrion evaluation failure preserves the last promoted generation and returns a
  sanitized unavailable state.
- Mission Control insight fetch failure does not fail the existing Finance overview,
  connector health, attribution review, or Monarch links.
- Stale/partial data creates no new notification. Cached cards remain visibly stale
  only through the shorter of the product freshness policy and seven-day cache limit,
  then collapse to metadata-only unavailable state and follow the 30-day payload purge.
- An invalid target descriptor removes only the external action.
- A notification write failure retries the same deterministic identity.
- A grouped-digest failure does not fan out into individual fallback tasks or
  notifications.
- Rollback never re-enables the naive local detector, random identity, or fake
  connector.

## 12. Observability without financial data

Tyrion may emit:

- evaluation started/completed/failed counts by detector and stable error code
- duration, Bridge page count, promoted/rejected generation count, and source lag
- result counts by analysis state, lifecycle, severity, confidence, sufficiency, and
  reason code
- occurrence opened/resolved/superseded/revised counts
- idempotent replay and policy-conflict counts

Mission Control may emit:

- insight fetch success/failure and page count
- occurrence upsert created/updated/unchanged counts
- notification created/deduped/grouped/retried counts
- local read/dismiss/snooze counts
- invalid/unsupported typed target counts
- responsive filter interaction counts without filter values

Logs, traces, metric labels, screenshots, test snapshots, and artifacts must exclude
amounts, names, source/connector/occurrence IDs, URLs, request bodies, document
content, account/transaction identifiers, and upstream errors. Correlation uses a
short-lived evaluation operation ID that is not derived from source identity.

Alert on metadata-only conditions: evaluation failures, freshness SLA breach,
generation promotion failure, cursor loop, repeated idempotency conflict, unexpected
notification creation volume, and unsupported target growth.

## 13. Exact future child-session and PR topology

One session owns one branch and one PR. The current documentation PR is the root
planning artifact; it does not become the base branch for production work.

```text
T1 Tyrion contract
  -> T2 Tyrion projection/lifecycle
       -> T3a recurring detector ----\
       -> T3b large detector ---------+-> T4 Tyrion service integration
       -> T3c variance detector ------/

T1 -> M1 Mission Control client/persistence
        -> M2 deterministic ingestion and cutover fence
             -> M3 /finance presentation
                  -> M4 Finance notification cards
             -> M5 mobile category/merchant filter parity

T4 + M4 + M5 -> R1 homelab gated rollout
R1 canary -> M6 Mission Control legacy cleanup
```

### PR P0 - this plan

- **Repository/session:** `rsocko/tyrion`, current planning session
- **Scope:** this document and its link from the approved UX rationale only
- **Acceptance:** documentation/hygiene checks, independent review, invented data,
  and no production files changed

### PR T1 - contract and deterministic core

- **Repository/session:** new Tyrion child from `main`
- **Scope:** OpenAPI, strict DTO parsers, typed target unions, identity helpers,
  versioned policy types, explanation reason codes, and repository ports in a new
  private `finance-insights/` module
- **Tests:** contract examples; unknown field/type/bounds; ID stability and namespace;
  minor-unit arithmetic; target allowlist; null/zero distinction; sanitized errors
- **Acceptance:** no route, Bridge DTO, session access, or browser surface is added

### PR T2 - source projection, lifecycle, and migrations

- **Repository/session:** Tyrion child stacked on T1
- **Scope:** SQLite migrations/repository, strict staged normalized source-fact upload
  and atomic promotion, actual connector generation validation, recurring/merchant
  identity association, optional evidence port, occurrence lifecycle, snapshot
  pagination, and separate source/evaluation replay fences
- **Tests:** forward migration and restart recovery; crash before/after promotion;
  duplicate generation; out-of-order source/evaluation completion; partial endpoint
  failure; stale source; restart replay; cursor/filter binding; concurrent evaluation;
  the source-classification matrix
- **Acceptance:** publication remains off; no detector can read partial staging data;
  no reusable Monarch material is loaded

### PRs T3a, T3b, and T3c - detectors in parallel

- **Repository/session:** three Tyrion children, each based on the reviewed T2 branch
- **Scope:** one detector and its explanation templates per PR
- **Dependencies:** no detector PR depends on another detector PR
- **Tests:** the complete matrices in sections 6-8 plus property tests for ordering,
  pagination independence, exact arithmetic, and bounded output
- **Acceptance:** thresholds come only from a validated policy snapshot; algorithms
  use robust statistics; no detector route or Mission Control code is included
- **Restacking:** after T2 merges, retarget all three to `main`; merge independently

### PR T4 - protected service and evaluation orchestration

- **Repository/session:** Tyrion child created after T3a-c merge
- **Scope:** private staged-upload/read/action routes, authentication/authority checks,
  manifest promotion, evaluation job handling, action compare-and-swap, feature gates,
  metadata-only telemetry, operational health, and container state mount
- **Tests:** auth/authority/error matrix; missing/duplicate/changed batch; manifest
  mismatch; detector integration; action confirmation/conflicts; bounded backfill
  generation; exact 30/90/180-day suppression and undo; permanent-suppression
  rejection; fixed-operator actions without invented permission branches; response
  limits; no browser/public route; exact OpenAPI conformance
- **Acceptance:** Tyrion does not contact Monarch directly or load a session; live
  tests remain opt-in; insight browser pages do not exist;
  `monarch-bridge/contract.py` public shapes remain intact

### PR M1 - Mission Control client, storage, and safe targets

- **Repository/session:** Mission Control child from `main`, started after T1 contract
  review and developed in parallel with T2/T3
- **Scope:** separate private-authority `TyrionFinanceInsightClient` modeled on
  `attribution-service.ts`, trusted `src/app/api/finance/insights/route.ts`, atomic
  `FinanceInsightPublicationGenerationV1` capture across exact transaction/reference
  constituent generations, local occurrence projection in `src/db/finance-schema.ts`
  plus generated migration, snapshot pagination, actual connector selection, typed
  builders in `src/lib/finance/external-links.ts`, shadow-ingest gate, and failure
  isolation
- **Tests:** contract fixtures; filter/cursor handling; zero/multiple connector;
  invalid target; complete composite capture; partial/mixed/gapped/stale constituent
  refusal; conservative `sourceAsOf`; local idempotent upsert; migration replay;
  private-authority enforcement; Tyrion 4xx/5xx/timeouts; no token in browser code
- **Acceptance:** no UI/notification/task creation; no raw URL; no baseline
  reimplementation

### PR M2 - deterministic ingestion and cutover fence

- **Repository/session:** Mission Control child stacked on M1
- **Scope:** ingest Tyrion occurrences through
  `src/lib/notifications/service.ts`; publish each completed durable normalized
  connector generation through the staged Tyrion source contract; use actual connector
  identity, stable source/occurrence/group/dedupe keys, local projection refresh,
  retry/resurface rules, and a mutually exclusive legacy/new producer fence. Wire the
  synchronizer into `FinanceManagerConnector.syncDomainData()` and the canonical
  connector sync/worker, not process-local cron or the manual legacy check route.
- **Tests:** source batch/commit replay and conflict; incomplete generation rejection;
  stale publication fence; replay/restart/concurrency notification dedupe; lifecycle
  independence; one active notification row across delivery revisions; zero/multiple
  connectors; projection count/age/eviction bounds; notification-only/no-task
  invariant; legacy producer exclusion
- **Acceptance:** no direct notification insert in the new path; no random or
  placeholder identity; old and new producers cannot run for the same connector

### PR M3 - durable `/finance` presentation

- **Repository/session:** Mission Control child stacked on M2
- **Scope:** extend `FinanceOverview` with an independent insight request, Spending
  insights groups, compact/detail states, cached stale/unavailable fallback,
  provenance, the `/finance` drawer, and one shared detail component also consumed by
  the canonical notification detail route
- **Tests:** loading/empty/unavailable/insufficient/open/resolved/stale/partial states;
  keyboard and semantics; 44px actions; narrow layout; `/finance/review` unchanged;
  existing Finance overview survives insight failure; route/drawer detail parity
- **Acceptance:** no tasks, no `/insights` reuse, and no production navigation to a
  Tyrion insight UI

### PR M4 - Finance notification cards and grouped digest

- **Repository/session:** Mission Control child stacked on M3
- **Scope:** explicit signatures in
  `src/lib/notifications/providers/finance.ts`, immediate large-transaction card,
  recurring-change card, one deterministic monthly-movers rich notification, local
  disposition, safe Monarch/optional OWL actions, canonical/legacy provider aliases,
  removal of Finance `create_task` template actions, and `NotificationCard`
  integration
- **Tests:** digest membership/revision; read/dismiss/snooze independence; material
  resurface; no task creation; actual connector identity; safe notification actions;
  bounded/invalid rich content; provider registry resolution for `finance`,
  `finance-manager`, and `monarch-money`; both connector types absent from task
  destinations; day-2 9:00 AM household-local scheduling; medium-confidence movers
  omitted from notification delivery
- **Acceptance:** notification-first large transaction, no fraud copy, and no reliance
  on `groupKey` for visual aggregation

### PR M5 - notification category/merchant mobile parity

- **Repository/session:** Mission Control child based on M2; may proceed in parallel
  with M3/M4 and restack before rollout
- **Scope:** bounded merchant filter in `src/lib/notifications/query.ts`,
  `query-server.ts`, notifications API, desktop filter UI, and mobile; fix category
  query handoff in `src/app/notifications/page.tsx` and
  `MobileNotificationsScreen.tsx`; add mobile Finance category/source chips, bounded
  facets, and applied-filter/clear UI. Use one shared responsive
  `dimension=category|merchant` control for the `/finance` mover groups. Treat
  `finance`, `finance-manager`, and `monarch-money` as one Finance source-filter family
  during migration rather than issuing one exact-type query.
- **Tests:** shared query parse/serialize/equality/SQL tests; desktop/mobile category
  and merchant deep links; Finance source deep links/results for all three aliases;
  selected count; clear; 44px and keyboard/focus behavior
- **Acceptance:** desktop and mobile send and display the same normalized Finance
  filters without SQL interpolation or unbounded merchant enumeration

### PR R1 - deployment and gated canary

- **Repository/session:** `rsocko/homelab-config` child from `main`
- **Scope:** reviewed image versions, private routing, access-restricted Tyrion state
  volume, server-only endpoint/token wiring, gates initially off, backup/rollback,
  metadata-only health checks, and ordered canary runbook
- **Dependencies:** released T4, M4, and M5 images
- **Acceptance:** internal routes are not publicly routable; no values are committed;
  rollback does not enable legacy detection

### PR M6 - legacy retirement

- **Repository/session:** Mission Control child from current `main` after R1 canary
- **Scope:** delete `checkAnomalies`, timestamp/random identity, direct legacy
  notification persistence, `finance-alerts`, compatibility gates, scheduler call
  sites, `generateWeeklySummary`/`weekly_summary`, the manual
  `/api/finance/notifications/check` path, deprecated `/api/finance/alerts*` routes,
  and dead tests. Retire or redirect the legacy list/dismiss/weekly-summary routes only
  after confirming no supported caller remains; retain regression tests for safe
  outage and filter parity.
- **Acceptance:** repository search and tests prove all four hazards are retired;
  existing unrelated finance notifications and attribution review remain intact

### Validation commands by repository

Each child session should run the smallest listed set covering its files, then the
repository lint/build gate before merge.

For Tyrion detector/core PRs:

```powershell
Set-Location finance-insights
npm ci
npm test
npm run build
```

For Tyrion service integration:

```powershell
Set-Location triage-app
npm ci
npm test
npm run lint
npm run typecheck
npm run build
```

For the Mission Control contract/projection PR:

```powershell
npm run db:generate
npm test -- tests\db\finance-snapshot-migration.test.ts tests\db\finance-dataset-migration.test.ts tests\connectors\monarch-dataset-sync.test.ts tests\connectors\monarch-projection-concurrency.test.ts tests\api\finance-overview.test.ts tests\api\finance-insights.test.ts tests\db\finance-insight-projection-migration.test.ts
```

For Mission Control identity, presentation, and provider PRs:

```powershell
npm test -- tests\notifications\notification-lifecycle.test.ts tests\notifications\durable-push-outbox.test.ts tests\notifications\provider-registry.test.ts tests\notifications\notification-card-di.test.tsx tests\lib\finance-notifications.test.ts
npm test -- tests\components\money-page.test.tsx tests\components\finance-review.test.tsx tests\api\features-notification-only.test.ts
```

For Mission Control filter parity:

```powershell
npm test -- tests\notifications\notification-query.test.ts tests\components\mobile-notifications-screen.test.tsx
```

Every Mission Control PR also runs:

```powershell
npm run lint
npm run build
```

Generated migration SQL, journal, and snapshot must be reviewed together. Final
validation in every repository includes `git diff --check` and the repository's
sensitive-file/content checks.

## 14. Parallelism and stacking rules

- T1 must land before any consumer or persistence implementation relies on v1.
- T2 stacks on T1 because detector input, lifecycle, and migration semantics share the
  contract types.
- T3a-c proceed in parallel from the same reviewed T2 base and own disjoint detector
  files and fixtures.
- M1 may proceed in parallel with T2/T3 from the frozen T1 OpenAPI and synthetic
  fixtures. Contract changes require coordinated T1 amendment before either side
  merges.
- M1 owns the only Mission Control Drizzle generation in this stack. Do not generate
  migrations concurrently; later Mission Control PRs stack on and reuse its schema.
- M2, M3, and M4 remain a Mission Control stack because ingestion, presentation,
  detail navigation, and rich notification cards share local occurrence persistence.
- M5 may proceed from M2 in parallel because it owns the shared notification query and
  mobile filter path; restack it after M4 before rollout if generated migrations or
  shared notification types conflict.
- T4 waits for all three detectors. M4 can be implemented against fixtures but cannot
  be enabled before T4 integration passes.
- R1 waits for released Tyrion and Mission Control images. M6 waits for successful
  canary evidence so rollback remains possible without restoring unsafe legacy code.
- No OWL repository PR is required for v1. Optional evidence stays disabled until an
  existing protected normalized OWL contract can satisfy `DocumentEvidencePort`.

## 15. Cross-repository acceptance and release gate

The feature is releasable only when:

- contract fixtures pass unchanged in Tyrion and Mission Control
- a complete invented generation produces the same IDs, revisions, explanations, and
  grouping across replay and restart
- each detector matrix passes without network or developer state
- incomplete/stale source data produces no fresh notification
- `/finance` degrades independently and `/finance/review` is unchanged
- large transactions deliver notification-first and do not use fraud language
- recurring and monthly mover groups persist on `/finance`
- one deterministic monthly digest represents the bounded mover set
- the digest runs on day 2 at 9:00 AM household-local time and excludes
  medium-confidence movers, which remain visible on `/finance`
- dismiss/snooze remains local; expected/suppress uses explicit confirmed Tyrion
  actions; the fixed operator may select only 30/90/180 days with undo; no task or
  permission model is created
- all external actions pass through typed connector-owned builders
- the actual configured connector is present end to end
- desktop and mobile category/merchant filter behavior is identical
- logs, telemetry, errors, snapshots, and artifacts contain no financial records,
  identifiers, private URLs, session material, or raw upstream text
- the four Mission Control hazards are removed after canary

## 16. Approved v1 product decision record

All product decisions required to begin T1 are resolved:

1. Insight detail is available from both the canonical notification detail route and a
   `/finance` drawer using one shared component.
2. The candidate detector thresholds are versioned, feature-gated defaults and may be
   tuned through canary without retroactive relabeling.
3. Recurring decreases are analyzed but only increases alert in v1.
4. Adaptive large-transaction qualification below the explicit rule requires at least
   two eligible merchant/category/account/household baselines to agree.
5. The fixed single operator may use all feedback and 30/90/180-day suppression
   actions with undo. V1 has no elevated permission concept and prohibits permanent
   suppression.
6. Mission Control uses verified entity-specific Monarch links when available and the
   corresponding allowlisted Transactions, Recurring, or Reports root otherwise.
7. A dismissed insight resurfaces only for a new occurrence or materially changed
   source value/classification. Corrections resolve or supersede the old occurrence.
8. New-alert source freshness is 48 hours; the monthly digest runs on day 2 at 9:00 AM
   household-local time; medium-confidence movers remain visible on `/finance` without
   notifying.

There are no remaining execution-blocking product questions.
