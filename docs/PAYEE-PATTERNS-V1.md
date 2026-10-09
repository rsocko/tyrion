# Payee Patterns v1

`PayeePatternProjectionV1` is Tyrion's privacy-bounded, read-only financial-pattern
projection for Mission Control and OWL review. Monarch remains canonical for
transactions, merchant metadata, and user-confirmed recurring streams. Tyrion does
not write inferred classifications back to Monarch.

## Endpoint and trust boundary

```http
GET /api/internal/v1/finance/insights/payee-patterns/{sourceGeneration}?connectorRef={connectorRef}
GET /api/connector/v1/payee-patterns/{sourceGeneration}?connectorRef={connectorRef}
```

Both routes require the existing server-only bearer credential. The internal route
also retains the fixed private-authority check; the connector gateway rejects browser
requests. The route reads one immutable committed Finance Insights source generation.
That generation must contain the bounded normalized Monarch transaction history and
recurring snapshot. There is no browser route, mutation, automatic Monarch write-back,
or arbitrary upstream passthrough.

This is a separate projection from `DocumentExpectationSignalsV1`. Financial
recurrence says that payments to a payee form a pattern; it does not establish that a
statement, invoice, receipt, or other document exists or should arrive. The existing
document-expectation contract and endpoints are unchanged.

## Response

```json
{
  "contractVersion": "1",
  "connectorRef": "invented-connector",
  "sourceGeneration": "invented-generation-42",
  "sourceAsOf": "2026-07-31T12:00:00Z",
  "completeness": "complete",
  "payees": [
    {
      "payeeRef": "payee-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "displayName": "Invented Utility",
      "activity": "active",
      "classification": "recurring-fixed",
      "observationCount": 3,
      "observationWindow": {
        "firstObservedOn": "2026-05-01",
        "lastObservedOn": "2026-07-01"
      },
      "intervalEvidence": {
        "sampleCount": 2,
        "medianDays": 31,
        "minimumDays": 30,
        "maximumDays": 31
      },
      "confidence": 0.95,
      "basis": [
        "monarch_confirmed_recurring",
        "bounded_amount_variation"
      ],
      "provenance": {
        "transactionHistory": true,
        "monarchRecurring": true
      },
      "monarchConfirmedRecurring": {
        "active": true,
        "cadence": "monthly"
      }
    }
  ]
}
```

## Classification

Tyrion groups posted observations by the canonical normalized merchant name supplied
through the Bridge contract. It emits one opaque `payeeRef` per connector-scoped
canonical payee and sorts records by that reference.

- A matching Monarch recurring stream, or a transaction carrying Monarch recurring
  membership, is `recurring-fixed` when observed absolute amounts remain within the
  bounded 5% or one-currency-unit tolerance; otherwise it is
  `recurring-variable`.
- Three or more observations with interval spread no greater than seven days or 35%
  of the median interval are `regular`.
- An unconfirmed series with a median interval of at least 60 days is `infrequent`.
- One posted observation is `single-observation`.
- Other evidence is `unknown`.

`confidence` is confidence in this financial-pattern classification only. Activity is
`active` when the latest observation is within the greater of 90 days or twice the
median interval, `inactive` when it is older, and `unknown` when the snapshot predates
the latest observation. These deterministic rules are explainable advisory evidence,
not authoritative recurring configuration.

## Privacy and compatibility

The response includes a bounded display name, dates delimiting the observation
window, aggregate interval evidence, classification, confidence, reason codes, and
bounded Monarch recurring status/cadence. It excludes transactions, raw Monarch
identifiers, source references, amounts, categories, accounts, tags, notes,
credentials, authorization values, cookies, session material, raw responses, and
upstream URLs.

Payee identity is an opaque versioned digest scoped by identity namespace, connector,
and canonical normalized merchant name. Display names are never join keys. Merchant
renames intentionally create a new identity because the normalized Bridge v1
transaction fact does not expose a stable merchant identifier; Tyrion does not guess
across editable Monarch metadata.

The projection is bounded to 10,000 payees and uses the existing 12 MiB projection
response ceiling. If a valid source generation contains more distinct posted payees,
Tyrion selects the first 10,000 by opaque payee reference and returns
`completeness: "partial"`; consumers must not interpret an omitted payee as inactive.
A transaction's recurring reference is resolved against the recurring snapshot before
display-name matching. When transaction membership proves a Monarch recurring
relationship but the referenced stream is absent from the snapshot, the evidence uses
`active: null` and `cadence: "unknown"` rather than inventing lifecycle state.
Consumers must ignore unknown additive `basis` codes. Any
incompatible field or semantic change requires a new projection version.
