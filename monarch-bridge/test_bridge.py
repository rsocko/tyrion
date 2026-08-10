"""
Smoke tests for the Monarch Bridge service in demo mode.
Tests verify endpoint shapes and response codes without needing real credentials.
"""

import os
from calendar import monthrange
from datetime import date
from unittest.mock import AsyncMock

# Force demo mode before importing the app
os.environ["DEMO_MODE"] = "true"

import pytest
from httpx import ASGITransport, AsyncClient

from contract import (
    CONTRACT_VERSION,
    MAX_ACCOUNTS,
    MAX_BUDGET_ROWS,
    MAX_CATEGORIES,
    MAX_CATEGORY_GROUPS,
    MAX_RECURRING_OBLIGATIONS,
    MAX_TRANSACTION_TAGS,
    normalize_accounts,
    normalize_budgets,
    normalize_cashflow,
    normalize_category_groups,
    normalize_categories,
    normalize_recurring,
    normalize_transaction,
    normalize_transaction_tags,
    normalize_transactions,
)
import main as main_module
from main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def assert_contract(resp):
    assert resp.headers["x-monarch-contract-version"] == CONTRACT_VERSION
    assert resp.json()["contractVersion"] == CONTRACT_VERSION


@pytest.mark.anyio
async def test_contract_version(client):
    resp = await client.get("/contract")
    assert resp.status_code == 200
    assert_contract(resp)
    assert resp.json()["supportedVersions"] == [CONTRACT_VERSION]


@pytest.mark.anyio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["mode"] == "demo"
    assert data["authenticated"] is True
    assert data["authState"] == "connected"
    assert data["reachable"] is True
    assert_contract(resp)


@pytest.mark.anyio
async def test_root_returns_health(client):
    resp = await client.get("/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["mode"] == "demo"
    assert data["authState"] == "connected"
    assert_contract(resp)


@pytest.mark.anyio
async def test_sync(client):
    resp = await client.post("/sync?days=30")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "complete"
    assert data["provenance"]["provider"] == "demo"
    assert data["transactionsFetched"] > 0
    assert data["accountsSynced"] == 4
    assert "syncedAt" in data
    assert data["dateRange"]["start"] is not None
    assert data["dateRange"]["end"] is not None
    assert_contract(resp)


@pytest.mark.anyio
async def test_transactions(client):
    resp = await client.get("/transactions?limit=10")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data) == {
        "contractVersion", "provenance", "transactions", "total", "page",
    }
    assert set(data["provenance"]) == {"provider", "fetchedAt"}
    assert set(data["page"]) == {"limit", "nextCursor"}
    assert "transactions" in data
    assert "total" in data
    assert len(data["transactions"]) <= 10
    assert data["page"]["limit"] == 10
    # Verify transaction shape
    if data["transactions"]:
        tx = data["transactions"][0]
        assert "id" in tx
        assert "date" in tx
        assert "amount" in tx
        assert "merchant" in tx
        assert "category" in tx
        assert "account" in tx
        assert set(tx) == {
            "id", "date", "amount", "merchant", "category", "account",
            "isPending", "isRecurring", "notes", "tags", "tagReferences",
        }
        assert set(tx["merchant"]) == {"name", "logoUrl"}
        assert set(tx["account"]) == {"id", "displayName", "mask"}
        assert tx["tags"] == ["Household"]
        assert tx["tagReferences"] == [{
            "id": "tag-household",
            "name": "Household",
        }]
    assert_contract(resp)


@pytest.mark.anyio
async def test_transactions_enforce_mission_control_page_limit(client):
    accepted = await client.get("/transactions?limit=500")
    rejected = await client.get("/transactions?limit=501")

    assert accepted.status_code == 200
    assert accepted.json()["page"]["limit"] == 500
    assert_contract(accepted)
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "invalid_request"
    assert_contract(rejected)


@pytest.mark.anyio
async def test_transactions_filter_by_account(client):
    resp = await client.get("/transactions?account_id=acc-checking-001&limit=5")
    assert resp.status_code == 200
    data = resp.json()
    for tx in data["transactions"]:
        assert tx["account"]["id"] == "acc-checking-001"


@pytest.mark.anyio
async def test_transactions_filter_by_category(client):
    resp = await client.get("/transactions?category_id=cat-groceries&limit=5")
    assert resp.status_code == 200
    data = resp.json()
    for tx in data["transactions"]:
        assert tx["category"]["id"] == "cat-groceries"


@pytest.mark.anyio
async def test_transaction_detail_not_found(client):
    resp = await client.get("/transactions/nonexistent-id")
    assert resp.status_code == 404
    assert resp.json() == {
        "contractVersion": CONTRACT_VERSION,
        "error": {
            "code": "transaction_not_found",
            "message": "Transaction nonexistent-id was not found",
        },
    }


@pytest.mark.anyio
async def test_transaction_detail(client):
    resp = await client.get("/transactions/tx-1000")
    assert resp.status_code == 200
    assert resp.json()["transaction"]["id"] == "tx-1000"
    assert_contract(resp)


@pytest.mark.anyio
async def test_transaction_cursor_and_invalid_cursor(client):
    first = await client.get("/transactions?limit=1")
    cursor = first.json()["page"]["nextCursor"]
    assert cursor
    second = await client.get(f"/transactions?limit=1&cursor={cursor}")
    assert second.status_code == 200
    assert second.json()["transactions"][0]["id"] != first.json()["transactions"][0]["id"]

    invalid = await client.get("/transactions?cursor=not-a-cursor")
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "invalid_cursor"

    oversized = await client.get(f"/transactions?cursor={'A' * 129}")
    assert oversized.status_code == 400
    assert oversized.json()["error"]["code"] == "invalid_cursor"
    assert_contract(oversized)


@pytest.mark.anyio
async def test_invalid_query_error_contract(client):
    resp = await client.get("/transactions?start_date=not-a-date")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "invalid_request"
    assert_contract(resp)


@pytest.mark.anyio
async def test_unknown_route_error_contract(client):
    resp = await client.get("/missing")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"
    assert_contract(resp)


@pytest.mark.anyio
async def test_update_category(client):
    resp = await client.patch(
        "/transactions/tx-1000/category",
        json={"categoryId": "cat-restaurants"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "updated"
    assert data["transactionId"] == "tx-1000"
    assert data["categoryId"] == "cat-restaurants"
    assert set(data) == {
        "contractVersion", "status", "transactionId", "categoryId",
    }
    assert_contract(resp)


@pytest.mark.anyio
async def test_update_category_rejects_extra_fields(client):
    resp = await client.patch(
        "/transactions/tx-1000/category",
        json={"categoryId": "cat-restaurants", "unexpected": True},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "invalid_request"
    assert_contract(resp)


@pytest.mark.anyio
async def test_accounts(client):
    resp = await client.get("/accounts")
    assert resp.status_code == 200
    data = resp.json()
    assert "accounts" in data
    assert len(data["accounts"]) == 4
    acc = data["accounts"][0]
    assert "id" in acc
    assert "displayName" in acc
    assert "currentBalance" in acc
    assert data["provenance"]["provider"] == "demo"


@pytest.mark.anyio
async def test_categories(client):
    resp = await client.get("/categories")
    assert resp.status_code == 200
    data = resp.json()
    assert "categories" in data
    assert len(data["categories"]) > 0
    cat = data["categories"][0]
    assert set(cat) == {"id", "name", "groupId", "group", "icon", "isActive"}
    assert cat["groupId"]
    assert cat["isActive"] is True


@pytest.mark.anyio
async def test_category_groups(client):
    resp = await client.get("/category-groups")

    assert resp.status_code == 200
    assert resp.json()["categoryGroups"][0] == {
        "id": "group-food",
        "name": "Food & Drink",
        "isActive": True,
    }
    assert_contract(resp)


@pytest.mark.anyio
async def test_transaction_tags(client):
    resp = await client.get("/tags")

    assert resp.status_code == 200
    assert resp.json()["tags"][0] == {
        "id": "tag-household",
        "name": "Household",
        "isActive": True,
    }
    assert_contract(resp)


@pytest.mark.anyio
async def test_recurring(client):
    resp = await client.get("/recurring")
    assert resp.status_code == 200
    data = resp.json()
    assert "recurring" in data
    assert len(data["recurring"]) > 0
    rec = data["recurring"][0]
    assert "merchant" in rec
    assert "amount" in rec
    assert "frequency" in rec


@pytest.mark.anyio
async def test_cashflow(client):
    resp = await client.get("/cashflow")
    assert resp.status_code == 200
    data = resp.json()
    assert "income" in data
    assert "expenses" in data
    assert "net" in data
    assert data["income"] > 0
    assert data["expenses"] < 0


@pytest.mark.anyio
async def test_budgets(client):
    resp = await client.get("/budgets")
    assert resp.status_code == 200
    data = resp.json()
    period_start = date.fromisoformat(data["periodStart"])
    period_end = date.fromisoformat(data["periodEnd"])
    assert period_start.day == 1
    assert period_end.day == monthrange(period_end.year, period_end.month)[1]
    assert (period_start.year, period_start.month) == (period_end.year, period_end.month)
    assert "budgets" in data
    assert len(data["budgets"]) > 0
    budget = data["budgets"][0]
    assert "category" in budget
    assert "budgeted" in budget
    assert "spent" in budget
    assert "remaining" in budget
    assert "percentUsed" in budget


@pytest.mark.anyio
async def test_openapi_docs(client):
    """Verify /docs is served (FastAPI auto-generates this)."""
    resp = await client.get("/docs")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


@pytest.mark.anyio
async def test_openapi_json(client):
    """Verify OpenAPI schema is accessible."""
    resp = await client.get("/openapi.json")
    assert resp.status_code == 200
    schema = resp.json()
    assert schema["info"]["title"] == "Monarch Bridge"
    assert "/sync" in schema["paths"]
    assert "/transactions" in schema["paths"]
    assert "/contract" in schema["paths"]
    for path in (
        "/contract", "/health", "/auth/login", "/auth/login-with-cookies",
        "/auth/status", "/auth/logout", "/sync", "/transactions",
        "/transactions/{transaction_id}", "/transactions/{transaction_id}/category",
        "/categories", "/category-groups", "/tags", "/accounts", "/recurring",
        "/cashflow", "/budgets",
    ):
        assert path in schema["paths"]
    response_bounds = {
        "AccountsResponse": ("accounts", MAX_ACCOUNTS),
        "CategoryGroupsResponse": ("categoryGroups", MAX_CATEGORY_GROUPS),
        "CategoriesResponse": ("categories", MAX_CATEGORIES),
        "TransactionTagsResponse": ("tags", MAX_TRANSACTION_TAGS),
        ("RecurringResponse"): ("recurring", MAX_RECURRING_OBLIGATIONS),
        "BudgetsResponse": ("budgets", MAX_BUDGET_ROWS),
    }
    for model_name, (field_name, maximum) in response_bounds.items():
        assert (
            schema["components"]["schemas"][model_name]["properties"][field_name][
                "maxItems"
            ]
            == maximum
        )


def test_live_and_demo_normalizers_produce_identical_dtos():
    demo_transaction = {
        "transactions": [{
            "id": "tx-1",
            "date": "2026-08-01",
            "amount": -12.5,
            "merchant": {"name": "Store"},
            "category": {"id": "cat-1", "name": "Shopping"},
            "account": {"id": "acc-1", "displayName": "Checking"},
        }],
    }
    live_transaction = {
        "allTransactions": {
            "results": [{
                "id": "tx-1",
                "postedDate": "2026-08-01T08:00:00Z",
                "amount": "-12.50",
                "merchant": {"name": "Store"},
                "category": {"id": "cat-1", "name": "Shopping"},
                "account": {"id": "acc-1", "displayName": "Checking"},
            }],
        },
    }
    assert normalize_transactions(demo_transaction) == normalize_transactions(live_transaction)

    demo_accounts = {"accounts": [{
        "id": "acc-1",
        "displayName": "Checking",
        "type": {"name": "checking"},
        "currentBalance": 10,
        "institution": {"name": "Bank"},
    }]}
    live_accounts = {"accounts": [{
        "id": "acc-1",
        "name": "Checking",
        "type": "checking",
        "balance": "10.00",
        "institution": "Bank",
    }]}
    assert normalize_accounts(demo_accounts) == normalize_accounts(live_accounts)

    assert normalize_category_groups({
        "categoryGroups": [{"id": "group-1", "name": "Food"}],
    }) == normalize_category_groups({
        "transactionCategoryGroups": [{"id": "group-1", "name": "Food"}],
    })
    assert normalize_transaction_tags({
        "householdTransactionTags": [{"id": "tag-1", "name": "Household"}],
    }) == normalize_transaction_tags({
        "transactionTags": [{"id": "tag-1", "name": "Household"}],
    })


def test_transaction_normalizer_matches_nullable_consumer_fields():
    transaction = normalize_transaction({
        "id": "tx-1",
        "date": "2026-08-01",
        "amount": -12.5,
        "merchant": {"name": "Store", "logoUrl": "http://["},
        "category": None,
        "account": {"id": "acc-1", "displayName": "Checking", "last4": 1234},
        "notes": None,
    })

    assert transaction.merchant.logo_url is None
    assert transaction.category is None
    assert transaction.account.mask == "1234"
    assert transaction.notes is None


def test_transaction_normalizer_preserves_names_and_adds_stable_tag_references():
    transaction = normalize_transaction({
        "id": "tx-1",
        "date": "2026-08-01",
        "amount": -12.5,
        "merchant": {"name": "Store"},
        "account": {"id": "acc-1", "displayName": "Checking"},
        "tags": [
            {"id": "tag-1", "name": "Household"},
            {"id": "tag-2", "name": "Reimbursable"},
        ],
    })

    assert transaction.tags == ["Household", "Reimbursable"]
    assert [tag.model_dump() for tag in transaction.tag_references] == [
        {"id": "tag-1", "name": "Household"},
        {"id": "tag-2", "name": "Reimbursable"},
    ]


@pytest.mark.parametrize(
    "tags",
    [
        ["legacy-name"],
        [None],
        [{"name": "Missing ID"}],
        [{"id": "tag-1"}],
    ],
)
def test_transaction_normalizer_rejects_tags_without_stable_identity(tags):
    with pytest.raises(ValueError):
        normalize_transaction({
            "id": "tx-1",
            "date": "2026-08-01",
            "amount": -12.5,
            "merchant": {"name": "Store"},
            "account": {"id": "acc-1", "displayName": "Checking"},
            "tags": tags,
        })


def test_normalizes_real_live_recurring_shape():
    payload = {
        "recurringTransactionItems": [{
            "stream": {
                "id": "stream-1",
                "frequency": "MONTHLY",
                "amount": -15.99,
                "merchant": {"id": "merchant-1", "name": "Netflix"},
            },
            "date": "2026-09-01",
            "amount": -16.99,
            "category": {"id": "cat-1", "name": "Subscriptions"},
            "account": {"id": "acc-1", "displayName": "Checking"},
        }],
    }
    recurring = normalize_recurring(payload)
    assert len(recurring) == 1
    assert recurring[0].id == "stream-1"
    assert recurring[0].merchant == "Netflix"
    assert recurring[0].amount == -16.99
    assert recurring[0].next_expected_date.isoformat() == "2026-09-01"


def test_normalizes_real_live_budget_shape():
    payload = {
        "budgetData": {
            "monthlyAmountsByCategory": [{
                "category": {"id": "cat-1"},
                "monthlyAmounts": [{
                    "month": "2026-08-01",
                    "plannedCashFlowAmount": -700,
                    "actualAmount": -680,
                    "remainingAmount": -20,
                }],
            }],
        },
        "categoryGroups": [{
            "categories": [{"id": "cat-1", "name": "Groceries"}],
        }],
    }
    budgets = normalize_budgets(payload, date(2026, 8, 1))
    assert len(budgets) == 1
    assert budgets[0].category.name == "Groceries"
    assert budgets[0].budgeted == 700
    assert budgets[0].spent == 680
    assert budgets[0].remaining == 20
    assert budgets[0].percent_used == 97.14


@pytest.mark.parametrize(
    ("normalizer", "payload"),
    [
        (normalize_accounts, {"accounts": [{}] * (MAX_ACCOUNTS + 1)}),
        (normalize_category_groups, {"categoryGroups": [{}] * (MAX_CATEGORY_GROUPS + 1)}),
        (normalize_categories, {"categories": [{}] * (MAX_CATEGORIES + 1)}),
        (
            normalize_transaction_tags,
            {"householdTransactionTags": [{}] * (MAX_TRANSACTION_TAGS + 1)},
        ),
        (
            normalize_recurring,
            {"recurringTransactionItems": [{}] * (MAX_RECURRING_OBLIGATIONS + 1)},
        ),
        (normalize_budgets, {"budgets": [{}] * (MAX_BUDGET_ROWS + 1)}),
    ],
)
def test_dataset_normalizers_reject_oversized_collections(normalizer, payload):
    with pytest.raises(ValueError, match="exceeded"):
        normalizer(payload)


@pytest.mark.parametrize(
    ("normalizer", "payload"),
    [
        (normalize_accounts, {"accounts": "not-an-array"}),
        (normalize_category_groups, {"categoryGroups": [None]}),
        (normalize_categories, {"categories": [{"name": "Missing ID"}]}),
        (
            normalize_transaction_tags,
            {"householdTransactionTags": [{"id": "tag-1"}]},
        ),
        (normalize_recurring, {"recurringTransactionItems": [{"id": None}]}),
        (normalize_budgets, {"budgets": [{"category": {"name": "Missing ID"}}]}),
    ],
)
def test_dataset_normalizers_reject_malformed_upstream_shapes(normalizer, payload):
    with pytest.raises(ValueError):
        normalizer(payload)


@pytest.mark.parametrize(
    ("normalizer", "payload"),
    [
        (
            normalize_accounts,
            {"accounts": [{
                "id": "acc-1",
                "type": "checking",
                "currentBalance": 0,
            }]},
        ),
        (
            normalize_budgets,
            {"budgets": [{
                "category": {"id": "cat-1"},
                "budgeted": 0,
                "spent": 0,
            }]},
        ),
    ],
)
def test_dataset_normalizers_do_not_invent_required_names(normalizer, payload):
    with pytest.raises(ValueError, match="text is missing"):
        normalizer(payload)


@pytest.mark.parametrize(
    ("normalizer", "payload"),
    [
        (normalize_accounts, {"accounts": []}),
        (normalize_category_groups, {"categoryGroups": []}),
        (normalize_categories, {"categories": []}),
        (normalize_transaction_tags, {"householdTransactionTags": []}),
        (normalize_recurring, {"recurringTransactionItems": []}),
        (normalize_budgets, {"budgets": []}),
    ],
)
def test_dataset_normalizers_accept_authoritative_empty_collections(normalizer, payload):
    assert normalizer(payload) == []


def test_normalizes_real_live_cashflow_shape():
    payload = {
        "summary": {"summary": {"sumIncome": 7200, "sumExpense": 4832}},
        "byCategory": [{
            "groupBy": {
                "category": {
                    "name": "Housing",
                    "group": {"type": "EXPENSE"},
                },
            },
            "summary": {"sum": 2450},
        }],
    }
    cashflow = normalize_cashflow(
        payload,
        "2026-08-01",
        "2026-08-31",
        "live",
    )
    assert cashflow.income == 7200
    assert cashflow.expenses == -4832
    assert cashflow.net == 2368
    assert cashflow.by_category[0].category == "Housing"
    assert cashflow.by_category[0].amount == -2450


@pytest.mark.anyio
async def test_live_transactions_use_provider_pagination_and_defaults(client, monkeypatch):
    provider = AsyncMock()
    provider.get_transactions.return_value = {
        "allTransactions": {
            "totalCount": 101,
            "results": [{
                "id": "tx-101",
                "date": "2026-08-01",
                "amount": -10,
                "merchant": {"name": "Store"},
                "category": {"id": "cat-1", "name": "Shopping"},
                "account": {"id": "acc-1", "displayName": "Checking"},
            }],
        },
    }
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.get("/transactions?limit=1&cursor=MTAw")

    assert resp.status_code == 200
    assert resp.json()["total"] == 101
    assert resp.json()["page"]["nextCursor"] is None
    kwargs = provider.get_transactions.await_args.kwargs
    assert kwargs["limit"] == 1
    assert kwargs["offset"] == 100
    assert kwargs["start_date"]
    assert kwargs["end_date"]


@pytest.mark.anyio
async def test_live_transactions_map_malformed_upstream_page_to_stable_error(
    client,
    monkeypatch,
):
    provider = AsyncMock()
    provider.get_transactions.return_value = {
        "allTransactions": {
            "totalCount": 1,
            "results": [{
                "date": "2026-08-01",
                "amount": -10,
                "merchant": {"name": "Store"},
                "account": {"id": "acc-1", "displayName": "Checking"},
            }],
        },
    }
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.get("/transactions?limit=1")

    assert resp.status_code == 502
    assert resp.json() == {
        "contractVersion": CONTRACT_VERSION,
        "error": {
            "code": "upstream_error",
            "message": "Monarch transaction request failed",
        },
    }
    assert_contract(resp)


@pytest.mark.anyio
async def test_live_sync_pages_until_total_count(client, monkeypatch):
    provider = AsyncMock()
    provider.get_transactions.side_effect = [
        {
            "allTransactions": {
                "totalCount": 3,
                "results": [{"id": "tx-1"}, {"id": "tx-2"}],
            },
        },
        {
            "allTransactions": {
                "totalCount": 3,
                "results": [{"id": "tx-3"}],
            },
        },
    ]
    provider.get_accounts.return_value = {"accounts": [{"id": "acc-1"}]}
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.post("/sync?days=30")

    assert resp.status_code == 200
    assert resp.json()["transactionsFetched"] == 3
    assert provider.get_transactions.await_count == 2
    assert provider.get_transactions.await_args_list[0].kwargs["offset"] == 0
    assert provider.get_transactions.await_args_list[1].kwargs["offset"] == 2


@pytest.mark.anyio
async def test_live_sync_preserves_authentication_error(client, monkeypatch):
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(
        main_module,
        "get_client",
        AsyncMock(side_effect=main_module.HTTPException(
            401,
            detail={
                "error": "not_authenticated",
                "message": "Please authenticate via /auth/login",
            },
        )),
    )

    resp = await client.post("/sync")

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "not_authenticated"


@pytest.mark.anyio
async def test_live_transaction_detail_enriches_category_name(client, monkeypatch):
    provider = AsyncMock()
    provider.get_transaction_details.return_value = {
        "getTransaction": {
            "id": "tx-1",
            "date": "2026-08-01",
            "amount": -10,
            "merchant": {"name": "Store"},
            "category": {"id": "cat-1"},
            "account": {"id": "acc-1", "displayName": "Checking"},
        },
    }
    provider.get_transaction_categories.return_value = {
        "categories": [{"id": "cat-1", "name": "Shopping"}],
    }
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.get("/transactions/tx-1")

    assert resp.status_code == 200
    assert resp.json()["transaction"]["category"] == {
        "id": "cat-1",
        "name": "Shopping",
    }


@pytest.mark.anyio
async def test_live_category_update_requires_confirmed_mutation(client, monkeypatch):
    provider = AsyncMock()
    provider.update_transaction.return_value = {
        "updateTransaction": {
            "transaction": None,
            "errors": [{"code": "INVALID_CATEGORY", "message": "Invalid category"}],
        },
    }
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.patch(
        "/transactions/tx-1/category",
        json={"categoryId": "cat-missing"},
    )

    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "upstream_error"


@pytest.mark.anyio
async def test_category_update_rejects_empty_id(client):
    resp = await client.patch(
        "/transactions/tx-1/category",
        json={"categoryId": "  "},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "invalid_request"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "method_name", "payload", "response_key"),
    [
        (
            "/category-groups",
            "get_transaction_category_groups",
            {"categoryGroups": [{"id": "group-1", "name": "Food"}]},
            "categoryGroups",
        ),
        (
            "/tags",
            "get_transaction_tags",
            {"householdTransactionTags": [{"id": "tag-1", "name": "Household"}]},
            "tags",
        ),
    ],
)
async def test_live_reference_routes_use_pinned_provider_methods(
    client,
    monkeypatch,
    path,
    method_name,
    payload,
    response_key,
):
    provider = AsyncMock()
    getattr(provider, method_name).return_value = payload
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.get(path)

    assert resp.status_code == 200
    assert resp.json()[response_key][0]["id"]
    getattr(provider, method_name).assert_awaited_once_with()
    assert resp.json()["provenance"]["provider"] == "live"
    assert_contract(resp)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "method_name", "resource"),
    [
        ("/accounts", "get_accounts", "account"),
        ("/categories", "get_transaction_categories", "category"),
        (
            "/category-groups",
            "get_transaction_category_groups",
            "category group",
        ),
        ("/tags", "get_transaction_tags", "transaction tag"),
        ("/recurring", "get_recurring_transactions", "recurring transaction"),
        ("/budgets", "get_budgets", "budget"),
    ],
)
async def test_live_datasets_map_malformed_upstream_to_sanitized_error(
    client,
    monkeypatch,
    path,
    method_name,
    resource,
):
    provider = AsyncMock()
    getattr(provider, method_name).return_value = {
        "unexpected": "private-upstream-value",
    }
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.get(path)

    assert resp.status_code == 502
    assert resp.json() == {
        "contractVersion": CONTRACT_VERSION,
        "error": {
            "code": "upstream_error",
            "message": f"Monarch {resource} request failed",
        },
    }
    assert "private-upstream-value" not in resp.text
    assert_contract(resp)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "method_name", "resource"),
    [
        ("/category-groups", "get_category_groups", "category group"),
        ("/tags", "get_transaction_tags", "transaction tag"),
        ("/budgets", "get_budgets", "budget"),
    ],
)
async def test_demo_datasets_map_malformed_data_to_same_sanitized_error(
    client,
    monkeypatch,
    path,
    method_name,
    resource,
):
    monkeypatch.setattr(
        main_module.DemoProvider,
        method_name,
        lambda: {"unexpected": "private-demo-value"},
    )

    resp = await client.get(path)

    assert resp.status_code == 502
    assert resp.json()["error"] == {
        "code": "upstream_error",
        "message": f"Monarch {resource} request failed",
    }
    assert "private-demo-value" not in resp.text
    assert_contract(resp)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "method_name", "payload"),
    [
        (
            "/category-groups",
            "get_category_groups",
            {"categoryGroups": [
                {"id": f"group-{index}", "name": f"Group {index}"}
                for index in range(MAX_CATEGORY_GROUPS + 1)
            ]},
        ),
        (
            "/tags",
            "get_transaction_tags",
            {"householdTransactionTags": [
                {"id": f"tag-{index}", "name": f"Tag {index}"}
                for index in range(MAX_TRANSACTION_TAGS + 1)
            ]},
        ),
    ],
)
async def test_demo_reference_routes_reject_oversized_collections(
    client,
    monkeypatch,
    path,
    method_name,
    payload,
):
    monkeypatch.setattr(main_module.DemoProvider, method_name, lambda: payload)

    resp = await client.get(path)

    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "upstream_error"
    assert_contract(resp)


@pytest.mark.anyio
async def test_live_budget_uses_explicit_full_month_period(client, monkeypatch):
    provider = AsyncMock()
    today = date.today()
    period_start = today.replace(day=1)
    period_end = today.replace(day=monthrange(today.year, today.month)[1])
    provider.get_budgets.return_value = {
        "budgetData": {
            "monthlyAmountsByCategory": [{
                "category": {"id": "cat-1"},
                "monthlyAmounts": [{
                    "month": period_start.isoformat(),
                    "plannedCashFlowAmount": -700,
                    "actualAmount": -680,
                }],
            }],
        },
        "categoryGroups": [{
            "categories": [{"id": "cat-1", "name": "Groceries"}],
        }],
    }
    monkeypatch.setattr(main_module, "DEMO_MODE", False)
    monkeypatch.setattr(main_module, "get_client", AsyncMock(return_value=provider))

    resp = await client.get("/budgets")

    assert resp.status_code == 200
    assert resp.json()["periodStart"] == period_start.isoformat()
    assert resp.json()["periodEnd"] == period_end.isoformat()
    provider.get_budgets.assert_awaited_once_with(
        start_date=period_start.isoformat(),
        end_date=period_end.isoformat(),
    )
