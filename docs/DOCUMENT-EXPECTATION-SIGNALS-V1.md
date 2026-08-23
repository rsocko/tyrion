# Document Expectation Signals v1

`DocumentExpectationSignalsV1` is Tyrion's private, read-only projection for OWL.
It provides bounded evidence that a correspondent series may recur. It does not claim
that a statement, invoice, receipt, bill, or other document exists.

## Endpoint and trust boundary

```http
GET /api/internal/v1/finance/insights/document-expectation-signals/{sourceGeneration}?connectorRef={connectorRef}
```

The endpoint uses the existing finance-insight private authority, bearer
authentication, browser-origin rejection, and read rollout gate. It is not a Monarch
Bridge operation, connector-gateway route, browser route, mutation, webhook, or push
feed. Callers pull one immutable committed generation. An unknown, staging, rejected,
or expired generation returns a stable not-found error rather than current or partial
data.

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
      "confidence": 0.85,
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
  Active account existence is intentionally high-signal correspondent-recurrence
  evidence (`confidence: 0.85`, `active_non_cash_account`), but cadence and next
  expected date remain `null`.
- Each outgoing recurring source fact produces one `recurringDocumentCandidate`
  (`confidence: 0.90`). Positive recurring amounts are income and are excluded.
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

## Identity, ordering, and bounds

`seriesRef` is a stable, OWL-scoped opaque HMAC derived from the connector reference,
source kind, and source reference. Raw account and recurring identifiers are never
returned. Distinct source accounts receive distinct series references even when they
share an institution. Series references remain stable across source generations but
change when connector scope changes.

Signals are sorted by `seriesRef` using deterministic ordinal ordering. A response is
bounded to 6,000 signals: at most 1,000 account facts plus 5,000 recurring facts, the
same fail-closed limits enforced during source publication.

## Data exclusions

The projection excludes balances, amounts, transactions, notes, credentials,
authorization values, cookies, session material, URLs, ownership, document content,
raw upstream responses, raw account identifiers, and raw recurring identifiers.
Account display hints contain only normalized account type. Recurring display hints
contain only the already bounded normalized recurring display name.
