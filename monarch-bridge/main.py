"""
Monarch Money Bridge Service
FastAPI wrapper around monarchmoneycommunity for Mission Control integration.
"""

import asyncio
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from monarchmoney import MonarchMoney
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Monarch Bridge", version="0.1.0")

# Global Monarch client
mm: Optional[MonarchMoney] = None


class CategoryUpdate(BaseModel):
    category_id: str


async def get_client() -> MonarchMoney:
    """Get or initialize the Monarch Money client."""
    global mm
    if mm is None:
        mm = MonarchMoney()
        session_file = Path(os.getenv("SESSION_FILE", "~/.monarch_session")).expanduser()

        if session_file.exists():
            mm.load_session(str(session_file))
        else:
            email = os.getenv("MONARCH_EMAIL")
            password = os.getenv("MONARCH_PASSWORD")
            mfa_secret = os.getenv("MONARCH_MFA_SECRET")

            if not email or not password:
                raise HTTPException(500, "MONARCH_EMAIL and MONARCH_PASSWORD must be set")

            if mfa_secret:
                await mm.login(email, password, mfa_secret_key=mfa_secret)
            else:
                await mm.login(email, password)

            mm.save_session(str(session_file))

    return mm


@app.get("/health")
async def health():
    """Health check and session status."""
    try:
        client = await get_client()
        return {"status": "ok", "authenticated": True}
    except Exception as e:
        return {"status": "error", "authenticated": False, "error": str(e)}


@app.get("/transactions")
async def get_transactions(
    start_date: Optional[str] = Query(None, description="ISO date string (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="ISO date string (YYYY-MM-DD)"),
    account_id: Optional[str] = Query(None),
    category_id: Optional[str] = Query(None),
    limit: int = Query(500, ge=1, le=5000),
):
    """Fetch transactions with optional filters."""
    client = await get_client()

    # Default to last N days if no dates specified
    if not start_date:
        days = int(os.getenv("DEFAULT_TRANSACTION_DAYS", "90"))
        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

    try:
        transactions = await client.get_transactions(
            start_date=start_date,
            end_date=end_date,
        )
        # Filter by account/category if specified
        results = transactions.get("allTransactions", {}).get("results", [])

        if account_id:
            results = [t for t in results if t.get("account", {}).get("id") == account_id]
        if category_id:
            results = [t for t in results if t.get("category", {}).get("id") == category_id]

        return {"transactions": results[:limit], "total": len(results)}
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch transactions: {e}")


@app.get("/transactions/{transaction_id}")
async def get_transaction(transaction_id: str):
    """Get a single transaction's details."""
    client = await get_client()
    try:
        result = await client.get_transaction_details(transaction_id)
        return result
    except Exception as e:
        raise HTTPException(404, f"Transaction not found: {e}")


@app.patch("/transactions/{transaction_id}/category")
async def update_transaction_category(transaction_id: str, update: CategoryUpdate):
    """Update a transaction's category in Monarch."""
    client = await get_client()
    try:
        await client.update_transaction_category(transaction_id, update.category_id)
        return {"status": "updated", "transaction_id": transaction_id, "category_id": update.category_id}
    except Exception as e:
        raise HTTPException(500, f"Failed to update category: {e}")


@app.get("/categories")
async def get_categories():
    """List all transaction categories."""
    client = await get_client()
    try:
        categories = await client.get_transaction_categories()
        return categories
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch categories: {e}")


@app.get("/accounts")
async def get_accounts():
    """List all connected accounts."""
    client = await get_client()
    try:
        accounts = await client.get_accounts()
        return accounts
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch accounts: {e}")


@app.get("/recurring")
async def get_recurring():
    """List recurring/subscription transactions."""
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
    client = await get_client()
    try:
        if not start_date:
            start_date = datetime.now().replace(day=1).strftime("%Y-%m-%d")
        if not end_date:
            end_date = datetime.now().strftime("%Y-%m-%d")

        cashflow = await client.get_cashflow(start_date=start_date, end_date=end_date)
        return cashflow
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch cashflow: {e}")


@app.get("/budgets")
async def get_budgets():
    """Get budget status per category."""
    client = await get_client()
    try:
        budgets = await client.get_budgets()
        return budgets
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch budgets: {e}")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true", help="Interactive first-time login")
    args = parser.parse_args()

    if args.setup:
        async def setup():
            client = MonarchMoney()
            await client.interactive_login()
            session_file = Path(os.getenv("SESSION_FILE", "~/.monarch_session")).expanduser()
            client.save_session(str(session_file))
            print(f"Session saved to {session_file}")

        asyncio.run(setup())
    else:
        host = os.getenv("BRIDGE_HOST", "0.0.0.0")
        port = int(os.getenv("BRIDGE_PORT", "8100"))
        uvicorn.run(app, host=host, port=port)
