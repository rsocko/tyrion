# Finance Notification Routing and Action Matrix

**Status:** Normative v1 policy for Tyrion-to-Mission Control attention

**Authoritative boundary:** [`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md)

This policy defines how finance signals become Mission Control awareness or work. It
does not add a Tyrion product surface, a Monarch Bridge route, or a second task system.
Mission Control owns notification disposition, tasks, My Day, authorized route
resolution, and rendering. Tyrion and the relevant source systems own signal meaning,
source lifecycle, and settlement evidence.

## Invariants

1. Every signal has one primary attention record: notification, task, status-only
   projection, or suppressed state. A producer never creates both a finance
   notification and a finance task for the same open occurrence.
2. A task-routed signal may use Mission Control's ordinary task reminders. Those are
   task lifecycle notifications, not a second finance-signal notification.
3. My Day is a projection of an existing task, never a fifth independently persisted
   finance object. A task is only a My Day candidate when this policy says so; normal
   Mission Control scheduling and user selection remain authoritative.
4. Read, dismiss, and snooze are Mission Control delivery dispositions. They do not
   resolve Tyrion, Monarch, connector, write-back, or reconciliation state.
5. Source settlement completes or cancels related work according to the settlement
   matrix. A user cannot manufacture source settlement by dismissing a notification.
6. Finance insight occurrences remain `notificationOnly`. Large transactions,
   recurring-amount changes, and monthly variance digests never create tasks or My Day
   candidates.
7. `FinanceManagerConnector.notificationOnly` remains unchanged, and every Finance
   connector alias remains excluded from generic task destinations. Separately, the
   Finance notification provider and template registry omit and reject `create_task`.
   Durable non-insight tasks in this matrix are created only by the Mission Control
   routing service's Finance policy path from an approved row and stable logical key;
   they do not bypass or broaden connector capabilities.
8. No signal carries a raw URL. Internal navigation uses the fixed authorized route
   registry; external navigation uses typed Monarch or document targets and an
   allowlisted server-side resolver.
9. New attention requires complete, sufficiently fresh provenance. Stale or partial
   data can preserve an existing work item with an explicit warning, but cannot create
   or escalate one.

## Routing vocabulary

| Route | Meaning | Acknowledgment | Snooze/defer |
| --- | --- | --- | --- |
| `informationalNotification` | Useful awareness with no expected follow-up | Read or dismiss | Notification snooze is allowed |
| `actionableNotification` | A bounded decision is useful, but durable work is not yet warranted | Read, dismiss, or perform an action; dismissal does not settle the source | Notification snooze is allowed |
| `task` | Durable follow-up, deadline, repeated unresolved condition, or failed mutation | Task completion/cancellation follows normal task semantics and is reconciled with source state | Defer or schedule through task controls |
| `statusOnly` | Visible on the relevant Finance surface without interruption | None | None |
| `suppressed` | No user-facing attention record; retain bounded metadata needed for dedupe, policy explanation, or settlement | None | None |

Severity and route are independent. Severity controls ordering and presentation inside
the selected route; it does not turn an informational insight into a task.

| Severity | Use |
| --- | --- |
| `info` | Expected state change or low-urgency awareness |
| `medium` | Timely review is useful |
| `high` | Prompt review or action is required |
| `critical` | A bounded finance operation is blocked or an obligation is overdue; this is not fraud language |

## Stable routing input

Every producer supplies a strict, versioned routing envelope. Mission Control rejects
unknown fields and invalid enum combinations rather than guessing a route.

| Field | Requirement |
| --- | --- |
| `contractVersion` | Exact `1.0` routing contract version |
| `signalFamily` | `threshold`, `attribution`, `anomaly`, `writeBack`, `reconciliation`, `connectorHealth`, or `summary` |
| `signalKind` | One allowlisted row in the signal matrix |
| `signalId` | Stable opaque source identity; never a title, amount, merchant name, account identifier, or raw document identifier |
| `occurrenceId` | Stable identity for one open episode or period |
| `attentionKey` | Stable opaque identity shared by every stage of the same logical condition; it does not change when `signalKind` is promoted |
| `revision` | Monotonic positive integer for material changes to that occurrence |
| `sourceLifecycle` | `open`, `resolved`, or `superseded` |
| `severity` | Producer-owned severity from the bounded enum above |
| `episodeSince` | Immutable UTC timestamp when this open occurrence began |
| `conditionSince` | UTC timestamp when the current routing stage first became continuously true; it changes only when `signalKind` changes, not for a severity-only revision |
| `sourceAsOf` | UTC timestamp for the facts used to produce the signal |
| `evaluatedAt` | UTC timestamp for the completed deterministic evaluation |
| `freshness` | `fresh`, `stale`, `partial`, or `unavailable` |
| `provenance` | Owning system, policy/detector or matcher version, source generation, and connector reference where applicable |
| `dueAt` | Nullable UTC deadline for obligation-backed signals only |
| `capabilities` | Unique bounded list of at most 12 capabilities from the authorized action registry; each must be allowed for `signalKind` |
| `targets` | Bounded typed internal, Monarch, Tyrion-configuration, or source-document descriptors; never URLs |
| `settlementReason` | Required stable reason code for `resolved` or `superseded`; otherwise `null` |

Display copy and private finance values are fetched from the authorized detail source;
they are not part of identity, dedupe, task metadata, logs, or telemetry. Mission
Control persists only bounded operational context and opaque references.

## Deterministic signal matrix

Elapsed conditions in the `Escalation / My Day` column are evaluated against
`conditionSince`, not the age of a process or notification row. A replay at the
boundary produces the same result. `Task after 24h`, for example, means
`now - conditionSince >= 24h`.

| Signal kind and condition | Severity | Initial route | Escalation / My Day | Primary actions | Expiry or settlement |
| --- | --- | --- | --- | --- | --- |
| `kidLimitApproaching`: configured warning threshold crossed but below 100%, period still open | `info` (the existing threshold engine's `low` tier) | `informationalNotification` | Never task; not a My Day candidate | Open Finance overview; open Tyrion configuration | Expire at period end; settle if recalculation falls below the threshold |
| `kidLimitExceeded`: at least 100% but below 150% of the configured limit | `medium` | `actionableNotification` | Replace with one task after 24h unresolved; task is a My Day candidate | Open Finance overview; create/open task; open Tyrion configuration | Settle when the period closes or authoritative recalculation is below the limit |
| `kidLimitExceeded`: at least 150% of the configured limit | `high` | `actionableNotification` | Replace with one task after 24h unresolved; task is a My Day candidate | Open Finance overview; create/open task; open Tyrion configuration | Settle when the period closes or authoritative recalculation is below the limit |
| `attributionLikely`: bounded likely assignment that does not require review | `info` | `statusOnly` | Never task | Open Finance overview | Replace or settle on a newer attribution decision |
| `attributionReviewRequired`: ambiguous, conflicting, or unassigned attribution | `medium` | `actionableNotification` | Replace with one task after 24h unresolved; task is a My Day candidate | Review exception; assign/correct, mark parent expense, unassign, resolve, or defer through the versioned action contract; create/open task | Settle on a confirmed attribution decision; supersede on a newer policy/source occurrence |
| `largeTransactionDetected`: eligible open Finance insight occurrence | Producer severity | `informationalNotification` | Never task; never My Day | Open Finance insight detail; open typed Monarch target | Resolve or supersede with the Tyrion occurrence; no new alert when source data is older than 48h |
| `recurringAmountIncreaseDetected`: eligible open Finance insight occurrence | Producer severity | `informationalNotification` | Never task; never My Day | Open Finance insight detail; open typed Monarch recurring target; open source document when present | Resolve or supersede with the Tyrion occurrence; no new alert when source data is older than 48h |
| `varianceMoverVisible`: one medium-confidence category or merchant mover | Producer severity | `statusOnly` | Never task; never My Day | Open Finance insight group; open typed Monarch report target | Resolve or supersede with the Tyrion occurrence; expire when the next closed-period projection replaces it |
| `monthlyVarianceDigestReady`: one closed-period, high-confidence bounded digest | `info` or `medium` | `informationalNotification` | Never task; never My Day | Open Finance insight group; open typed Monarch report target | Expire when replaced by the next digest; medium-confidence movers remain `statusOnly` |
| `duplicateTransactionCandidate`: explainable duplicate requiring judgment | `high` | `actionableNotification` | Replace with one task after 24h unresolved; task is a My Day candidate | Review or resolve exception; open typed Monarch transactions; create/open task | Settle when confirmed distinct, one source record is removed/corrected, or the candidate is superseded |
| `writeBackRetrying`: retryable mutation failure still inside the bounded retry policy | `medium` | `statusOnly` | Never escalate while retries remain | Open Finance review | Settle on successful verification; promote to `writeBackFailed` when retry policy is exhausted |
| `writeBackFailed`: retries exhausted, conflict requires judgment, or resulting Monarch state cannot be verified | `high` | `task` | Immediate My Day candidate | Open Finance review; retry or resolve through the confirmed action contract; open task; open typed Monarch target | Auto-complete when the intended authoritative state is verified; cancel as superseded when a newer confirmed action replaces it |
| `reconciliationInformational`: paid without a captured bill, one-off matched obligation, or other non-action state | `info` | `statusOnly` | Never task | Open reconciliation; open available source records | Replace or settle on the next matcher decision |
| `reconciliationActionRequired`: unmatched obligation with `dueAt - now > 72h` | `medium` | `actionableNotification` | Replace with one task when `dueAt - now <= 72h`; task becomes a My Day candidate on its due date or by user selection | Open reconciliation; review/resolve; create/open task; open typed Monarch and source-document targets | Auto-complete when authoritative evidence confirms payment/match; supersede on rematch |
| `reconciliationActionRequired`: unmatched, not-overdue obligation first observed with `0 < dueAt - now <= 72h`, including exactly 72h | `high` | `task` | Immediate task; it becomes a My Day candidate on its due date or by user selection | Open reconciliation; review/resolve; open task; open typed Monarch and source-document targets | Auto-complete when authoritative evidence confirms payment/match; supersede on rematch |
| `reconciliationMismatch`: duplicate, amount conflict, missing-plus-unpaid, or obligation with `dueAt - now <= 0` | `critical` | `task` | Immediate My Day candidate | Open reconciliation; review/resolve; open task; open typed Monarch and source-document targets | Auto-complete only from authoritative match/payment evidence or a recorded manual resolution |
| `connectorTransientFailure`: degraded with `now - episodeSince < 15m` | `info` | `suppressed` | None | None | Settle silently on recovery; promote to `connectorDegraded` at 15 minutes |
| `connectorDegraded`: unreachable, stale, partial, or degraded with `now - episodeSince >= 15m` | `high` | `actionableNotification` | Replace with one task when `now - episodeSince >= 4h`; task is a My Day candidate | Open Finance settings; open Monarch connector operations; create/open task | Auto-settle on a verified healthy sync; do not infer recovery from process restart |
| `connectorAuthenticationExpired`: verified expired or unauthenticated connector that blocks sync | `critical` | `actionableNotification` | Replace with one task after 4h unresolved; task is a My Day candidate | Open Finance settings; open Monarch connector operations; create/open task | Auto-settle only after authenticated health and a successful bounded sync |
| `weeklyFinanceSummaryReady`: bounded decision summary with no new actionable member | `info` | `informationalNotification` | Never task; never My Day | Open Finance overview | Expire when the next weekly summary is published |

When a summary contains actionable members, each member follows its own row. The
summary links to those existing records and never creates duplicate notifications or
tasks.

### Freshness windows

For one routing decision, age is `decisionAt - sourceAsOf`, where `decisionAt` is the
Mission Control routing service's injected UTC clock and is persisted with the
decision. The ordering must be `sourceAsOf <= evaluatedAt <= decisionAt`, and
`episodeSince <= conditionSince <= evaluatedAt`; a future timestamp or invalid ordering
rejects the envelope. A producer may declare a stricter versioned window, but never a
looser one.

| Signal family | Maximum age for new attention or escalation |
| --- | --- |
| Threshold | 60 minutes |
| Attribution | 24 hours |
| Finance insight anomaly | 48 hours |
| Duplicate candidate | 24 hours |
| Write-back result | 60 minutes from the verified attempt result |
| Reconciliation | 24 hours |
| Connector health | 15 minutes |
| Weekly summary | 24 hours |

Connector transient/degraded duration comes from immutable `episodeSince`; an
authentication-expired stage's 4-hour boundary comes from `conditionSince`. The
15-minute freshness limit applies to the latest health observation, not the start of
the outage. An existing task is preserved with a stale warning when a window is
exceeded, but it cannot escalate, reopen, or execute a source mutation until refreshed.

Every new delivery, replay that could resurface, and escalation reevaluates freshness
against that decision's `decisionAt`. A promptly evaluated envelope cannot be delivered
days later under its original freshness result. Tests inject `decisionAt` explicitly so
the same envelope and decision time always produce the same route.

### Cross-kind transition precedence

Every row in one transition group uses the same `attentionKey` and `occurrenceId`.
Applying a higher-precedence stage atomically settles or updates the lower stage before
delivery. A lower stage cannot reappear unless a new occurrence begins after the prior
one settles.

| Transition group | Highest to lowest precedence |
| --- | --- |
| Kid limit period | `kidLimitExceeded` at 150% or more; `kidLimitExceeded` at 100% or more; `kidLimitApproaching` |
| One write-back attempt | `writeBackFailed`; `writeBackRetrying` |
| One connector outage | `connectorAuthenticationExpired`; `connectorDegraded`; `connectorTransientFailure` |
| One reconciliation occurrence | `reconciliationMismatch`; due-soon `reconciliationActionRequired`; early `reconciliationActionRequired`; `reconciliationInformational` |

The transition is one persistence transaction: update the primary record, preserve its
notification/task linkage and disposition where still applicable, record the new
revision, replace `conditionSince` only when `signalKind` changes, and enqueue at most
the newly selected delivery. `episodeSince` remains unchanged until the occurrence
settles. The transition never inserts a second primary attention record.

## Precedence and idempotency

Mission Control applies these rules in order:

1. Strictly validate contract version, enums, timestamps, lifecycle, provenance, and
   typed targets. Invalid input creates no attention record and emits only a sanitized
   operational failure.
2. Apply `resolved` or `superseded` settlement before considering delivery.
3. Refuse new attention or escalation when freshness is not `fresh`, provenance is
   incomplete, timestamp ordering is invalid, or `decisionAt - sourceAsOf` exceeds the
   source-specific freshness window.
4. Compute the logical key from connector scope, `signalFamily`, `attentionKey`, and
   `occurrenceId`. Compute the activity key by adding `signalKind` and `revision`.
5. Select exactly one row from the matrix and evaluate its inclusive time boundary.
   Elapsed boundaries use `conditionSince`, never process start, first intake, or
   notification creation time.
6. Apply cross-kind precedence in the same transaction. If an open or
   verification-pending task linkage already exists for the logical key, route to that
   task and suppress producer-created finance notifications. If a notification
   escalates, create the task and settle the notification in one transaction.
7. Upsert source state by logical key. Replaying the same activity key cannot duplicate
   or resurface source delivery, but it still reevaluates time-based routing. When the
   selected route changes at a boundary, apply one scheduled transition keyed by
   logical key, target route, and exact boundary timestamp. Replaying that transition
   key is a no-op. A monotonic source revision updates the existing record; it
   resurfaces a dismissed notification only for a material source change defined by
   the producing contract.
8. Persist route, source lifecycle, delivery disposition, task linkage, scheduled
   transition keys, and settlement independently. A failure after persistence is
   retried from the same source activity or scheduled transition key.

Random identifiers, timestamps, display names, amounts, and raw source identifiers are
never dedupe inputs. Multiple connectors are always scoped separately.

## Acknowledgment, snooze, escalation, and settlement

| Event | Notification effect | Task effect | Source effect |
| --- | --- | --- | --- |
| Read | Mark read | None | None |
| Dismiss | Hide from active notification attention | None | None |
| Snooze until a valid future time | Hide until the snooze expires; source settlement during snooze closes it | None | None |
| Create task from actionable notification | Atomically settle the notification as promoted | Create or open the one task for the logical key | None |
| Escalation boundary reached | Atomically settle the notification as promoted | Create the one task and apply My Day candidacy from the matrix | None |
| User completes task before source settlement | Keep the promoted notification settled | Record the user's completion intent and retain the task linkage as `verificationPending`; it remains the sole primary record and suppresses rerouting | None |
| Source resolves | Settle any notification, including snoozed or dismissed | Auto-complete when the resolution confirms the requested result; otherwise cancel as no longer applicable | Preserve source reason and time |
| Source supersedes | Settle old notification | Cancel old task unless the replacement explicitly carries forward the same work; route the replacement independently | Link old occurrence to replacement |
| Freshness becomes stale | Do not create, reopen, or escalate; existing cards show stale state | Keep existing task without silently completing it and block unsafe source actions until refreshed | None |

Automatic settlement is idempotent and records a stable reason such as
`authoritative_state_verified`, `condition_cleared`, `period_closed`,
`source_superseded`, or `connector_recovered`. Settlement never depends only on a
notification click, an HTTP success without verification, or absence from a partial
sync.

## Authorized action registry

Producers return action capabilities and typed target descriptors, not labels, paths,
or URLs. Mission Control maps capabilities to this fixed registry and performs its
normal authorization again when the action is invoked.

| Capability | Visible label | Authorized destination or behavior |
| --- | --- | --- |
| `openFinanceOverview` | Open Finance overview | `/finance` |
| `openFinanceInsight` | Review finance insight | `/finance`, opening the authorized occurrence in the shared insight drawer from an opaque server-side reference |
| `openFinanceInsightGroup` | Open spending insights | `/finance`, focusing the authorized spending-insight group from a bounded server-side selector |
| `markFinanceInsightExpected` | Mark as expected | Protected Tyrion occurrence action with one allowlisted structured reason, expected delivery revision, expected policy version, and idempotency key |
| `markFinanceInsightNotUseful` | Mark as not useful | Protected Tyrion occurrence action with one allowlisted structured reason, expected delivery revision, expected policy version, and idempotency key |
| `suppressFinanceInsight30Days` | Suppress for 30 days | Confirmed protected Tyrion occurrence action with explicit scope/reason, expected delivery revision, expected policy version, and idempotency key; permanent suppression is unavailable |
| `suppressFinanceInsight90Days` | Suppress for 90 days | Confirmed protected Tyrion occurrence action with explicit scope/reason, expected delivery revision, expected policy version, and idempotency key; permanent suppression is unavailable |
| `suppressFinanceInsight180Days` | Suppress for 180 days | Confirmed protected Tyrion occurrence action with explicit scope/reason, expected delivery revision, expected policy version, and idempotency key; permanent suppression is unavailable |
| `undoFinanceInsightSuppression` | Undo suppression | Confirmed protected Tyrion occurrence action with the authorized opaque suppression reference, expected delivery revision, expected policy version, and idempotency key |
| `openFinanceReview` | Review finance exception | `/finance/review`, selecting an authorized opaque exception reference server-side |
| `resolveFinanceException` | Resolve finance exception | Versioned, confirmed exception action; return to `/finance/review` with success or a sanitized actionable error |
| `openFinanceReconciliation` | Open reconciliation | `/finance/reconciliation`, selecting an authorized opaque match reference server-side |
| `resolveFinanceReconciliation` | Resolve reconciliation item | Versioned, confirmed reconciliation action; return to `/finance/reconciliation` with success or a sanitized actionable error |
| `openFinanceSettings` | Open Finance settings | `/finance/settings` |
| `createFinanceTask` | Create follow-up task | Idempotently create the one task for the logical signal key, then open it |
| `openFinanceTask` | Open follow-up task | Existing authorized Mission Control task |
| `openMonarch` | Continue in Monarch | Server-built allowlisted transaction, recurring, report/filter, or safe-root target |
| `openTyrionConfiguration` | Open Tyrion configuration | Authorized Tyrion operations/configuration UI `/configuration`; connector setup uses its root operations page |
| `openMonarchConnectorOperations` | Open Monarch connector operations | Authorized Tyrion operations/configuration UI root |
| `openSourceDocument` | Open source document | Server-built allowlisted document-system target |

Missing, unsupported, stale, or unauthorized targets omit the action. They never
degrade to a producer-provided URL. A safe Monarch root may replace an unsupported
entity target; document targets have no cross-system fallback.

Confirmed mutations expose pending, succeeded, conflicted, failed, and verification
states. They use stable sanitized errors, preserve audit/provenance, and never print or
return raw upstream payloads. Mission Control maps Tyrion's occurrence
`availableActions` values (`expected`, `notUseful`, `suppress30Days`,
`suppress90Days`, `suppress180Days`, and `undoSuppression`) only to their corresponding
registry capability above; unavailable actions are omitted. Insight feedback and
suppression never create a task or imply notification/source settlement.

## Accessible action behavior

- Actions use the visible labels in the registry rather than ambiguous text such as
  "Open" or icon-only controls. External actions identify Monarch, Tyrion
  configuration, or the source document system in their accessible name.
- State and severity always have text in addition to color or iconography.
- Controls are keyboard reachable, have visible focus, and provide at least a
  44-by-44 CSS-pixel target. Menu and dialog focus returns to the invoking control.
- Confirmation dialogs name the action and affected finance exception without placing
  private values in page titles, browser history, analytics, or live regions.
- Async actions announce pending and final status through an appropriate live region,
  disable duplicate submission while pending, and move focus to the error summary
  when recovery requires input.
- Unsupported actions are omitted rather than rendered as disabled controls with no
  explanation. Temporarily unavailable actions show the freshness or connector state
  and a safe recovery action.
- Narrow layouts preserve the primary action before secondary deep links. Every action
  available in desktop notification/detail views remains reachable on mobile.

## Implementation ownership

| Owner | Required implementation |
| --- | --- |
| Tyrion signal producers | Stable occurrence identity, source lifecycle, policy/matcher versions, complete provenance, freshness, typed capabilities/targets, and deterministic settlement reasons |
| Mission Control routing service | Strict envelope parser, matrix selection, dedupe, notification/task mutual exclusion, escalation, settlement reconciliation, and transactional linkage |
| Mission Control presentation | Notification, task, My Day, `/finance` status, accessible actions, and authorized target resolution |
| Mission Control connector registry | Keep `FinanceManagerConnector.notificationOnly` and exclude every Finance connector alias from generic task destinations |
| Mission Control notification provider and template registry | Omit and reject generic `create_task` actions for every Finance provider/template alias |
| Monarch Bridge | Normalized source transport and verified connector health only; no routing, task, notification, or browser action contract |
| Tyrion operations/configuration UI | Policy and connector configuration destinations only; no daily attention inbox |
| Monarch and document systems | Authoritative finance and source-document workflows reached only through allowlisted typed links |

Implementations should fixture-test every matrix row, exact escalation boundary,
replay/restart/concurrency dedupe, notification-to-task promotion, stale-data refusal,
resolution during snooze, source supersession, safe target omission/fallback, task/My
Day mutual consistency, and keyboard/focus/live-region behavior.
