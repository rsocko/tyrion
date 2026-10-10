# Bill-to-Transaction Matching v1

## Ownership and purpose

Tyrion owns deterministic matching between one normalized bill expectation and
normalized Monarch transactions. OWL/Document Intelligence owns document ingestion,
extraction, source-document retention, and normalization into this request. Mission
Control owns presentation, review, and workflow state. Monarch remains the financial
system of record.

The matching operation is stateless. Tyrion does not store the bill, copy transaction
records, accept a document URL, or retrieve a document. Callers should retain only the
returned references and status needed for reconciliation.

## Endpoint and authentication

```text
POST /api/connector/v1/bill-matches
Authorization: Bearer <server-only finance-manager credential>
Content-Type: application/json
```

This is a server-to-server connector-gateway operation. The existing connector bearer
credential scopes the request to the configured single household. The request cannot
select a household, user, tenant, credential, upstream URL, or Monarch session.
Requests with browser `Origin` or `Sec-Fetch-Site` metadata are rejected, no CORS
permission is emitted, and responses are `Cache-Control: no-store`.

The JSON request is limited to 1 KiB. Unknown fields are rejected. In particular,
callers must not send document text, images, account numbers, authentication material,
or caller-controlled authorization claims.

## Request

```json
{
  "contractVersion": "1.0",
  "billRef": "bill-example-2026-08",
  "amountMinor": 12345,
  "currency": "USD",
  "dueDate": "2026-08-15",
  "payeeName": "Example Utility Company",
  "accountRef": "account-example-checking",
  "dateWindowDays": 7,
  "amountToleranceMinor": 250,
  "candidateLimit": 5
}
```

| Field | Meaning and bounds |
| --- | --- |
| `contractVersion` | Exact value `1.0`. |
| `billRef` | Stable caller-owned opaque reference, 1-160 safe identifier characters. It must not contain a document URL or account number. |
| `amountMinor` | Positive expected bill amount in minor currency units, at most `100000000000`. |
| `currency` | Uppercase supported ISO 4217 currency code. It must equal the authoritative current Tyrion household-policy currency. Bridge v1 does not convert currencies. |
| `dueDate` | Valid ISO calendar date. |
| `payeeName` | Normalized payee display name, 1-120 characters with no control characters. |
| `accountRef` | Optional normalized Bridge account reference. If supplied, candidate lookup is restricted to it. |
| `dateWindowDays` | Optional inclusive distance before and after `dueDate`, `0..30`; default `7`. |
| `amountToleranceMinor` | Optional amount tolerance, `0..1000000`; default is the larger of 100 minor units or 2% of the bill amount. |
| `candidateLimit` | Optional returned candidate limit, `1..10`; default `5`. |

Tyrion queries normalized Bridge v1 transactions only within the derived date and
negative-outflow amount bounds, with an internal maximum of 100 rows. It never accepts
raw upstream Monarch response shapes.

## Response

```json
{
  "contractVersion": "1.0",
  "billRef": "bill-example-2026-08",
  "matchStatus": "matched",
  "paymentStatus": "paid",
  "selectedTransactionRef": "transaction-example-payment",
  "candidates": [
    {
      "transactionRef": "transaction-example-payment",
      "transactionDate": "2026-08-15",
      "transactionState": "posted",
      "scoreBasisPoints": 10000,
      "confidence": "high",
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
          "strength": "exact",
          "contributionBasisPoints": 500
        }
      ]
    }
  ]
}
```

`matchStatus` and `paymentStatus` are separate so consumers never infer payment state
from score:

| `matchStatus` | `paymentStatus` | Meaning |
| --- | --- | --- |
| `matched` | `paid` | One decisive candidate exists and the normalized transaction is posted. |
| `matched` | `pending` | One decisive candidate exists and the normalized transaction is pending. |
| `noMatch` | `unmatched` | No candidate reaches the 7000-basis-point decision threshold. |
| `ambiguous` | `ambiguous` | The top two candidates both qualify and differ by fewer than 500 basis points. |

`selectedTransactionRef` is present only for `matched` and always identifies the first
ranked candidate. Candidates are ordered by descending score, then transaction date,
then transaction reference. Returned candidates omit merchant names, account names,
amounts, notes, categories, tags, and other transaction detail.

## Deterministic scoring

The score is the sum of four documented signals and is capped at 10000 basis points:

| Signal | Maximum | Rule |
| --- | ---: | --- |
| Amount | 5500 | Exact absolute outflow amount receives full credit; values within tolerance decay linearly. |
| Date | 2500 | Exact due date receives full credit; dates inside the requested window decay linearly. |
| Payee | 1500 | Exact normalized token set receives full credit; otherwise deterministic token-set overlap is used. |
| Account | 500 | Exact account receives full credit. When no account is supplied, the signal is `notProvided` and neutral full credit prevents missing optional input from lowering every candidate. |

Confidence is `high` at 9000 or above, `medium` at 7000 through 8999, and `low`
below 7000. Signal `strength` is `exact`, `strong` (at least 70% of that signal),
`partial`, `none`, or `notProvided`.

## Failure behavior

| Status | Stable code | Meaning |
| ---: | --- | --- |
| 400 | `invalid_request` | Invalid JSON contract, unknown field, or inconsistent value. |
| 401 | `connector_auth_required` / `connector_auth_invalid` | Missing or invalid service credential. |
| 403 | `browser_request_rejected` | Browser-originated request. |
| 413 | `payload_too_large` | Request exceeds the gateway bound. |
| 415 | `unsupported_media_type` | Body is not JSON. |
| 502 | `invalid_bill_match_source_response` | Bridge returned malformed, non-JSON, oversized, or contract-incompatible data. |
| 503 | `bill_match_source_unavailable` | Bridge transaction lookup failed or was unavailable. |
| 503 | `bill_match_configuration_unavailable` | Tyrion could not resolve the authoritative household currency. |
| 422 | `bill_currency_mismatch` | Bill currency differs from the configured household currency. |
| 422 | `bill_match_query_too_broad` | More than 100 candidate transactions matched the derived lookup; narrow the date, amount tolerance, or account. |

Failures are sanitized and never include the Bridge response body, exception text,
authorization value, request body, session path, or transaction details.

## Downstream integration

OWL should call this operation only after it has produced the normalized request fields
above. It must keep extraction confidence and provenance in its own contract; those are
not matching weights or Tyrion authorization claims. Mission Control can use
`matchStatus`, `paymentStatus`, candidate references, scores, and signals to decide
whether to show a reconciliation exception. It must fetch ordinary transaction detail
through the existing authorized finance tools or deep-link to Monarch rather than
treating this response as a transaction record.
