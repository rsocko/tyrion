# Monarch Bridge API Contract

## Versioning

The current stable contract is **1.0**.

These contracts support the Tyrion domain defined in
[`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md). Monarch remains the system of
record. Tyrion stores its policy and policy audit data. Mission Control stores only
the synchronized operational context and review/action references needed for
exceptions and cross-domain action. The bridge does not define a standalone product
surface.

- `GET /contract` returns the implemented and supported contract versions.
- Every JSON response contains `"contractVersion": "1.0"`.
- Every response includes `X-Monarch-Contract-Version: 1.0`.
- Additive optional fields may be introduced within v1. Removing a field, changing its type or meaning, or changing a URL requires a new major contract version.
- Consumers must use these DTOs, not fields from `monarchmoneycommunity`.

The OpenAPI document at `GET /openapi.json` is the executable schema.

## Common semantics

### Naming and nullability

JSON fields use `camelCase`. A nullable field is present with `null` when the provider has no value. Collections are present as empty arrays, never `null`. Fields not marked nullable are always present.

### Dates and timestamps

- Calendar dates use ISO 8601 `YYYY-MM-DD` and have no timezone.
- Timestamps use ISO 8601 UTC with an offset, such as `2026-08-08T12:30:00Z`.
- `start_date` and `end_date` query parameters are inclusive.
- An invalid date is `422 invalid_request`; an end date before a start date is `400 invalid_date_range`.

### Money and signs

Money is a JSON number rounded to two decimal places in the account currency. Transaction income and credits are positive; transaction spending, payments, and other outflows are negative. Cash-flow values use the same signed convention. Budget `budgeted`, `spent`, and `percentUsed` are non-negative utilization values; `remaining` is `budgeted - spent` and may be negative.

The bridge currently assumes one account currency; v1 does not perform currency conversion.

### Provenance

Data responses contain:

```json
{
  "provenance": {
    "provider": "demo",
    "fetchedAt": "2026-08-08T12:30:00Z"
  }
}
```

`provider` is `demo` or `live`. `fetchedAt` is when the bridge normalized the provider response.

### Pagination

`GET /transactions` accepts `limit` (1-500, default 500) and an opaque `cursor`. Its response contains:

```json
{
  "page": {
    "limit": 500,
    "nextCursor": "NTAw"
  }
}
```

Pass `nextCursor` unchanged as the next request's `cursor`. `null` means there is no next page. Cursors have no client-visible structure and must not be persisted indefinitely.

### Service authentication

Non-loopback deployments require `Authorization: Bearer <service-token>` on
transaction reads and mutations. The same token is configured as
`BRIDGE_API_TOKEN` on Tyrion and as Mission Control's server-only finance connector
credential. Never expose it to browser code or place it in a repository environment
file.

### Errors

All bridge-generated errors have one shape:

```json
{
  "contractVersion": "1.0",
  "error": {
    "code": "transaction_not_found",
    "message": "Transaction tx-123 was not found"
  }
}
```

Stable codes include `invalid_request`, `invalid_cursor`, `invalid_date_range`, `bridge_auth_required`, `bridge_unavailable`, `not_authenticated`, `session_in_use`, `session_expired`, `invalid_credentials`, `invalid_mfa`, `mfa_required`, `captcha_required`, `upstream_timeout`, `upstream_rate_limited`, `transaction_not_found`, `upstream_error`, and `internal_error`. Clients should branch on `code`, not `message`. Upstream exception text and sensitive values are never returned.

## Endpoints

### Contract and health

`GET /contract`

```json
{
  "contractVersion": "1.0",
  "stability": "stable",
  "supportedVersions": ["1.0"]
}
```

`GET /health`

```json
{
  "contractVersion": "1.0",
  "status": "ok",
  "mode": "demo",
  "reachable": true,
  "authenticated": true,
  "authState": "connected"
}
```

`status` is `ok` or `degraded`; `mode` is `demo` or `live`. `authState` is
`unauthenticated`, `connected`, `expired`, or `degraded`. Health does not expose
session paths or upstream failure details.

### Authentication

`POST /auth/login`

```json
{ "email": "<email>", "password": "<redacted>", "mfaCode": "<redacted>" }
```

`mfaCode` is optional. `POST /auth/login-with-cookies` accepts
`{ "sessionId": "<redacted>", "csrfToken": "<redacted>" }`; the bridge constructs the
upstream cookie header in memory. Authentication request bodies are bounded, never
logged, and never echoed.
Successful authentication and `POST /auth/logout` return:

```json
{
  "contractVersion": "1.0",
  "status": "success",
  "message": "Authenticated successfully",
  "email": "<email>"
}
```

`status` is `success`, `mfa_required`, or `logged_out`; `email` is nullable.

`GET /auth/status`

```json
{
  "contractVersion": "1.0",
  "authenticated": true,
  "authState": "connected",
  "email": "<email>",
  "mode": "live"
}
```

The email is in-memory display context only and is `null` after restart. Reusable
Monarch credentials, cookies, and session values are never returned.

### Transactions

`GET /transactions`

Mission Control uses inclusive `start_date` and `end_date`, `limit` from 1 through
500, and the opaque `cursor` returned by the previous page. The bridge also supports
the optional `account_id` and `category_id` filters.

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "transactions": [
    {
      "id": "tx-123",
      "date": "2026-08-07",
      "amount": -59.99,
      "merchant": { "name": "Store", "logoUrl": null },
      "category": { "id": "cat-shopping", "name": "Shopping" },
      "account": { "id": "acc-1", "displayName": "Checking", "mask": "1234" },
      "isPending": false,
      "isRecurring": false,
      "notes": null,
      "tags": []
    }
  ],
  "total": 1,
  "page": { "limit": 500, "nextCursor": null }
}
```

`category` is nullable. `merchant.logoUrl`, `account.mask`, and `notes` are nullable.

`GET /transactions/{transaction_id}` returns the same transaction DTO under `transaction`, plus `contractVersion` and `provenance`.

`PATCH /transactions/{transaction_id}/category`

Request: `{ "categoryId": "cat-shopping" }`

```json
{
  "contractVersion": "1.0",
  "status": "updated",
  "transactionId": "tx-123",
  "categoryId": "cat-shopping"
}
```

### Accounts

`GET /accounts`

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "accounts": [
    {
      "id": "acc-1",
      "displayName": "Checking",
      "type": "checking",
      "mask": "1234",
      "institution": "Bank",
      "currentBalance": 4823.67,
      "isActive": true
    }
  ]
}
```

`mask` and `institution` are nullable.

### Categories

`GET /categories`

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "categories": [
    {
      "id": "cat-shopping",
      "name": "Shopping",
      "group": "Discretionary",
      "icon": null
    }
  ]
}
```

`group` and `icon` are nullable.

### Recurring obligations

`GET /recurring`

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "recurring": [
    {
      "id": "rec-1",
      "merchant": "Netflix",
      "amount": -22.99,
      "frequency": "monthly",
      "nextExpectedDate": "2026-09-01",
      "account": { "id": "acc-1", "displayName": "Checking", "mask": "1234" },
      "category": { "id": "cat-subscriptions", "name": "Subscriptions" }
    }
  ]
}
```

`nextExpectedDate`, `account`, and `category` are nullable.

### Budgets

`GET /budgets`

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "budgets": [
    {
      "category": { "id": "cat-groceries", "name": "Groceries" },
      "budgeted": 700.0,
      "spent": 680.0,
      "remaining": 20.0,
      "percentUsed": 97.14
    }
  ]
}
```

`percentUsed` is nullable when `budgeted` is zero.

### Cash flow

`GET /cashflow` accepts inclusive `start_date` and `end_date`.

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "startDate": "2026-08-01",
  "endDate": "2026-08-08",
  "income": 7200.0,
  "expenses": -4832.0,
  "net": 2368.0,
  "byCategory": [
    { "category": "Housing", "amount": -2450.0 }
  ]
}
```

### Sync

`POST /sync?days=90`, where `days` is 1-365.

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "status": "complete",
  "transactionsFetched": 142,
  "accountsSynced": 4,
  "syncedAt": "2026-08-08T12:30:00Z",
  "dateRange": { "start": "2026-05-10", "end": "2026-08-08" }
}
```
