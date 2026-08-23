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

This document covers only Monarch Bridge v1 transport. Tyrion's protected batch
attribution service is a separate domain API defined by
[`attribution-service-v1.openapi.json`](./attribution-service-v1.openapi.json);
it is not added to the bridge route tree.

The separately versioned private Finance insight domain contract is defined by
[`finance-insights-service-v1.openapi.json`](./finance-insights-service-v1.openapi.json)
and its strict runtime parsers in `finance-insights/`. It does not change Bridge v1,
expose a browser route, or accept raw external URLs.

## Mission Control connector gateway

Mission Control may consume a strict subset of this contract through:

```text
https://tyrion.socko.us/api/connector/v1
```

The browser reconnect handoff is separate from this gateway. Mission Control opens
`https://tyrion.socko.us/?source=mission-control` without credentials, session
material, or a return URL. Tyrion owns reauthentication and requires live connected
status plus one bounded 30-day sync before showing an optional return link. That link
is the exact server-configured `MISSION_CONTROL_RETURN_URL`, is restricted by
`MISSION_CONTROL_RETURN_ALLOWED_ORIGINS`, and cannot contain credentials, query, or a
fragment. If either setting is absent or invalid, no return link is emitted.

Every gateway request requires `Authorization: Bearer <BRIDGE_API_TOKEN>`, including
health and contract. The configured token must be at least 32 characters. Validation
uses a constant-time digest comparison. The credential is forwarded only after the
caller is authenticated and the route, method, query, and body pass the gateway
allowlist. Requests carrying browser `Origin` or `Sec-Fetch-Site` metadata are
rejected; the gateway sends no CORS permission. Browser code must use the separate
bounded `/api/bridge/...` operations proxy, which never exposes finance datasets.

The gateway strips `/api/connector/v1` and forwards these exact Bridge v1 operations
to private `BRIDGE_URL`, except that connector health is derived from verified
authentication status as described below:

| Method | Gateway path | Bounds |
| --- | --- | --- |
| `GET` | `/contract` | No query or body |
| `GET` | `/health` | No query or body |
| `GET` | `/transactions` | The v1 transaction query allowlist and bounds below |
| `GET` | `/transactions/{id}` | ID 1-512 normalized characters; no query or body |
| `GET` | `/transactions/{id}/splits` | ID 1-512 normalized characters; no query or body |
| `PATCH` | `/transactions/{id}/category` | JSON `{ "categoryId": "..." }` only; 1 KiB maximum |
| `GET` | `/accounts` | No query or body |
| `GET` | `/category-groups` | No query or body |
| `GET` | `/categories` | No query or body |
| `GET` | `/tags` | No query or body |
| `GET` | `/recurring` | No query or body |
| `GET` | `/budgets` | No query or body |
| `POST` | `/sync?days=1..365` | One optional `days` value; no body; default 90 |

Unknown routes, methods, parameters, duplicate singleton parameters, malformed values,
and request bodies on bodyless operations fail before a bridge call. `/auth/*`,
login/cookie/logout/session operations, `/cashflow`, `/openapi.json`, docs, raw
upstream routes, `/api/policy/*`, and `/api/internal/*` are not gateway operations.
Transaction query validation additionally limits the request to 32 parameter pairs,
20 tag values, 512-character IDs, a 120-normalized-character merchant query, a
128-character cursor, 1-500 items, signed two-decimal values within
`999999999.99`, exact lowercase booleans, valid ISO calendar dates, and at most 366
inclusive days.

Successful and Bridge-generated error responses preserve the Bridge status, JSON body,
`Content-Type`, `X-Monarch-Contract-Version`, and `Retry-After` where present. The
gateway forces `Cache-Control: no-store` and enforces an 8 MiB response limit.
Network, timeout, non-JSON, malformed JSON, and oversized responses become stable
sanitized gateway errors. Authorization values, request or response bodies, sensitive
URLs, identifiers, and upstream exception text are not logged.

### Composed connector health

Authenticated `GET /api/connector/v1/health` sends exactly one server-to-server
`GET /auth/status` request with the validated `BRIDGE_API_TOKEN`; `/auth/status` does
not become a public gateway route. A successful verification proves that the private
Bridge is reachable and supplies every dynamic field required to normalize the
existing `HealthResponse`, so the gateway does not also call coarse `/health`.

The response must be 2xx JSON, no larger than 4 KiB, and must carry
`X-Monarch-Contract-Version: 1.0` plus a body `contractVersion` of `1.0`. The gateway
validates the explicit Bridge `AuthStatusResponse` field types, enumerations, and
authentication-state consistency. It then emits only the existing v1
`HealthResponse` fields:

```json
{
  "contractVersion": "1.0",
  "status": "ok",
  "mode": "live",
  "reachable": true,
  "authenticated": true,
  "authState": "connected"
}
```

Live-verified `/auth/status` is authoritative for `mode`, `authenticated`, and
`authState`; its `email` and every other field are discarded. A successful response
sets `reachable: true`. `status` is `ok` for verified `connected` and
`unauthenticated`, matching Bridge health semantics, and `degraded` for verified
`expired` and `degraded`. Consequently stale restart state cannot override any live
verification result, and each gateway health request performs exactly one verification.

The composed response is `200`, `Cache-Control: no-store`, and
`X-Monarch-Contract-Version: 1.0` only when verification validates. A private
non-2xx maps to `502 bridge_health_check_failed`; network failure maps to
`502 bridge_unavailable`; the 30-second bound maps to `504 bridge_timeout`;
non-JSON, malformed JSON, malformed shape, or an oversized response maps to
`502 invalid_bridge_response`; and a missing or mismatched contract version maps to
`502 bridge_contract_mismatch`. These failures use a versioned sanitized error
envelope, never a success-shaped `HealthResponse`, and never include the private
response body or exception detail.

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

### Dataset bounds and completeness

Reference and current-snapshot endpoints return one complete, authoritative collection
or fail. An empty collection is a successful complete response. The bridge rejects a
missing collection, a non-array collection, an invalid item, a missing required stable
ID/name, or a collection above its endpoint limit as `502 upstream_error`; it never
returns a truncated or partially normalized success.

| Endpoint | Maximum items |
| --- | ---: |
| `GET /accounts` | 1,000 |
| `GET /category-groups` | 250 |
| `GET /categories` | 2,000 |
| `GET /tags` | 1,000 |
| `GET /recurring` | 5,000 |
| `GET /budgets` | 5,000 |

These are bridge response-safety bounds, not retention promises. Consumers must also
apply their own model-facing item and byte limits.

### Service authentication

Non-loopback deployments require `Authorization: Bearer <service-token>` on
transaction reads and mutations. The same token is configured as
`BRIDGE_API_TOKEN` on Tyrion and as Mission Control's server-only finance connector
credential. Never expose it to browser code or place it in a repository environment
file.

### Protected finance insight service

The Tyrion-private finance insight contract is generated at
`docs/finance-insights-service-v1.openapi.json` and is mounted only at
`/api/internal/v1/finance/insights` on the fixed private Docker authority. It
uses the same minimum-32-character server bearer credential as attribution,
rejects browser-originated requests, and is excluded from public routers.

The seven v1 operations stage and commit immutable normalized source
generations, retry assigned evaluations, read snapshot-paginated occurrence
summaries/details, and apply confirmed structured actions. Each request is
limited to 256 KiB and parsed with the generated strict v1 schemas. Stable
errors, status codes, and `Retry-After` behavior are defined by the generated
contract; raw connection errors, request bodies, source identities, paths, and
financial values are never returned or logged.

The runtime requires an absolute external SQLite path, an absolute external
policy snapshot path, and separate server-held cursor and identity keys of at
least 32 bytes. Evaluation/write, read, and confirmed-action gates are
server-only and fail closed. Evaluation reads only the current promoted
projection and never contacts Monarch or loads reusable session material.

The same private read boundary publishes the generation-addressed, pull-only
`DocumentExpectationSignalsV1` projection for OWL:

```text
GET /api/internal/v1/finance/insights/document-expectation-signals/{sourceGeneration}?connectorRef={connectorRef}
```

Its independently versioned response, opaque series identity, advisory-only evidence,
OWL-owned durable negative decisions, complete-snapshot deactivation semantics,
deterministic ordering, and strict data exclusions are defined in
[`DOCUMENT-EXPECTATION-SIGNALS-V1.md`](./DOCUMENT-EXPECTATION-SIGNALS-V1.md).

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

Stable codes include `invalid_request`, `invalid_cursor`, `invalid_date_range`,
`invalid_amount_range`, `transaction_query_too_broad`, `bridge_auth_required`,
`bridge_unavailable`, `not_authenticated`, `session_in_use`, `session_expired`,
`invalid_credentials`, `invalid_mfa`, `mfa_required`, `captcha_required`,
`upstream_timeout`, `upstream_rate_limited`, `transaction_not_found`,
`upstream_error`, and `internal_error`. Clients should branch on `code`, not
`message`. Upstream exception text and sensitive values are never returned.

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
500, and the opaque `cursor` returned by the previous page. A request may cover at
most 366 inclusive calendar days. When dates are omitted, the bridge applies its
bounded default window.

The complete optional filter allowlist is:

- `account_id` and `category_id`: one non-empty normalized source ID each, at most
  512 characters.
- `merchant_query`: case-insensitive normalized-whitespace substring matching against
  merchant name only, from 1 through 120 characters.
- Repeated `tag_id`: at most 20 unique non-empty normalized source IDs, each at most
  512 characters. Duplicate values are coalesced and a transaction matches when it
  has any requested tag. The bridge accepts IDs but does not add tag-reference fields
  to the transaction DTO; the synchronized reference projection tracked by #141 is
  the downstream source of stable consumer tag identity.
- `min_amount` and `max_amount`: inclusive signed v1 money values from
  `-999999999.99` through `999999999.99`. `min_amount` must not exceed `max_amount`.
- `is_pending` and `is_recurring`: exactly `true` or `false`.

Every parameter except `tag_id` is a singleton. Unknown parameters, duplicate
singletons, malformed booleans, empty normalized text or IDs, and invalid ranges fail
without an upstream call. `invalid_amount_range` reports reversed amount bounds.
`invalid_date_range` reports reversed or overlong date ranges.

The pinned client receives account, category, tag, pending, and recurring filters
directly. Merchant and amount semantics are deliberately applied to normalized
transactions because the client's generic search is broader than merchant matching
and it has no amount-range parameters. The bridge pages the provider before applying
those normalized filters so `total`, `cursor`, and page slicing remain correct. This
scan is capped at 5,000 provider-matched transactions; a larger candidate set returns
`400 transaction_query_too_broad` and the caller must narrow the date or direct
filters.

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
      "tags": ["Household"],
      "tagReferences": [
        { "id": "tag-household", "name": "Household" }
      ]
    }
  ],
  "total": 1,
  "page": { "limit": 500, "nextCursor": null }
}
```

`category` is nullable. `merchant.logoUrl`, `account.mask`, and `notes` are nullable.
The existing `tags` display-name array remains for v1 compatibility.
`tagReferences` is the additive stable identity used for reference joins and tag
filters. It is empty when a transaction has no tags.

`GET /transactions/{transaction_id}` returns the same transaction DTO under `transaction`, plus `contractVersion` and `provenance`.

`GET /transactions/{transaction_id}/splits` performs an explicit, read-only split
investigation. It returns at most 100 normalized split items:

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "transactionId": "tx-123",
  "splits": [
    {
      "id": "split-1",
      "amount": -39.99,
      "merchantName": "Store",
      "category": { "id": "cat-shopping", "name": "Shopping" }
    }
  ]
}
```

`category` is nullable. Collections are empty rather than `null`. A missing
transaction returns `404 transaction_not_found`. A malformed split response, an
over-limit response, or any split missing its normalized identity returns sanitized
`502 upstream_error`. Notes, attachments, and raw split fields are never returned.
The operation accepts no query parameters.

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
      "groupId": "group-discretionary",
      "group": "Discretionary",
      "icon": null,
      "isActive": true
    }
  ]
}
```

`groupId`, `group`, and `icon` are nullable. The existing `group` display name remains
for v1 compatibility; consumers use `groupId` for stable joins. `isActive` is false
when Monarch marks the category disabled.

### Category groups

`GET /category-groups`

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "categoryGroups": [
    {
      "id": "group-discretionary",
      "name": "Discretionary",
      "isActive": true
    }
  ]
}
```

### Transaction tags

`GET /tags`

```json
{
  "contractVersion": "1.0",
  "provenance": { "provider": "live", "fetchedAt": "2026-08-08T12:30:00Z" },
  "tags": [
    {
      "id": "tag-household",
      "name": "Household",
      "isActive": true
    }
  ]
}
```

The returned reference set supplies the stable IDs used by transaction
`tagReferences` and by bounded tag filters. A returned group or tag is active unless
Monarch explicitly marks it disabled; disappearance from a later complete response is
handled by the consumer's reference-deactivation policy.

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
  "periodStart": "2026-08-01",
  "periodEnd": "2026-08-31",
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

`periodStart` and `periodEnd` are the explicit inclusive boundaries of the current
calendar-month snapshot requested from Monarch. Consumers must key and label the
snapshot from these fields rather than infer a month from fetch time. `percentUsed`
is nullable when `budgeted` is zero.

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
