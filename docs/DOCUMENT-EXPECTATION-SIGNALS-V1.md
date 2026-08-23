# Document Expectation Signals v1

`DocumentExpectationSignalsV1` is Tyrion's read-only projection for OWL.
It provides bounded evidence that a correspondent series may recur. It does not claim
that a statement, invoice, receipt, bill, or other document exists.

## Endpoint and trust boundary

```http
GET /api/internal/v1/finance/insights/document-expectation-signals/{sourceGeneration}?connectorRef={connectorRef}
GET /api/connector/v1/document-expectation-signals/{sourceGeneration}?connectorRef={connectorRef}
```

The private route retains the Finance Insights internal authority check. The public
HTTPS route uses the connector gateway's existing `BRIDGE_API_TOKEN` bearer
authentication and browser-origin rejection. Both routes call the same Finance
Insights read projection and read rollout gate; the public route does not proxy this
operation to Monarch Bridge. Neither route is a browser route, mutation, webhook, or
push feed. Callers pull one immutable committed generation. An unknown, staging,
rejected, or expired generation returns a stable not-found error rather than current
or partial data.

The request is generation-addressable and idempotent: repeated reads of the same
`connectorRef` and `sourceGeneration` return the same projection while that committed
generation remains retained.

## Response

```json
{
  "contractVersion": "1",
  "connectorRef": "invented-connector",
  "sourceGeneration": "invented-generation-42",
  "sourceAsOf": "2026-08-23T12:00:00Z",
  "completeness": "complete",
  "signals": [
    {
      "seriesRef": "expectation-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "kind": "accountStatementCandidate",
      "active": true,
      "displayHint": "Credit account",
      "cadence": null,
      "nextExpectedDate": null,
      "confidence": 0.6,
      "basis": ["active_non_cash_account"]
    }
  ]
}
```

The envelope is versioned independently from the finance-insight ingestion contract.
`completeness` supports `complete` and `partial`; this endpoint currently publishes
only `complete` committed generations. OWL must not interpret omissions from a
`partial` projection as deactivation.

## Candidate rules

- Each non-cash account source fact produces one `accountStatementCandidate`.
  This is advisory inventory evidence (`confidence: 0.60`,
  `active_non_cash_account`), not evidence that an account emits documents.
- Each outgoing recurring source fact produces one `recurringDocumentCandidate`
  (`confidence: 0.60`). Positive recurring amounts are income and are excluded;
  recurring income is never projected as a bill candidate.
  A null amount preserves an obligation classification already committed for the same
  connector-scoped source series; a first-seen null amount remains unclassified and is
  excluded. The classification is frozen per committed generation, so late historical
  publication cannot change an earlier response. Amount, cadence, next date, category,
  and account references are not emitted.
- Inactive source facts remain visible with `active: false` and the corresponding
  `inactive_non_cash_account` or `inactive_recurring_obligation` basis. This reports
  source deactivation; it never instructs OWL to delete confirmed policy or prior
  evidence.
- Complete-snapshot omission may also let OWL mark a previously projected candidate
  inactive locally. OWL remains responsible for preserving confirmed policy.

`confidence` describes only Tyrion's confidence in the bounded source classification.
It is not document-existence probability, review importance, or a deadline signal.
Neither candidate kind establishes document existence, cadence, availability,
importance, or a missing-document deadline. `cadence` and `nextExpectedDate` are
required `null` compatibility placeholders for OWL PR #86, not a Tyrion-owned calendar
schema. OWL derives any document cadence or calendar policy from Paperless evidence and
explicit review.

## Identity, ordering, and bounds

`seriesRef` is a stable, OWL-scoped opaque digest derived with a versioned non-secret
namespace from the connector reference, source kind, and source reference. Raw account
and recurring identifiers are never returned. Distinct source accounts receive
distinct series references even when they share an institution. Series references
remain stable across source generations but change when connector scope changes.

OWL must use `connectorRef`, `seriesRef`, and `kind` for reconciliation, fingerprint
suppression, and durable negative decisions. It must never join on `displayHint`.
Display or activity changes therefore do not invalidate a dismissal or `not_expected`
decision. Tyrion does not map accounts to Paperless correspondents: same-institution
accounts remain separate, and ambiguous mappings remain in OWL review.

Signals are sorted by `seriesRef` using deterministic ordinal ordering. A response is
bounded to 6,000 signals: at most 1,000 account facts plus 5,000 recurring facts, the
same fail-closed limits enforced during source publication. The endpoint has a
dedicated 12 MiB serialized-response ceiling so every valid maximum projection remains
returnable without raising the tighter limit used by other finance-insight responses.

Every signal includes its required lifecycle reason code in `basis`. Additional bounded
reason codes may be added without changing identity; consumers must ignore unknown
reason codes they do not use.

## Data exclusions

The projection excludes balances, amounts, transactions, notes, credentials,
authorization values, cookies, session material, URLs, ownership, document content,
raw upstream responses, raw account identifiers, and raw recurring identifiers.
Account display hints contain only normalized account type. Recurring display hints
use the generic `Recurring expense` label and never contain merchant or recurring-item
display text.
