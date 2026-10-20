# Durable attribution and Monarch tags

Tyrion owns attribution decisions, normalized decision facts, provenance, action
history, stable source identity mappings, and recoverable Monarch tag projection.
Mission Control owns the review interaction and its delivery outbox, not a second
attribution authority. Monarch remains the transaction system of record. This does
not introduce an all-transactions view or an authoritative copy of the ledger.

## Deployment

The operations container requires `TYRION_ATTRIBUTION_STORE_PATH`, an absolute file
outside every checkout. Homelab Compose mounts the named `tyrion-attribution` volume
at `/var/lib/tyrion-attribution`; the image provisions it for its non-root user.
The store is a versioned, bounded (64 MiB), atomic-replacement journal, protected by
cross-process locks and owner-only POSIX permissions. Back up this volume with the
policy volume as private household data. Capacity, corruption, contention and
configuration failures fail closed with sanitized service errors. Never put a copy
in Git, CI artifacts, logs or fixtures. Storage is not disposable cache.

`TYRION_REATTRIBUTION_URL` and its HTTP repository facades are no longer production
dependencies. Existing state previously held by an external adapter is **not**
automatically migrated. Register existing Mission Control facts/manual decisions
through the protected contract before enabling corrections. Review existing
externally managed Kid tags explicitly; do not delete or automatically adopt them.
No deployment or live finance mutation is authorized by the code change.

Deploy Tyrion with the volume before enabling the matching Mission Control client.
Historical catch-up follows Mission Control's configured sync window (90 days by
default, at most 365); older transactions need a separately scoped backfill. This
change does not silently sweep the full ledger or authorize a broader transaction UI.

## Protected protocol

All routes use the existing private authority `tyrion-operations-ui:3000`, server-only
finance-manager bearer credential, fixed `homelab-household` scope and
`mission-control-finance-manager` actor. Public/forwarded authorities and browser
origins are rejected. There is no public connector passthrough for attribution.
Bodies are JSON, bounded to 64 KiB; responses are `Cache-Control: no-store`.
The existing v2 policy discovery and stateless batch endpoints are unchanged.

### Register or refresh a transaction's attribution facts

`POST /api/internal/v2/attribution/records`:

```json
{
  "contractVersion": "2.1",
  "provenance": "mission-control-normalized-v3",
  "expectedPolicyVersion": 1,
  "expectedStateVersion": null,
  "transactionId": "synthetic-upstream-id",
  "item": {
    "sourceRef": "synthetic-opaque-consumer-ref",
    "occurredOn": "2026-10-20",
    "merchantName": "Invented Merchant",
    "businessEntityName": null,
    "statementDescriptors": [],
    "locationEvidence": null,
    "accountRef": "synthetic-direct-bridge-account-ref",
    "observedAt": "2026-10-20T12:00:00Z",
    "existingManualDecision": null
  }
}
```

`item` is the existing normalized batch item, not a Bridge payload. No amounts,
notes, categories, tags or raw upstream objects are accepted. The separate
`transactionId` is the actual Bridge/Monarch transaction identity, not Mission
Control's opaque `sourceRef`. The immutable one-to-one mapping is private Tyrion
state and is resolved server-side before every Bridge transaction read/write.

`expectedStateVersion: null` is create-only bootstrap: an existing matching source
mapping returns its current decision unchanged. A positive version permits a
compare-and-swap fact refresh. Unchanged normalized transaction facts, manual
decision and policy do not increment the version (observation time alone is not a
decision change). Changed facts are evaluated by Tyrion, never accepted as a
caller-computed result. Tyrion's saved manual decision always wins over refreshed
caller manual context. An initial legacy `existingManualDecision` is imported,
retained with its decision time and authenticated service provenance, and projected.

Response: `{contractVersion:"2.1", record, projection}`. `record` is
`AttributionActionRecordV1`: `{input, attribution, stateVersion, exception,
lastAction}`. `input` retains normalized merchant/business/descriptor/location,
account reference, date, observation, and manual-decision facts; it is not a
transaction ledger snapshot. `attribution` is the existing v2.1 result including
decision source, policy/engine versions, rule references and evaluation time.
`exception` contains status, reasons, deferral and update time. Every changed record
is journaled together with its audit snapshot and projection-pending intent.
Confirmed manual and definite automatic kid assignments project immediately;
ambiguous/unassigned automated results do not invent a confirmed kid.
Definite automated parent/shared outcomes project an empty managed set. If refreshed
facts no longer confirm a formerly projected kid, the current projection becomes
`pending` until an explicit decision; old tags are not silently presented as current
projected success or removed by guessing. A retry cannot turn ambiguous evidence
into a confirmed decision.

### Correct, confirm, parent/shared, unassign, or defer

`POST /api/internal/v2/attribution/actions` retains its existing strict schema:

```json
{
  "contractVersion": "2.1",
  "provenance": "mission-control-normalized-v2",
  "sourceRef": "synthetic-opaque-consumer-ref",
  "expectedPolicyVersion": 1,
  "expectedStateVersion": 1,
  "idempotencyKey": "synthetic-action-receipt",
  "confirm": true,
  "action": "assign-kid",
  "kidId": "synthetic-kid"
}
```

Actions: `assign-kid` (requires `kidId`), `mark-parent-expense` (parent/shared
household expense; removes only Tyrion-managed Kid tags), `unassign`,
`resolve-exception` (confirms the current eligible candidate), and
`defer-exception` (requires bounded future `deferUntil`, no tag mutation).
`explain` accepts only the common version/provenance/source/policy/action fields
and is read-only. No caller identity/permission claims are accepted.

The action response retains its bounded existing fields (no input facts) and adds
`projection`. Audit includes authenticated actor, action reference/idempotency key,
previous/new state versions, policy version, application time and applied/replayed
outcome. The full history and exact original request fingerprint survive restart.

An exact action replay returns the original action receipt/version and **current**
projection; it never reprojects an old decision over a newer decision. Exact
committed replay remains possible after policy advances. Reuse with a different
payload returns `409 idempotency_conflict`. New writes require current policy and
state versions. Stale state/mapping returns `409 attribution_state_conflict`; stale
policy returns `409 policy_conflict`. A rejected CAS creates no replay receipt.

Mission Control must atomically reserve its local CAS/audit and exact remote request
before dispatch, block superseding local decisions while delivery is pending, and
retry the **same** payload/key after timeouts. Only after an authenticated,
deterministic stale-state/policy rejection may it re-read current state, confirm
the local decision is still latest, and rebase its reserved request. Never rebase
an uncertain timeout or overwrite an idempotency conflict.

### Projection status and recovery

`POST /api/internal/v2/attribution/projection`:

```json
{
  "contractVersion": "2.1",
  "sourceRef": "synthetic-opaque-consumer-ref",
  "action": "status",
  "expectedStateVersion": 2
}
```

`status` is read-only; `retry` attempts the current saved decision. Both require
the exact current state version and return `{contractVersion:"2.1",record,projection}`.

`projection` is null when none is needed/has been attempted, otherwise:
`{sourceRef, decisionVersion, kidIds, managedTagIds, status, errorCode, updatedAt}`.
Status is `pending`, `projected`, `failed`, or `drift`. On these durable routes,
`decisionVersion` is a **string**: `state:` followed by the positive record state
version zero-padded to 16 decimal digits (for example `state:0000000000000002`).
Consumers compare the token against the current record version, not an evaluation
timestamp. A replay receipt can predate the live projection: read current state and
verify that its manual decision still matches the latest local action before
accepting the newer projection.
Error codes are `kid_tag_collision`, `kid_tag_mapping_deleted`,
`kid_not_projectable`, `transaction_tag_drift`, `tag_projection_unavailable`,
or `tag_projection_unverified`.

The decision/audit/replay/outbox commit **precedes** Monarch access. A subsequent
Monarch failure returns HTTP 200 with the saved decision and explicit failed/drift
projection, not an apparent rollback. Mission Control must show "decision saved,
tag update pending/failed", retain its durable delivery receipt, and reconcile it
on sync/retry. A transport/storage failure before the response is uncertain: retry
the exact original action before reporting completion. Retry work survives process
restart; Mission Control's sync outbox is the retry driver (there is no timer daemon
or unbounded automatic retry loop in Tyrion).

Cross-process projection leases serialize tag catalog creation and read/replace.
Stable mappings use kid IDs, not display labels. Unrelated Monarch tags are always
preserved; writes supply the complete previously read tag set and verify read-back.
Last verified managed tags are retained separately across failed attempts. Real
drift, deleted mappings and pre-existing label collisions require explicit operator
reconciliation; retries/new decisions never silently clear drift. Managed tags are
output only and never become attribution evidence or historical inference input.

Re-attribution previews bind the state versions observed when source facts were
loaded, not versions sampled after evaluation. Saving/applying a stale preview
fails closed; `reattribution_state_conflict` requires a fresh preview. Production
preview/apply also share the projection lease with action and fact refresh.

## Monarch capability and user prerequisites

Pinned `monarchmoneycommunity==1.6.0` exposes `get_transaction_tags()`,
`create_transaction_tag(name, color)`, and
`set_transaction_tags(transaction_id, tag_ids)`. Bridge list/create/replace DTOs
already normalize and verify these operations; fixture-based tests exercise exact
calls and read-back. Normal operation needs **no manually pre-created tag**:
Tyrion creates `Kid: <display name>` lazily and retains stable mappings.
The pinned client exposes no supported catalog rename/update/delete operation;
profile renames create replacement managed tags and retain retired tag identities.
Do not confuse transaction tag-set updates (supported) with catalog metadata edits.
Pre-existing colliding labels, external renames/deletions and drift require manual
reconciliation rather than unsafe adoption or duplicate creation.

These are deterministic capability findings, not newly observed live compatibility.
No live credentials, session, production transaction or tag mutation is needed for
development or validation. Existing separately gated live tests remain opt-in.
