"""Opt-in live contract checks that never write upstream payloads to disk."""

import os

import pytest
from httpx import AsyncClient


LIVE_ENABLED = os.getenv("TYRION_LIVE_TESTS") == "1"
BASE_URL = os.getenv("TYRION_LIVE_BRIDGE_URL", "http://127.0.0.1:8100")
TOKEN = os.getenv("BRIDGE_API_TOKEN")
MUTATION_CONFIRMATION = "I_ACCEPT_REVERSIBLE_MONARCH_MUTATION"

pytestmark = pytest.mark.skipif(
    not LIVE_ENABLED,
    reason="Set TYRION_LIVE_TESTS=1 to contact a controlled live bridge",
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def live_bridge():
    headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
    async with AsyncClient(
        base_url=BASE_URL,
        headers=headers,
        timeout=30,
    ) as client:
        yield client


def assert_success(response) -> None:
    assert response.status_code < 500
    assert response.status_code == 200
    assert response.headers["x-monarch-contract-version"] == "1.0"


@pytest.mark.anyio
async def test_live_auth_health(live_bridge):
    health = await live_bridge.get("/health")
    assert_success(health)
    status = await live_bridge.get("/auth/status")
    assert_success(status)
    assert status.json()["authState"] == "connected"


@pytest.mark.anyio
async def test_live_read_and_sync_contracts(live_bridge):
    transactions = await live_bridge.get("/transactions?limit=1")
    assert_success(transactions)
    transaction_rows = transactions.json()["transactions"]
    if transaction_rows:
        detail = await live_bridge.get(f"/transactions/{transaction_rows[0]['id']}")
        assert_success(detail)

    for path in ("/accounts", "/categories", "/recurring", "/cashflow", "/budgets"):
        assert_success(await live_bridge.get(path))
    assert_success(await live_bridge.post("/sync?days=7"))


@pytest.mark.anyio
async def test_live_category_mutation_is_verified_and_restored(live_bridge):
    if os.getenv("TYRION_LIVE_MUTATION_CONFIRM") != MUTATION_CONFIRMATION:
        pytest.skip("Explicit reversible mutation confirmation is required")
    transaction_id = os.getenv("TYRION_TEST_TRANSACTION_ID")
    replacement_category = os.getenv("TYRION_TEST_CATEGORY_ID")
    if not transaction_id or not replacement_category:
        pytest.skip("Dedicated test transaction and category IDs are required")

    before = await live_bridge.get(f"/transactions/{transaction_id}")
    assert_success(before)
    original = before.json()["transaction"].get("category")
    if not original or not original.get("id"):
        pytest.skip("The test transaction must have a restorable original category")

    try:
        changed = await live_bridge.patch(
            f"/transactions/{transaction_id}/category",
            json={"categoryId": replacement_category},
        )
        assert_success(changed)
        verified = await live_bridge.get(f"/transactions/{transaction_id}")
        assert_success(verified)
        assert verified.json()["transaction"]["category"]["id"] == replacement_category
    finally:
        restored = await live_bridge.patch(
            f"/transactions/{transaction_id}/category",
            json={"categoryId": original["id"]},
        )
        assert_success(restored)

    final = await live_bridge.get(f"/transactions/{transaction_id}")
    assert_success(final)
    assert final.json()["transaction"]["category"]["id"] == original["id"]


@pytest.mark.anyio
async def test_z_live_authentication_flow_and_logout(live_bridge):
    method = os.getenv("TYRION_LIVE_AUTH_METHOD")
    if method not in {"password", "cookies"}:
        pytest.skip("Set TYRION_LIVE_AUTH_METHOD to password or cookies")

    if method == "password":
        email = os.getenv("MONARCH_TEST_EMAIL")
        password = os.getenv("MONARCH_TEST_PASSWORD")
        if not email or not password:
            pytest.skip("Password authentication environment is incomplete")
        payload = {
            "email": email,
            "password": password,
            "mfaCode": os.getenv("MONARCH_TEST_MFA_CODE") or None,
        }
        authenticated = await live_bridge.post("/auth/login", json=payload)
    else:
        session_id = os.getenv("MONARCH_TEST_SESSION_ID")
        csrf_token = os.getenv("MONARCH_TEST_CSRF_TOKEN")
        if not session_id or not csrf_token:
            pytest.skip("Cookie authentication environment is incomplete")
        authenticated = await live_bridge.post(
            "/auth/login-with-cookies",
            json={"sessionId": session_id, "csrfToken": csrf_token},
        )

    assert_success(authenticated)
    assert_success(await live_bridge.get("/auth/status"))
    assert_success(await live_bridge.post("/auth/logout"))
    status = await live_bridge.get("/auth/status")
    assert_success(status)
    assert status.json()["authState"] == "unauthenticated"
