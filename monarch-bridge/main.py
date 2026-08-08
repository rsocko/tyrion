"""
Monarch Money Bridge Service
FastAPI wrapper around monarchmoneycommunity for Mission Control integration.

Run with --demo flag to use mock data (no Monarch credentials needed).
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("monarch_bridge")

# ---------------------------------------------------------------------------
# Demo mode detection (set via --demo flag or DEMO_MODE env var)
# ---------------------------------------------------------------------------
DEMO_MODE: bool = os.getenv("DEMO_MODE", "").lower() in ("1", "true", "yes")


# ---------------------------------------------------------------------------
# Mock data provider for demo mode
# ---------------------------------------------------------------------------
class DemoProvider:
    """Returns realistic mock data for local development without Monarch credentials."""

    ACCOUNTS = [
        {"id": "acc-checking-001", "displayName": "Primary Checking", "type": {"name": "checking"},
         "currentBalance": 4823.67, "institution": {"name": "Chase"}},
        {"id": "acc-savings-001", "displayName": "Emergency Fund", "type": {"name": "savings"},
         "currentBalance": 15200.00, "institution": {"name": "Marcus"}},
        {"id": "acc-credit-001", "displayName": "Rewards Card", "type": {"name": "credit"},
         "currentBalance": -1247.33, "institution": {"name": "Amex"}},
        {"id": "acc-invest-001", "displayName": "Brokerage", "type": {"name": "investment"},
         "currentBalance": 42150.89, "institution": {"name": "Fidelity"}},
    ]

    CATEGORIES = [
        {"id": "cat-groceries", "name": "Groceries", "group": {"name": "Food & Drink"}},
        {"id": "cat-restaurants", "name": "Restaurants", "group": {"name": "Food & Drink"}},
        {"id": "cat-gas", "name": "Gas & Fuel", "group": {"name": "Transportation"}},
        {"id": "cat-utilities", "name": "Utilities", "group": {"name": "Bills"}},
        {"id": "cat-streaming", "name": "Streaming Services", "group": {"name": "Entertainment"}},
        {"id": "cat-rent", "name": "Rent", "group": {"name": "Housing"}},
        {"id": "cat-income", "name": "Paycheck", "group": {"name": "Income"}},
        {"id": "cat-transfer", "name": "Transfer", "group": {"name": "Transfers"}},
    ]

    @classmethod
    def _generate_transactions(cls, start_date: str, end_date: Optional[str], limit: int) -> list:
        """Generate a repeatable set of mock transactions."""
        import random
        random.seed(42)

        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d") if end_date else datetime.now()

        merchants = [
            ("Whole Foods", "cat-groceries", -87.43),
            ("Costco", "cat-groceries", -156.22),
            ("Chipotle", "cat-restaurants", -14.50),
            ("Shell Gas", "cat-gas", -52.00),
            ("Netflix", "cat-streaming", -15.99),
            ("Spotify", "cat-streaming", -10.99),
            ("Electric Company", "cat-utilities", -124.50),
            ("Landlord LLC", "cat-rent", -2100.00),
            ("ACME Corp Payroll", "cat-income", 4500.00),
            ("Target", "cat-groceries", -67.88),
            ("Uber Eats", "cat-restaurants", -32.40),
            ("BP Gas Station", "cat-gas", -45.00),
        ]

        transactions = []
        current = start
        tx_id = 1000
        while current <= end and len(transactions) < limit:
            num_daily = random.randint(0, 3)
            for _ in range(num_daily):
                merchant, cat_id, base_amount = random.choice(merchants)
                amount = round(base_amount * random.uniform(0.8, 1.2), 2)
                category = next((c for c in cls.CATEGORIES if c["id"] == cat_id), cls.CATEGORIES[0])
                account = cls.ACCOUNTS[0] if amount < 0 else cls.ACCOUNTS[0]

                transactions.append({
                    "id": f"tx-{tx_id}",
                    "date": current.strftime("%Y-%m-%d"),
                    "merchant": {"name": merchant},
                    "amount": amount,
                    "category": category,
                    "account": {"id": account["id"], "displayName": account["displayName"]},
                    "isPending": False,
                    "notes": None,
                })
                tx_id += 1
            current += timedelta(days=1)

        transactions.sort(key=lambda t: t["date"], reverse=True)
        return transactions[:limit]

    @classmethod
    def get_transactions(cls, start_date: str, end_date: Optional[str], limit: int,
                         account_id: Optional[str] = None, category_id: Optional[str] = None) -> dict:
        results = cls._generate_transactions(start_date, end_date, limit)
        if account_id:
            results = [t for t in results if t["account"]["id"] == account_id]
        if category_id:
            results = [t for t in results if t["category"]["id"] == category_id]
        return {"transactions": results, "total": len(results)}

    @classmethod
    def get_transaction_detail(cls, transaction_id: str) -> dict:
        all_tx = cls._generate_transactions("2024-01-01", None, 5000)
        for tx in all_tx:
            if tx["id"] == transaction_id:
                return tx
        return None

    @classmethod
    def get_accounts(cls) -> dict:
        return {"accounts": cls.ACCOUNTS}

    @classmethod
    def get_categories(cls) -> dict:
        return {"categories": cls.CATEGORIES}

    @classmethod
    def get_recurring(cls) -> dict:
        return {"recurring": [
            {"id": "rec-1", "merchant": {"name": "Netflix"}, "amount": -15.99,
             "frequency": "monthly", "category": {"id": "cat-streaming", "name": "Streaming Services"}},
            {"id": "rec-2", "merchant": {"name": "Spotify"}, "amount": -10.99,
             "frequency": "monthly", "category": {"id": "cat-streaming", "name": "Streaming Services"}},
            {"id": "rec-3", "merchant": {"name": "Landlord LLC"}, "amount": -2100.00,
             "frequency": "monthly", "category": {"id": "cat-rent", "name": "Rent"}},
            {"id": "rec-4", "merchant": {"name": "Electric Company"}, "amount": -124.50,
             "frequency": "monthly", "category": {"id": "cat-utilities", "name": "Utilities"}},
            {"id": "rec-5", "merchant": {"name": "ACME Corp Payroll"}, "amount": 4500.00,
             "frequency": "biweekly", "category": {"id": "cat-income", "name": "Paycheck"}},
        ]}

    @classmethod
    def get_cashflow(cls, start_date: str, end_date: Optional[str]) -> dict:
        return {
            "startDate": start_date,
            "endDate": end_date or datetime.now().strftime("%Y-%m-%d"),
            "totalIncome": 9000.00,
            "totalExpenses": -6842.15,
            "netCashflow": 2157.85,
            "byCategory": [
                {"category": "Housing", "amount": -2100.00},
                {"category": "Food & Drink", "amount": -1245.30},
                {"category": "Transportation", "amount": -485.00},
                {"category": "Bills", "amount": -624.50},
                {"category": "Entertainment", "amount": -126.98},
            ],
        }

    @classmethod
    def get_budgets(cls) -> dict:
        return {"budgets": [
            {"category": "Groceries", "budgeted": 600.00, "spent": 478.50, "remaining": 121.50},
            {"category": "Restaurants", "budgeted": 200.00, "spent": 187.40, "remaining": 12.60},
            {"category": "Gas & Fuel", "budgeted": 150.00, "spent": 97.00, "remaining": 53.00},
            {"category": "Entertainment", "budgeted": 100.00, "spent": 126.98, "remaining": -26.98},
        ]}


# ---------------------------------------------------------------------------
# Monarch client management (live mode only)
# ---------------------------------------------------------------------------
mm: Optional[object] = None


async def get_client():
    """Get or initialize the Monarch Money client (live mode only)."""
    global mm
    if DEMO_MODE:
        raise RuntimeError("get_client() should not be called in demo mode")

    if mm is None:
        from monarchmoney import MonarchMoney
        mm = MonarchMoney()
        session_file = SESSION_FILE

        if session_file.exists():
            mm.load_session(str(session_file))
            logger.info("Loaded existing Monarch session from %s", session_file)
        else:
            raise HTTPException(401, detail={"error": "not_authenticated", "message": "Please authenticate via /auth/login"})

    return mm


# ---------------------------------------------------------------------------
# App lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    mode = "DEMO" if DEMO_MODE else "LIVE"
    logger.info("Monarch Bridge starting in %s mode on port %s", mode, os.getenv("BRIDGE_PORT", "8100"))
    yield
    logger.info("Monarch Bridge shutting down")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Monarch Bridge",
    version="0.3.0",
    description="Bridge service between Mission Control and Monarch Money. "
                "Run with --demo flag for development without credentials.",
    lifespan=lifespan,
)

# CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s %s: %s", request.method, request.url.path, exc, exc_info=True)
    return JSONResponse(status_code=500, content={"error": str(exc), "path": request.url.path})


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class CategoryUpdate(BaseModel):
    category_id: str


class SyncResponse(BaseModel):
    status: str
    mode: str
    transactions_fetched: int
    accounts_synced: int
    sync_timestamp: str
    date_range: dict


class LoginRequest(BaseModel):
    email: str
    password: str
    mfa_code: Optional[str] = None


class CookieLoginRequest(BaseModel):
    cookies: str  # Raw cookie header string from browser


class AuthStatusResponse(BaseModel):
    authenticated: bool
    email: Optional[str] = None
    session_file: Optional[str] = None
    mode: str


# ---------------------------------------------------------------------------
# Auth Endpoints
# ---------------------------------------------------------------------------
SESSION_FILE = Path(os.getenv("SESSION_FILE", "~/.monarch_session")).expanduser()


@app.post("/auth/login")
async def auth_login(request: LoginRequest):
    """Authenticate with Monarch Money using email/password + optional email OTP code.

    Flow:
    1. First call with email/password returns mfa_required when Monarch requests a code.
    2. Second call with email/password/mfa_code completes authentication.
    """
    if DEMO_MODE:
        return {"status": "success", "message": "Demo mode - no real auth needed", "email": request.email}

    try:
        from monarchmoney import MonarchMoney

        global mm
        client = MonarchMoney()

        if request.mfa_code:
            await client.multi_factor_authenticate(request.email, request.password, request.mfa_code)
            client.save_session(str(SESSION_FILE))
            mm = client
            logger.info("MFA login successful for %s", request.email)
            return {"status": "success", "message": "Authenticated successfully", "email": request.email}

        await client.login(
            request.email,
            request.password,
            use_saved_session=False,
            save_session=False,
        )
        client.save_session(str(SESSION_FILE))
        mm = client
        logger.info("Login successful for %s", request.email)
        return {"status": "success", "message": "Authenticated successfully", "email": request.email}

    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e).lower()
        if (
            "mfa" in error_msg
            or "multi-factor" in error_msg
            or "two-factor" in error_msg
            or "verification" in error_msg
        ):
            logger.info("MFA code required for %s", request.email)
            raise HTTPException(
                403,
                detail={
                    "error": "mfa_required",
                    "message": "Monarch requires a verification code. Enter it and try again.",
                },
            )
        elif "password" in error_msg or "credentials" in error_msg or "unauthorized" in error_msg:
            raise HTTPException(401, detail={"error": "invalid_credentials", "message": "Invalid email or password"})
        elif "captcha" in error_msg:
            raise HTTPException(403, detail={
                "error": "captcha_required",
                "message": "Monarch requires CAPTCHA. Use cookie-based login instead: log in via browser, then paste your cookies."
            })
        else:
            logger.error("Login failed: %s", e)
            raise HTTPException(500, detail={"error": "login_failed", "message": str(e)})


@app.post("/auth/login-with-cookies")
async def auth_login_cookies(request: CookieLoginRequest):
    """Authenticate using browser cookies (bypasses CAPTCHA).

    Steps for user:
    1. Log into app.monarchmoney.com in a browser.
    2. Copy the Cookie request header from the browser's developer tools.
    3. Submit the cookie string to this endpoint.
    """
    if DEMO_MODE:
        return {"status": "success", "message": "Demo mode - no real auth needed"}

    try:
        from monarchmoney import MonarchMoney

        global mm
        client = MonarchMoney()
        await client.login_with_cookies(request.cookies, save_session=False)
        client.save_session(str(SESSION_FILE))
        mm = client
        logger.info("Cookie-based login successful")
        return {"status": "success", "message": "Authenticated via browser cookies"}

    except Exception as e:
        logger.error("Cookie login failed: %s", e)
        raise HTTPException(401, detail={"error": "cookie_login_failed", "message": f"Cookie auth failed: {e}"})


@app.get("/auth/status")
async def auth_status():
    """Check whether the current session is active."""
    if DEMO_MODE:
        return AuthStatusResponse(authenticated=True, email="demo@example.com", mode="demo")

    if SESSION_FILE.exists():
        try:
            from monarchmoney import MonarchMoney
            global mm
            if mm is None:
                client = MonarchMoney()
                client.load_session(str(SESSION_FILE))
                mm = client
            # Try a lightweight call to verify session is valid
            await mm.get_accounts()
            return AuthStatusResponse(
                authenticated=True,
                email=os.getenv("MONARCH_EMAIL", "authenticated"),
                session_file=str(SESSION_FILE),
                mode="live",
            )
        except Exception as e:
            logger.warning("Session invalid: %s", e)
            return AuthStatusResponse(authenticated=False, mode="live")
    else:
        return AuthStatusResponse(authenticated=False, mode="live")


@app.post("/auth/logout")
async def auth_logout():
    """Clear cached session and log out."""
    global mm
    mm = None

    if SESSION_FILE.exists():
        SESSION_FILE.unlink()
        logger.info("Session file removed: %s", SESSION_FILE)

    return {"status": "logged_out", "message": "Session cleared"}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    """Health check and session status."""
    if DEMO_MODE:
        return {"status": "ok", "mode": "demo", "authenticated": True}
    try:
        await get_client()
        return {"status": "ok", "mode": "live", "authenticated": True}
    except Exception as e:
        logger.warning("Health check failed: %s", e)
        return {"status": "error", "mode": "live", "authenticated": False, "error": str(e)}


@app.post("/sync")
async def sync_transactions(
    days: int = Query(90, ge=1, le=365, description="Number of days to sync"),
):
    """Trigger a full transaction sync for Mission Control.

    This is the primary endpoint Mission Control calls to pull fresh data.
    Returns a summary of what was synced.
    """
    start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    end_date = datetime.now().strftime("%Y-%m-%d")
    logger.info("Sync triggered: %s to %s (%d days)", start_date, end_date, days)

    if DEMO_MODE:
        data = DemoProvider.get_transactions(start_date, end_date, 5000)
        accounts = DemoProvider.get_accounts()
        return SyncResponse(
            status="complete",
            mode="demo",
            transactions_fetched=data["total"],
            accounts_synced=len(accounts["accounts"]),
            sync_timestamp=datetime.now().isoformat(),
            date_range={"start": start_date, "end": end_date},
        )

    try:
        client = await get_client()
        transactions = await client.get_transactions(start_date=start_date, end_date=end_date)
        results = transactions.get("allTransactions", {}).get("results", [])
        accounts = await client.get_accounts()
        account_list = accounts.get("accounts", []) if isinstance(accounts, dict) else []

        logger.info("Sync complete: %d transactions, %d accounts", len(results), len(account_list))
        return SyncResponse(
            status="complete",
            mode="live",
            transactions_fetched=len(results),
            accounts_synced=len(account_list),
            sync_timestamp=datetime.now().isoformat(),
            date_range={"start": start_date, "end": end_date},
        )
    except Exception as e:
        logger.error("Sync failed: %s", e, exc_info=True)
        raise HTTPException(500, f"Sync failed: {e}")


@app.get("/transactions")
async def get_transactions(
    start_date: Optional[str] = Query(None, description="ISO date string (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="ISO date string (YYYY-MM-DD)"),
    account_id: Optional[str] = Query(None),
    category_id: Optional[str] = Query(None),
    limit: int = Query(500, ge=1, le=5000),
):
    """Fetch transactions with optional filters."""
    if not start_date:
        days = int(os.getenv("DEFAULT_TRANSACTION_DAYS", "90"))
        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    if DEMO_MODE:
        return DemoProvider.get_transactions(start_date, end_date, limit, account_id, category_id)

    client = await get_client()
    try:
        transactions = await client.get_transactions(start_date=start_date, end_date=end_date)
        results = transactions.get("allTransactions", {}).get("results", [])

        if account_id:
            results = [t for t in results if t.get("account", {}).get("id") == account_id]
        if category_id:
            results = [t for t in results if t.get("category", {}).get("id") == category_id]

        return {"transactions": results[:limit], "total": len(results)}
    except Exception as e:
        logger.error("Failed to fetch transactions: %s", e)
        raise HTTPException(500, f"Failed to fetch transactions: {e}")


@app.get("/transactions/{transaction_id}")
async def get_transaction(transaction_id: str):
    """Get a single transaction's details."""
    if DEMO_MODE:
        tx = DemoProvider.get_transaction_detail(transaction_id)
        if tx is None:
            raise HTTPException(404, f"Transaction {transaction_id} not found")
        return tx

    client = await get_client()
    try:
        result = await client.get_transaction_details(transaction_id)
        return result
    except Exception as e:
        raise HTTPException(404, f"Transaction not found: {e}")


@app.patch("/transactions/{transaction_id}/category")
async def update_transaction_category(transaction_id: str, update: CategoryUpdate):
    """Update a transaction's category in Monarch."""
    if DEMO_MODE:
        logger.info("Demo: category update for %s -> %s", transaction_id, update.category_id)
        return {"status": "updated", "transaction_id": transaction_id, "category_id": update.category_id}

    client = await get_client()
    try:
        await client.update_transaction_category(transaction_id, update.category_id)
        return {"status": "updated", "transaction_id": transaction_id, "category_id": update.category_id}
    except Exception as e:
        raise HTTPException(500, f"Failed to update category: {e}")


@app.get("/categories")
async def get_categories():
    """List all transaction categories."""
    if DEMO_MODE:
        return DemoProvider.get_categories()

    client = await get_client()
    try:
        categories = await client.get_transaction_categories()
        return categories
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch categories: {e}")


@app.get("/accounts")
async def get_accounts():
    """List all connected accounts."""
    if DEMO_MODE:
        return DemoProvider.get_accounts()

    client = await get_client()
    try:
        accounts = await client.get_accounts()
        return accounts
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch accounts: {e}")


@app.get("/recurring")
async def get_recurring():
    """List recurring/subscription transactions."""
    if DEMO_MODE:
        return DemoProvider.get_recurring()

    client = await get_client()
    try:
        recurring = await client.get_recurring_transactions()
        return recurring
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch recurring: {e}")


@app.get("/cashflow")
async def get_cashflow(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
):
    """Get cash flow summary (income vs expenses)."""
    if not start_date:
        start_date = datetime.now().replace(day=1).strftime("%Y-%m-%d")
    if not end_date:
        end_date = datetime.now().strftime("%Y-%m-%d")

    if DEMO_MODE:
        return DemoProvider.get_cashflow(start_date, end_date)

    client = await get_client()
    try:
        cashflow = await client.get_cashflow(start_date=start_date, end_date=end_date)
        return cashflow
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch cashflow: {e}")


@app.get("/budgets")
async def get_budgets():
    """Get budget status per category."""
    if DEMO_MODE:
        return DemoProvider.get_budgets()

    client = await get_client()
    try:
        budgets = await client.get_budgets()
        return budgets
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch budgets: {e}")


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Monarch Money Bridge Service")
    parser.add_argument("--setup", action="store_true", help="Interactive first-time login")
    parser.add_argument("--demo", action="store_true", help="Run with mock data (no credentials needed)")
    parser.add_argument("--port", type=int, default=None, help="Override port")
    args = parser.parse_args()

    if args.demo:
        DEMO_MODE = True
        os.environ["DEMO_MODE"] = "true"

    if args.setup:
        from monarchmoney import MonarchMoney

        async def setup():
            client = MonarchMoney()
            await client.interactive_login()
            client.save_session(str(SESSION_FILE))
            print(f"Session saved to {SESSION_FILE}")

        asyncio.run(setup())
    else:
        host = os.getenv("BRIDGE_HOST", "0.0.0.0")
        port = args.port or int(os.getenv("BRIDGE_PORT", "8100"))
        logger.info("Starting Monarch Bridge on %s:%d (demo=%s)", host, port, DEMO_MODE)
        uvicorn.run(app, host=host, port=port)
