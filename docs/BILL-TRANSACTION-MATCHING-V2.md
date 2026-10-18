# Bill-to-Transaction Matching v2

## Purpose and compatibility

Bill Matching v2 is the on-demand Tyrion contract for OWL's **Check for payment**
command. It uses the existing deterministic Bill Matching v1 scorer and adds the
actual normalized candidate values needed for an OWL or Mission Control decision.
It does not settle an OWL obligation, retain a relationship, or replace Monarch as
transaction authority.

`contractVersion: "1.0"` remains unchanged. V2 uses the same protected endpoint:

```text
POST /api/connector/v1/bill-matches
Authorization: ****** finance-manager credential>
Content-Type: application/json
```

The connector authentication, browser rejection, no-store response, 1 KiB request
bound, sanitized errors, and single-household scope documented for v1 also apply.

## Account search scope

V2 accepts only `accountScope: "configuredEligible"`. The caller cannot provide an
account identifier. The literal is retained as part of the existing v2 request
contract; account scope is owned entirely by Tyrion.

Tyrion loads the normalized Bridge account catalog and searches every account by
default. Operators may exclude specific accounts in **Settings → Bill matching**.
Those exclusions are stored in Tyrion's versioned household policy. An empty
exclusion set means all catalog accounts, including inactive accounts that may still
contain historical payments, are searched. Tyrion performs one bounded query per
included account with bounded concurrency. Account references remain server-side and
are never returned in bill-matching responses.

Bill Matching v2 has no account-scope environment setting. During deployment
upgrades, remove `TYRION_BILL_MATCH_ELIGIBLE_ACCOUNT_REFS`; no replacement variable
is needed. Existing policy stores migrate to an empty exclusion set.

## Request

```json
{
  "contractVersion": "2.0",
  "requestRef": "payment-check-example-1",
  "billRef": "bill-example-2026-08",
  "payee": "Example Utility Company",
  "expectedAmountMinor": 12345,
  "currency": "USD",
  "dueDate": "2026-08-15",
  "billDate": "2026-08-01",
  "reference": "statement-reference",
  "accountScope": "configuredEligible",
  "dateWindowDays": 7,
  "amountToleranceMinor": 250,
  "candidateLimit": 5,
  "receiptEvidence": {
    "transactionRef": "transaction-example-payment",
    "observedAt": "2026-08-16T12:00:00.000Z"
  }
}
```

Unknown fields are rejected. `requestRef` and `billRef` are caller-owned opaque
references. `dueDate` and `billDate` are optional individually, but at least one is
required; `dueDate` is the scoring anchor when both are present. It is not a search
cutoff. V2 searches through the current check date so late payments remain eligible.
The search begins at `billDate - dateWindowDays` when a bill date is available,
otherwise at `dueDate - dateWindowDays`, and is capped to the Bridge's 366-day
inclusive range. `reference` is bounded caller context and is not a ranking signal.
Amount, currency, tolerance, and candidate limits use the v1 bounds.

`receiptEvidence` is optional supporting evidence from the bounded receipt workflow.
It is not added to the numeric score and is never proof that the obligation is
complete.

## Response

```json
{
  "contractVersion": "2.0",
  "requestRef": "payment-check-example-1",
  "billRef": "bill-example-2026-08",
  "matchStatus": "matched",
  "paymentStatus": "paid",
  "selectedTransactionRef": "transaction-example-payment",
  "candidates": [
    {
      "rank": 1,
      "transactionRef": "transaction-example-payment",
      "transactionDate": "2026-08-15",
      "transactionState": "posted",
      "payee": "Example Utility Company",
      "amountMinor": 12345,
      "currency": "USD",
      "accountDisplayName": "Household Checking",
      "accountLastFour": "4321",
      "scoreBasisPoints": 10000,
      "confidence": "high",
      "scoreGapBasisPoints": null,
      "signals": [
        {
          "kind": "amount",
          "strength": "exact",
          "contributionBasisPoints": 5500
        },
        {
          "kind": "date",
          "strength": "exact",
          "contributionBasisPoints": 2500
        },
        {
          "kind": "payee",
          "strength": "exact",
          "contributionBasisPoints": 1500
        },
        {
          "kind": "account",
          "strength": "notProvided",
          "contributionBasisPoints": 500
        }
      ],
      "receiptAssociation": {
        "status": "linked",
        "observedAt": "2026-08-16T12:00:00.000Z"
      }
    }
  ],
  "searchContext": {
    "anchorDate": "2026-08-15",
    "windowStart": "2026-08-08",
    "windowEnd": "2026-08-22",
    "dateWindowDays": 7,
    "amountToleranceMinor": 250,
    "sourceAsOf": "2026-08-16T12:01:00.000Z",
    "searchedAt": "2026-08-16T12:01:01.000Z",
    "eligibleAccountCount": 1,
    "candidatePoolSize": 1
  }
}
```

Candidate values come from the normalized Bridge transaction DTO rather than the bill:

- `payee`, `amountMinor`, `transactionDate`, and `transactionState` are actual
  transaction values.
- `currency` is the authoritative Tyrion household currency. Bridge v1 is
  single-currency and does not repeat currency on each transaction.
- `accountDisplayName` and nullable `accountLastFour` are normalized display values.
  No raw account identifier is returned.
- `rank`, `scoreGapBasisPoints`, score, confidence, and the four v1 signals explain
  ordering. The last returned candidate has a null score gap.
- `receiptAssociation` is present only when receipt evidence was supplied and says
  whether that evidence references this candidate. It does not alter ranking.

`matchStatus` and `paymentStatus` retain the exact v1 meanings:

| Match | Payment | Meaning |
| --- | --- | --- |
| `matched` | `paid` | One decisive posted candidate. |
| `matched` | `pending` | One decisive pending candidate. |
| `noMatch` | `unmatched` | No candidate reaches the v1 threshold. |
| `ambiguous` | `ambiguous` | The top qualifying candidates are within the v1 ambiguity gap. |

OWL owns mapping this evidence into its richer obligation outcomes, including partial
payment, staleness, conflict, or possible double payment. Tyrion does not infer those
states from a single search.

## Freshness and failure behavior

`sourceAsOf` is the oldest Bridge `provenance.fetchedAt` value across the included
account queries, so consumers can make a conservative freshness decision.
`searchedAt` is when Tyrion assembled the response. `windowEnd` is always the current
UTC check date; a future due date remains only a scoring anchor and cannot move the
search window forward or exclude an already-submitted payment. The exact bounded
search window, tolerance, eligible-account count, and pre-limit candidate pool size
are included.

V2 preserves all v1 failure codes and adds:

| Status | Stable code | Meaning |
| ---: | --- | --- |
| 502 | `invalid_bill_match_account_catalog` | The normalized Bridge account catalog failed contract validation. |
| 503 | `bill_match_account_catalog_unavailable` | The normalized Bridge account catalog could not be loaded. |
| 503 | `bill_match_configuration_unavailable` | Tyrion's persisted household configuration could not be loaded. |

Any included-account query failure fails the whole request. Malformed account display
data, unexpected account leakage, conflicting duplicate transactions, incomplete
pages, or invalid provenance fail closed without returning upstream bodies or
exception text.
