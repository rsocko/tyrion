"""
Smoke tests for the Monarch Bridge service in demo mode.
Tests verify endpoint shapes and response codes without needing real credentials.
"""

import os

# Force demo mode before importing the app
os.environ["DEMO_MODE"] = "true"

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["mode"] == "demo"
    assert data["authenticated"] is True


@pytest.mark.anyio
async def test_sync(client):
    resp = await client.post("/sync?days=30")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "complete"
    assert data["mode"] == "demo"
    assert data["transactions_fetched"] > 0
    assert data["accounts_synced"] == 4
    assert "sync_timestamp" in data
    assert data["date_range"]["start"] is not None
    assert data["date_range"]["end"] is not None


@pytest.mark.anyio
async def test_transactions(client):
    resp = await client.get("/transactions?limit=10")
    assert resp.status_code == 200
    data = resp.json()
    assert "transactions" in data
    assert "total" in data
    assert len(data["transactions"]) <= 10
    # Verify transaction shape
    if data["transactions"]:
        tx = data["transactions"][0]
        assert "id" in tx
        assert "date" in tx
        assert "amount" in tx
        assert "merchant" in tx
        assert "category" in tx
        assert "account" in tx


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


@pytest.mark.anyio
async def test_update_category(client):
    resp = await client.patch(
        "/transactions/tx-1000/category",
        json={"category_id": "cat-restaurants"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "updated"
    assert data["transaction_id"] == "tx-1000"
    assert data["category_id"] == "cat-restaurants"


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


@pytest.mark.anyio
async def test_categories(client):
    resp = await client.get("/categories")
    assert resp.status_code == 200
    data = resp.json()
    assert "categories" in data
    assert len(data["categories"]) > 0
    cat = data["categories"][0]
    assert "id" in cat
    assert "name" in cat


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
    assert "totalIncome" in data
    assert "totalExpenses" in data
    assert "netCashflow" in data
    assert data["totalIncome"] > 0
    assert data["totalExpenses"] < 0


@pytest.mark.anyio
async def test_budgets(client):
    resp = await client.get("/budgets")
    assert resp.status_code == 200
    data = resp.json()
    assert "budgets" in data
    assert len(data["budgets"]) > 0
    budget = data["budgets"][0]
    assert "category" in budget
    assert "budgeted" in budget
    assert "spent" in budget
    assert "remaining" in budget


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
