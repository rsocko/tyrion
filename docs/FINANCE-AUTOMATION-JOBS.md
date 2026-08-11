# Finance Automation Jobs

Issue #162 adds two Tyrion-private scheduled evaluations to `finance-insights/`:

- `duplicateTransactions` identifies bounded duplicate candidates from a complete,
  fresh normalized Monarch source generation.
- `connectorHealth` turns normalized connector observations and sync freshness into
  attention, and settles that attention only after a newer healthy observation.

These jobs do not create Monarch sessions, call Monarch, expose raw upstream
responses, or add browser routes. They also add no HTTP or other cross-process
transport route: the handler is currently an internal package contract and cannot be
invoked by an external Mission Control scheduler until a separate protected transport
is approved and implemented. A trusted in-process worker supplies normalized Bridge
facts and observations, a stable 32-byte identity key, an absolute external SQLite
path, and the durable schedule time.

## Durable run and signal semantics

`FinanceAutomationJobServiceV1` derives a keyed run identity from job kind,
connector reference, and `scheduledFor`. The SQLite store commits the run, signal
lifecycle changes, and versioned delivery outbox in one immediate transaction.

- Replaying the same scheduled input returns the stored result with
  `replayed: true` and any unacknowledged outbox delivery. After the consumer
  acknowledges its exact delivery version, replay returns no delivery.
- Reusing a run identity with different input fails with
  `automation_idempotency_conflict`.
- A later run reuses stable signal identities. Unchanged open conditions do not
  enqueue a new delivery version, while an unacknowledged version remains available
  for at-least-once delivery.
- An undelivered `create` coalesces later revisions into a latest-state `create`.
  Recovery before its acknowledgement replaces it with a versioned, idempotent
  compensating `settle`, so an in-flight create cannot leave orphaned attention.
- Fresh authoritative recovery emits one `settle` delivery and records the signal
  as settled. Stale, partial, unavailable, or out-of-order input cannot settle prior
  reliable attention.
- Runtime state belongs at an absolute path outside the repository. The store applies
  restrictive POSIX modes where the platform supports them.

## Duplicate-candidate evaluation

The detector first applies the versioned Finance Insights transaction
classification. Pending items, transfers, income, refunds, unclassified credits,
known recurring items, and policy exclusions are not candidates.

Remaining posted-spend facts must have the same account, exact minor-unit amount,
normalized merchant identity, and a date gap within the configured zero-to-seven-day
window. Same-day matches are high-confidence actionable signals; adjacent-date
matches are medium-confidence informational signals. Both deliver only through the
Finance notification provider. Evidence is deliberately bounded to match booleans,
date gap, and two opaque source references.

Trusted connector normalization may provide up to 500 explicit pair suppressions
with reason `expectedDuplicate` or `connectorRetry`. Output is capped at 100
candidates. If the configured cap is reached, existing omitted signals are not
settled from that incomplete comparison. A complete request must supply exactly the
declared number of uniquely referenced transaction facts within generation coverage.
Older source sequences cannot change or settle signals created from a newer
generation. A newer rolling generation settles only candidates whose original
transaction dates remain inside its authoritative coverage window.

## Connector-health evaluation

Health observations contain only bounded normalized metadata: reported state,
observation time, last successful sync time, consecutive failure count, and Bridge
contract version. A failure never substitutes its observation time for
`sourceAsOf`; provenance continues to report the last successful sync.

- Degraded or stale state is informational.
- Unavailable state or the configured repeated-failure threshold is actionable.
- Both dispositions emit only notification deliveries from this handler. After a
  protected transport exists, Mission Control's normative routing layer may project
  persistent actionable non-insight duplicate or health signals into tasks; #162
  does not emit those task deliveries itself.
- An older or conflicting equal-time observation is recorded as an ignored run and
  cannot change signal state.
- A newer connected observation with fresh sync data settles prior attention.

The store keeps the greatest observed successful-sync timestamp for connector state,
so later failures cannot advance or regress the internal freshness watermark.

## Worker integration

An eventual trusted in-process worker remains the owner of cadence, retries, and
process supervision. #162 does not itself make these steps available across process
boundaries. For each durable schedule:

1. Load only normalized facts through the protected Bridge/source-generation
   contract.
2. Set `scheduledFor` to the durable schedule instant, not the retry instant.
3. Run the service with the stable external state path and stable identity key.
4. Apply returned `create`, `update`, and `settle` deliveries idempotently by
   `deliveryKey` and `version`.
5. Call `acknowledgeDeliveries` with the applied key and exact version. A stale
   acknowledgement conflicts rather than clearing a newer outbox action.
6. Do not log requests, signals, source references, amounts, merchant names, state
   paths, upstream errors, or delivery payloads. Metadata-only counts and stable
   error codes are sufficient for operations.

Deterministic coverage is in
`finance-insights/tests/automation-jobs-v1.test.ts`.
