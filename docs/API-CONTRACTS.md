# API Contracts — Monarch Bridge ↔ Mission Control

## Overview

The Monarch Bridge (FastAPI, port 8100) provides REST endpoints that Mission Control's `MonarchConnector` calls during sync cycles and user-triggered actions.

These contracts support the Tyrion domain defined in
[`PRODUCT-BOUNDARY.md`](./PRODUCT-BOUNDARY.md). Monarch remains the system of
record. Mission Control stores only the synchronized context, Tyrion policy, and
audit data needed for exceptions and cross-domain action. The bridge does not
define a standalone product surface.

---

## Authentication

The bridge handles Monarch authentication internally. Mission Control connects to the bridge via localhost — no auth needed for the bridge itself (it's a local-only service).

If deployed remotely in the future, add a shared API key header:
```
X-Bridge-Key: <secret>
```

---

## Endpoints

### GET /health

**Response** `200`
```json
{
  "status": "ok",
  "authenticated": true
}
```

---

### GET /transactions

Fetch transactions with optional filtering.

**Query Parameters**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| start_date | string (YYYY-MM-DD) | 90 days ago | Start of date range |
| end_date | string (YYYY-MM-DD) | today | End of date range |
| account_id | string | null | Filter by Monarch account ID |
| category_id | string | null | Filter by category ID |
| limit | int | 500 | Max results |

**Response** `200`
```json
{
  "transactions": [
    {
      "id": "txn_abc123",
      "date": "2026-06-18",
      "amount": -59.99,
      "merchant": {
        "name": "STEAM PURCHASE",
        "logoUrl": "..."
      },
      "category": {
        "id": "cat_gaming",
        "name": "Gaming"
      },
      "account": {
        "id": "acc_amex1234",
        "displayName": "Amex Blue Cash",
        "mask": "1234"
      },
      "isRecurring": false,
      "notes": "",
      "tags": []
    }
  ],
  "total": 142
}
```

---

### GET /transactions/{id}

**Response** `200` — Full transaction object (same shape as above, with additional metadata fields)

**Response** `404`
```json
{ "detail": "Transaction not found: ..." }
```

---

### PATCH /transactions/{id}/category

Update a transaction's category in Monarch (write-back).

**Request Body**
```json
{
  "category_id": "cat_kids_gaming"
}
```

**Response** `200`
```json
{
  "status": "updated",
  "transaction_id": "txn_abc123",
  "category_id": "cat_kids_gaming"
}
```

---

### GET /categories

**Response** `200`
```json
{
  "categories": [
    {
      "id": "cat_groceries",
      "name": "Groceries",
      "group": "Food & Drink",
      "icon": "🛒"
    },
    {
      "id": "cat_kids_gaming",
      "name": "Kids - Gaming",
      "group": "Kids",
      "icon": "🎮"
    }
  ]
}
```

---

### GET /accounts

**Response** `200`
```json
{
  "accounts": [
    {
      "id": "acc_chase9876",
      "displayName": "Chase Sapphire",
      "type": "credit",
      "mask": "9876",
      "institution": "Chase",
      "currentBalance": -2341.50,
      "isActive": true
    }
  ]
}
```

---

### GET /recurring

**Response** `200`
```json
{
  "recurring": [
    {
      "id": "rec_netflix",
      "merchant": "Netflix",
      "amount": -22.99,
      "frequency": "monthly",
      "nextExpectedDate": "2026-07-08",
      "account": {
        "id": "acc_amex1234",
        "displayName": "Amex Blue Cash"
      },
      "category": {
        "id": "cat_subscriptions",
        "name": "Subscriptions"
      }
    }
  ]
}
```

---

### GET /cashflow

**Query Parameters**
| Param | Type | Default |
|-------|------|---------|
| start_date | string | 1st of current month |
| end_date | string | today |

**Response** `200`
```json
{
  "income": 7200.00,
  "expenses": 4832.00,
  "net": 2368.00,
  "byCategory": [
    { "category": "Housing", "amount": 2450.00 },
    { "category": "Groceries", "amount": 680.00 },
    { "category": "Dining Out", "amount": 420.00 }
  ]
}
```

---

### GET /budgets

**Response** `200`
```json
{
  "budgets": [
    {
      "category": "Groceries",
      "budgeted": 700.00,
      "spent": 680.00,
      "remaining": 20.00,
      "percentUsed": 97
    },
    {
      "category": "Dining Out",
      "budgeted": 350.00,
      "spent": 420.00,
      "remaining": -70.00,
      "percentUsed": 120
    }
  ]
}
```

---

## Data Flow: Sync Cycle

```
Every 4 hours (node-cron in Mission Control):

1. MC calls GET /transactions?start_date={lastSync}
2. For each transaction:
   a. Upsert into financeTransactions table
   b. Run kid attribution algorithm
   c. Set triageStatus based on confidence
3. MC calls GET /recurring (update bills calendar)
4. MC calls GET /budgets (update budget display)
5. Alert engine checks thresholds
6. Update lastSyncedAt timestamp
```

## Data Flow: Exception Action

```
User resolves an actionable exception in Mission Control:

1. Mission Control sends the confirmed category or kid assignment.
2. MC API route:
   a. Records the requested mutation and provenance
   b. If category changed: calls bridge PATCH /transactions/{id}/category
   c. Refreshes the Monarch-backed transaction state
   d. Updates Tyrion attribution and resolves or preserves the exception
   e. Returns the authoritative result
```

## Data Flow: AI Chat Query

```
User asks "What did Jake spend this week?" through Houston:

1. AI SDK routes to Monarch MCP tools
2. MCP server calls Monarch API directly (not through bridge)
3. AI formats response with kid-aware context from MC's local DB
4. Houston renders the response with Monarch provenance
```
