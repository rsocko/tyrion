"""
Monarch Money Bridge Service
FastAPI wrapper around monarchmoneycommunity for Mission Control integration.

Run with --demo flag to use mock data (no Monarch credentials needed).
"""

import asyncio
import base64
import binascii
import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Path as PathParam, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from bridge_runtime import (
    AuthState,
    BridgeSettings,
    InvalidSessionError,
    RedactingFilter,
    SessionInUseError,
    SessionManager,
    UpstreamFailure,
    classify_failure,
)
from contract import (
    CONTRACT_VERSION,
    AccountsResponse,
    AuthActionResponse,
    AuthStatusResponse,
    BudgetsResponse,
    CashflowResponse,
    CategoriesResponse,
    CategoryUpdateResponse,
    ContractInfoResponse,
    ErrorDetail,
    ErrorResponse,
    HealthResponse,
    PageInfo,
    RecurringResponse,
    SyncResponse,
    TransactionResponse,
    TransactionSplitsResponse,
    TransactionsResponse,
    normalize_accounts,
    normalize_budgets,
    normalize_cashflow,
    normalize_categories,
    normalize_recurring,
    normalize_transaction,
    normalize_transaction_splits,
    normalize_transactions,
    provenance,
)

if os.getenv("BRIDGE_LOAD_DOTENV", "").lower() in ("1", "true", "yes"):
    load_dotenv()

SETTINGS = BridgeSettings.from_env()
session_manager = SessionManager(SETTINGS.session_file)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("monarch_bridge")
logger.addFilter(RedactingFilter())


def create_monarch_client():
    from monarchmoney import MonarchMoney

    return MonarchMoney()


def upstream_error(resource: str, exc: Exception) -> HTTPException:
    failure = classify_failure(exc)
    logger.warning("Monarch %s request failed (%s)", resource, failure.value)
    if failure == UpstreamFailure.EXPIRED:
        session_manager.clear(AuthState.EXPIRED)
        return HTTPException(
            401,
            detail={
                "error": "session_expired",
                "message": "The Monarch session expired; authenticate again",
            },
        )
    if failure == UpstreamFailure.TIMEOUT:
        return HTTPException(
            504,
            detail={"error": "upstream_timeout", "message": "Monarch did not respond in time"},
        )
    if failure == UpstreamFailure.RATE_LIMITED:
        return HTTPException(
            429,
            detail={"error": "upstream_rate_limited", "message": "Monarch rate limited the request"},
        )
    return HTTPException(
        502,
        detail={
            "error": "upstream_error",
            "message": f"Monarch {resource} request failed",
        },
    )

# ---------------------------------------------------------------------------
# Demo mode detection (set via --demo flag or DEMO_MODE env var)
# ---------------------------------------------------------------------------
DEMO_MODE: bool = os.getenv("DEMO_MODE", "").lower() in ("1", "true", "yes")
MAX_TRANSACTION_DAYS = 366
MAX_TRANSACTION_SCAN_ITEMS = 5000
MAX_SPLIT_ITEMS = 100
MAX_AMOUNT = Decimal("999999999.99")
TRANSACTION_QUERY_PARAMETERS = {
    "start_date",
    "end_date",
    "account_id",
    "category_id",
    "merchant_query",
    "tag_id",
    "min_amount",
    "max_amount",
    "is_pending",
    "is_recurring",
    "limit",
    "cursor",
}
TRANSACTION_SINGLETON_PARAMETERS = TRANSACTION_QUERY_PARAMETERS - {"tag_id"}


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
                    "isRecurring": cat_id == "cat-streaming",
                    "notes": None,
                    "tags": [
                        {"id": "tag-household", "name": "Household"},
                        *(
                            [{"id": "tag-subscription", "name": "Subscription"}]
                            if cat_id == "cat-streaming"
                            else []
                        ),
                    ],
                })
                transactions[-1]["isPending"] = tx_id % 11 == 0
                tx_id += 1
            current += timedelta(days=1)

        transactions.sort(key=lambda t: t["date"], reverse=True)
        return transactions[:limit]

    @classmethod
    def get_transactions(cls, start_date: str, end_date: Optional[str], limit: int,
                         account_id: Optional[str] = None, category_id: Optional[str] = None,
                         merchant_query: Optional[str] = None,
                         tag_ids: Optional[list[str]] = None,
                         min_amount: Optional[Decimal] = None,
                         max_amount: Optional[Decimal] = None,
                         is_pending: Optional[bool] = None,
                         is_recurring: Optional[bool] = None) -> dict:
        results = cls._generate_transactions(start_date, end_date, limit)
        if account_id:
            results = [t for t in results if t["account"]["id"] == account_id]
        if category_id:
            results = [t for t in results if t["category"]["id"] == category_id]
        if merchant_query:
            query = " ".join(merchant_query.casefold().split())
            results = [
                t for t in results
                if query in " ".join(t["merchant"]["name"].casefold().split())
            ]
        if tag_ids:
            wanted = set(tag_ids)
            results = [
                t for t in results
                if wanted.intersection(tag["id"] for tag in t["tags"])
            ]
        if min_amount is not None:
            results = [t for t in results if Decimal(str(t["amount"])) >= min_amount]
        if max_amount is not None:
            results = [t for t in results if Decimal(str(t["amount"])) <= max_amount]
        if is_pending is not None:
            results = [t for t in results if t["isPending"] is is_pending]
        if is_recurring is not None:
            results = [t for t in results if t["isRecurring"] is is_recurring]
        return {"transactions": results, "total": len(results)}

    @classmethod
    def get_transaction_detail(cls, transaction_id: str) -> dict:
        all_tx = cls._generate_transactions("2024-01-01", None, 5000)
        for tx in all_tx:
            if tx["id"] == transaction_id:
                return tx
        return None

    @classmethod
    def get_transaction_splits(cls, transaction_id: str) -> Optional[dict]:
        transaction = cls.get_transaction_detail(transaction_id)
        if transaction is None:
            return None
        amount = Decimal(str(transaction["amount"]))
        first_amount = (amount * Decimal("0.60")).quantize(Decimal("0.01"))
        return {
            "getTransaction": {
                "id": transaction_id,
                "splitTransactions": [
                    {
                        "id": f"{transaction_id}-split-1",
                        "amount": float(first_amount),
                        "merchant": {"name": transaction["merchant"]["name"]},
                        "category": transaction["category"],
                    },
                    {
                        "id": f"{transaction_id}-split-2",
                        "amount": float(amount - first_amount),
                        "merchant": {"name": transaction["merchant"]["name"]},
                        "category": None,
                    },
                ],
            },
        }

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
async def get_client():
    """Get or initialize the Monarch Money client (live mode only)."""
    if DEMO_MODE:
        raise RuntimeError("get_client() should not be called in demo mode")

    try:
        return await session_manager.get_client(create_monarch_client)
    except SessionInUseError:
        raise HTTPException(
            409,
            detail={
                "error": "session_in_use",
                "message": "Another bridge process owns the Monarch session",
            },
        )
    except FileNotFoundError:
        raise HTTPException(
            401,
            detail={"error": "not_authenticated", "message": "Authenticate with the bridge first"},
        )
    except InvalidSessionError:
        logger.warning("Stored Monarch session could not be loaded")
        raise HTTPException(
            401,
            detail={
                "error": "session_expired",
                "message": "The Monarch session is invalid; authenticate again",
            },
        )
    except Exception:
        logger.error("Monarch client could not be initialized")
        raise HTTPException(
            503,
            detail={
                "error": "bridge_unavailable",
                "message": "The Monarch client is unavailable",
            },
        )


# ---------------------------------------------------------------------------
# App lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    mode = "DEMO" if DEMO_MODE else "LIVE"
    logger.info("Monarch Bridge starting in %s mode", mode)
    yield
    logger.info("Monarch Bridge shutting down")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Monarch Bridge",
    version=CONTRACT_VERSION,
    description="Independent, unofficial interoperability bridge between Mission "
                "Control and Monarch Money. Run with --demo flag for development "
                "without credentials.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.allowed_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Bridge-Token"],
)


@app.middleware("http")
async def secure_bridge_request(request: Request, call_next):
    if request.url.path.startswith("/auth/") and request.method == "POST":
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > SETTINGS.max_auth_body_bytes:
                    return error_response(413, "payload_too_large", "Authentication payload is too large")
            except ValueError:
                return error_response(400, "invalid_request", "Content-Length is invalid")
        body = await request.body()
        if len(body) > SETTINGS.max_auth_body_bytes:
            return error_response(413, "payload_too_large", "Authentication payload is too large")

    public_path = request.url.path in {"/", "/health", "/contract"}
    client_host = request.client.host if request.client else None
    service_auth_required = SETTINGS.request_requires_service_auth(client_host)
    if (
        request.method != "OPTIONS"
        and not public_path
        and not SETTINGS.authorizes(
            request.headers.get("authorization"),
            request.headers.get("x-bridge-token"),
            required=service_auth_required,
        )
    ):
        return error_response(401, "bridge_auth_required", "Bridge authentication is required")

    query_error = validate_inquiry_query(request)
    if query_error is not None:
        return query_error

    response = await call_next(request)
    response.headers["X-Monarch-Contract-Version"] = CONTRACT_VERSION
    if request.url.path.startswith("/auth/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    payload = ErrorResponse(error=ErrorDetail(code=code, message=message))
    return JSONResponse(
        status_code=status_code,
        content=payload.model_dump(mode="json", by_alias=True),
        headers={"X-Monarch-Contract-Version": CONTRACT_VERSION},
    )


def validate_inquiry_query(request: Request) -> Optional[JSONResponse]:
    if request.method != "GET":
        return None
    path = request.url.path
    if path == "/transactions":
        pairs = list(request.query_params.multi_items())
        unknown = sorted({name for name, _ in pairs} - TRANSACTION_QUERY_PARAMETERS)
        if unknown:
            return error_response(400, "invalid_request", f"Unknown query parameter: {unknown[0]}")
        for name in TRANSACTION_SINGLETON_PARAMETERS:
            if len(request.query_params.getlist(name)) > 1:
                return error_response(400, "invalid_request", f"{name} may be specified only once")
        tag_values = request.query_params.getlist("tag_id")
        if len({value.strip() for value in tag_values}) > 20:
            return error_response(422, "invalid_request", "tag_id accepts at most 20 unique values")
        for name in ("is_pending", "is_recurring"):
            value = request.query_params.get(name)
            if value is not None and value not in {"true", "false"}:
                return error_response(422, "invalid_request", f"{name} must be true or false")
    elif path.startswith("/transactions/") and request.query_params:
        name = next(iter(request.query_params))
        return error_response(400, "invalid_request", f"Unknown query parameter: {name}")
    return None


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        code = str(detail.get("error", "request_failed"))
        message = str(detail.get("message", code.replace("_", " ").capitalize()))
    else:
        code = "not_found" if exc.status_code == 404 else "request_failed"
        message = str(detail)
    return error_response(exc.status_code, code, message)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    first = exc.errors()[0]
    location = ".".join(str(part) for part in first["loc"] if part != "query")
    message = f"{location}: {first['msg']}" if location else first["msg"]
    return error_response(422, "invalid_request", message)


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s %s", request.method, request.url.path)
    return error_response(500, "internal_error", "The bridge could not complete the request")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class CategoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    categoryId: str = Field(min_length=1, max_length=512)

    @field_validator("categoryId")
    @classmethod
    def category_id_must_not_be_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("categoryId must not be empty")
        return value.strip()


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)
    mfaCode: Optional[str] = Field(default=None, min_length=4, max_length=32)

    @field_validator("email")
    @classmethod
    def email_must_be_well_formed(cls, value: str) -> str:
        value = value.strip()
        if "@" not in value or value.startswith("@") or value.endswith("@"):
            raise ValueError("email must be valid")
        return value


class CookieLoginRequest(BaseModel):
    sessionId: str = Field(min_length=1, max_length=6000)
    csrfToken: str = Field(min_length=1, max_length=6000)

    @field_validator("sessionId", "csrfToken")
    @classmethod
    def cookie_value_must_be_safe(cls, value: str) -> str:
        value = value.strip()
        if not value or any(character in value for character in (";", "\r", "\n")):
            raise ValueError("cookie value contains invalid characters")
        return value


# ---------------------------------------------------------------------------
# Auth Endpoints
# ---------------------------------------------------------------------------
@app.post("/auth/login", response_model=AuthActionResponse)
async def auth_login(request: LoginRequest):
    """Authenticate with Monarch Money using email/password + optional email OTP code.

    Flow:
    1. First call with email/password returns mfa_required when Monarch requests a code.
    2. Second call with email/password/mfaCode completes authentication.
    """
    if DEMO_MODE:
        return AuthActionResponse(
            status="success",
            message="Demo mode - no real auth needed",
            email=request.email,
        )

    try:
        client = create_monarch_client()

        if request.mfaCode:
            await client.multi_factor_authenticate(request.email, request.password, request.mfaCode)
            session_manager.establish(client, request.email)
            logger.info("MFA login successful")
            return AuthActionResponse(
                status="success",
                message="Authenticated successfully",
                email=request.email,
            )

        await client.login(
            request.email,
            request.password,
            use_saved_session=False,
            save_session=False,
        )
        session_manager.establish(client, request.email)
        logger.info("Login successful")
        return AuthActionResponse(
            status="success",
            message="Authenticated successfully",
            email=request.email,
        )

    except HTTPException:
        raise
    except SessionInUseError:
        raise HTTPException(
            409,
            detail={
                "error": "session_in_use",
                "message": "Another bridge process owns the Monarch session",
            },
        )
    except Exception as exc:
        failure = classify_failure(exc, login_flow=True)
        logger.info("Login failed (%s)", failure.value)
        if failure == UpstreamFailure.MFA_REQUIRED:
            raise HTTPException(
                403,
                detail={
                    "error": "mfa_required",
                    "message": (
                        "Monarch rejected programmatic login. It may require MFA, "
                        "browser verification, or CAPTCHA. If MFA is disabled, use "
                        "browser cookies instead."
                    ),
                },
            )
        if failure == UpstreamFailure.INVALID_CREDENTIALS:
            raise HTTPException(401, detail={"error": "invalid_credentials", "message": "Invalid email or password"})
        if failure == UpstreamFailure.INVALID_MFA:
            raise HTTPException(
                401,
                detail={"error": "invalid_mfa", "message": "The verification code is invalid or expired"},
            )
        if failure == UpstreamFailure.CAPTCHA_REQUIRED:
            raise HTTPException(403, detail={
                "error": "captcha_required",
                "message": "Monarch requires CAPTCHA. Use cookie-based login instead: log in via browser, then paste your cookies."
            })
        if failure == UpstreamFailure.TIMEOUT:
            raise HTTPException(
                504,
                detail={"error": "upstream_timeout", "message": "Monarch did not respond in time"},
            )
        if failure == UpstreamFailure.RATE_LIMITED:
            raise HTTPException(
                429,
                detail={"error": "upstream_rate_limited", "message": "Try again later"},
            )
        raise HTTPException(
            502,
            detail={"error": "login_failed", "message": "Monarch authentication failed"},
        )


@app.post("/auth/login-with-cookies", response_model=AuthActionResponse)
async def auth_login_cookies(request: CookieLoginRequest):
    """Authenticate using browser cookies (bypasses CAPTCHA).

    Steps for user:
    1. Log into app.monarchmoney.com in a browser.
    2. Copy the Cookie request header from the browser's developer tools.
    3. Submit the cookie string to this endpoint.
    """
    if DEMO_MODE:
        return AuthActionResponse(status="success", message="Demo mode - no real auth needed")

    try:
        client = create_monarch_client()
        cookie_header = (
            f"session_id={request.sessionId}; csrftoken={request.csrfToken}"
        )
        await client.login_with_cookies(cookie_header, save_session=False)
        session_manager.establish(client)
        logger.info("Cookie-based login successful")
        return AuthActionResponse(status="success", message="Authenticated via browser cookies")

    except Exception as exc:
        if isinstance(exc, SessionInUseError):
            raise HTTPException(
                409,
                detail={
                    "error": "session_in_use",
                    "message": "Another bridge process owns the Monarch session",
                },
            )
        failure = classify_failure(exc, login_flow=True)
        logger.info("Cookie login failed (%s)", failure.value)
        status = 504 if failure == UpstreamFailure.TIMEOUT else 401
        code = "upstream_timeout" if failure == UpstreamFailure.TIMEOUT else "cookie_login_failed"
        raise HTTPException(
            status,
            detail={"error": code, "message": "Cookie authentication failed"},
        )


@app.get("/auth/status", response_model=AuthStatusResponse)
async def auth_status():
    """Check whether the current session is active."""
    if DEMO_MODE:
        return AuthStatusResponse(
            authenticated=True,
            auth_state=AuthState.CONNECTED.value,
            email="demo@example.com",
            mode="demo",
        )

    state = await session_manager.verify(create_monarch_client)
    return AuthStatusResponse(
        authenticated=state == AuthState.CONNECTED,
        auth_state=state.value,
        email=session_manager.email if state == AuthState.CONNECTED else None,
        mode="live",
    )


@app.post("/auth/logout", response_model=AuthActionResponse)
async def auth_logout():
    """Clear cached session and log out."""
    try:
        session_manager.clear()
    except SessionInUseError:
        raise HTTPException(
            409,
            detail={
                "error": "session_in_use",
                "message": "Another bridge process owns the Monarch session",
            },
        )
    logger.info("Bridge-managed session cleared")
    return AuthActionResponse(status="logged_out", message="Session cleared")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/contract", response_model=ContractInfoResponse)
async def contract_info():
    """Return the stable API contract version implemented by this service."""
    return ContractInfoResponse()


@app.get("/health", response_model=HealthResponse)
async def health():
    """Return reachability and the last known authentication state."""
    if DEMO_MODE:
        return HealthResponse(
            status="ok",
            mode="demo",
            authenticated=True,
            auth_state=AuthState.CONNECTED.value,
        )
    state = session_manager.state
    return HealthResponse(
        status="ok" if state in (AuthState.CONNECTED, AuthState.UNAUTHENTICATED) else "degraded",
        mode="live",
        authenticated=state == AuthState.CONNECTED,
        auth_state=state.value,
    )


@app.get("/", response_model=HealthResponse, include_in_schema=False)
async def root():
    """Expose bridge health at the production ingress root."""
    return await health()


@app.post("/sync", response_model=SyncResponse)
async def sync_transactions(
    days: int = Query(90, ge=1, le=365, description="Number of days to sync"),
):
    """Trigger a full transaction sync for Mission Control.

    This is the primary endpoint Mission Control calls to pull fresh data.
    Returns a summary of what was synced.
    """
    start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    end_date = datetime.now().strftime("%Y-%m-%d")
    logger.info("Sync triggered")

    if DEMO_MODE:
        data = DemoProvider.get_transactions(start_date, end_date, 5000)
        accounts = DemoProvider.get_accounts()
        return SyncResponse(
            status="complete",
            provenance=provenance("demo"),
            transactions_fetched=data["total"],
            accounts_synced=len(accounts["accounts"]),
            synced_at=datetime.now(timezone.utc),
            date_range={"start": start_date, "end": end_date},
        )

    client = await get_client()
    try:
        transactions_fetched = 0
        offset = 0
        while True:
            transactions = await client.get_transactions(
                limit=5000,
                offset=offset,
                start_date=start_date,
                end_date=end_date,
            )
            all_transactions = transactions.get("allTransactions", {})
            results = all_transactions.get("results", [])
            transactions_fetched += len(results)
            total = int(all_transactions.get("totalCount", transactions_fetched))
            if not results or transactions_fetched >= total:
                break
            offset += len(results)

        accounts = await client.get_accounts()
        account_list = accounts.get("accounts", []) if isinstance(accounts, dict) else []

        logger.info("Sync complete")
        return SyncResponse(
            status="complete",
            provenance=provenance("live"),
            transactions_fetched=transactions_fetched,
            accounts_synced=len(account_list),
            synced_at=datetime.now(timezone.utc),
            date_range={"start": start_date, "end": end_date},
        )
    except Exception as e:
        raise upstream_error("sync", e)


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode()).decode().rstrip("=")


def decode_cursor(cursor: Optional[str]) -> int:
    if cursor is None:
        return 0
    if len(cursor) > 128:
        raise HTTPException(400, detail={"error": "invalid_cursor", "message": "Cursor is invalid"})
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        offset = int(base64.b64decode(padded, altchars=b"-_", validate=True).decode())
    except (ValueError, UnicodeDecodeError, binascii.Error):
        raise HTTPException(400, detail={"error": "invalid_cursor", "message": "Cursor is invalid"})
    if offset < 0 or offset > 2_147_483_647:
        raise HTTPException(400, detail={"error": "invalid_cursor", "message": "Cursor is invalid"})
    return offset


def normalize_filter_id(value: Optional[str], name: str) -> Optional[str]:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        raise HTTPException(
            422,
            detail={"error": "invalid_request", "message": f"{name} must not be empty"},
        )
    if len(normalized) > 512:
        raise HTTPException(
            422,
            detail={
                "error": "invalid_request",
                "message": f"{name} must contain at most 512 characters",
            },
        )
    return normalized


def normalize_merchant_query(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = " ".join(value.split())
    if not normalized:
        raise HTTPException(
            422,
            detail={"error": "invalid_request", "message": "merchant_query must not be empty"},
        )
    if len(normalized) > 120:
        raise HTTPException(
            422,
            detail={
                "error": "invalid_request",
                "message": "merchant_query must contain at most 120 normalized characters",
            },
        )
    return normalized


def normalize_upstream_transaction_page(raw, requested_limit: int, provider_offset: int):
    if not isinstance(raw, dict):
        raise ValueError("Upstream transaction page was malformed")
    container = raw.get("allTransactions")
    if not isinstance(container, dict) or not isinstance(container.get("results"), list):
        raise ValueError("Upstream transaction page was malformed")
    page = normalize_transactions(raw)
    if len(page) > requested_limit:
        raise ValueError("Upstream transaction page exceeded the requested limit")
    total = container.get("totalCount")
    if isinstance(total, bool) or not isinstance(total, int):
        raise ValueError("Upstream transaction total was malformed")
    if total < 0:
        raise ValueError("Upstream transaction total was invalid")
    if page and provider_offset + len(page) > total:
        raise ValueError("Upstream transaction page contradicted its total")
    return page, total


def filter_normalized_transactions(transactions, merchant_query, min_amount, max_amount):
    if merchant_query:
        query = " ".join(merchant_query.casefold().split())
        transactions = [
            transaction
            for transaction in transactions
            if query in " ".join(transaction.merchant.name.casefold().split())
        ]
    if min_amount is not None:
        transactions = [
            transaction
            for transaction in transactions
            if Decimal(str(transaction.amount)) >= min_amount
        ]
    if max_amount is not None:
        transactions = [
            transaction
            for transaction in transactions
            if Decimal(str(transaction.amount)) <= max_amount
        ]
    return transactions


@app.get("/transactions", response_model=TransactionsResponse)
async def get_transactions(
    start_date: Optional[date] = Query(None, description="Inclusive start date"),
    end_date: Optional[date] = Query(None, description="Inclusive end date"),
    account_id: Optional[str] = Query(None),
    category_id: Optional[str] = Query(None),
    merchant_query: Optional[str] = Query(None),
    tag_id: Optional[list[str]] = Query(None),
    min_amount: Optional[Decimal] = Query(None, ge=-MAX_AMOUNT, le=MAX_AMOUNT),
    max_amount: Optional[Decimal] = Query(None, ge=-MAX_AMOUNT, le=MAX_AMOUNT),
    is_pending: Optional[bool] = Query(None),
    is_recurring: Optional[bool] = Query(None),
    limit: int = Query(500, ge=1, le=500),
    cursor: Optional[str] = Query(None, description="Opaque cursor returned by the previous page"),
):
    """Fetch transactions with optional filters."""
    if not start_date:
        days = int(os.getenv("DEFAULT_TRANSACTION_DAYS", "90"))
        start_date = (datetime.now() - timedelta(days=days)).date()
    if not end_date:
        end_date = datetime.now().date()
    if end_date and end_date < start_date:
        raise HTTPException(
            400,
            detail={"error": "invalid_date_range", "message": "end_date must be on or after start_date"},
        )
    if (end_date - start_date).days + 1 > MAX_TRANSACTION_DAYS:
        raise HTTPException(
            400,
            detail={
                "error": "invalid_date_range",
                "message": "Transaction queries may cover at most 366 inclusive days",
            },
        )
    if min_amount is not None and max_amount is not None and min_amount > max_amount:
        raise HTTPException(
            400,
            detail={"error": "invalid_amount_range", "message": "min_amount must not exceed max_amount"},
        )
    account_id = normalize_filter_id(account_id, "account_id")
    category_id = normalize_filter_id(category_id, "category_id")
    merchant_query = normalize_merchant_query(merchant_query)
    normalized_tag_ids = []
    for value in tag_id or []:
        normalized = normalize_filter_id(value, "tag_id")
        if normalized not in normalized_tag_ids:
            normalized_tag_ids.append(normalized)
    start_text = start_date.isoformat()
    end_text = end_date.isoformat()
    offset = decode_cursor(cursor)

    if DEMO_MODE:
        raw = DemoProvider.get_transactions(
            start_text,
            end_text,
            MAX_TRANSACTION_SCAN_ITEMS,
            account_id,
            category_id,
            merchant_query,
            normalized_tag_ids,
            min_amount,
            max_amount,
            is_pending,
            is_recurring,
        )
        provider = "demo"
        results = normalize_transactions(raw)
        total = len(results)
        page = results[offset:offset + limit]
    else:
        client = await get_client()
        try:
            provider_kwargs = {
                "start_date": start_text,
                "end_date": end_text,
                "account_ids": [account_id] if account_id else [],
                "category_ids": [category_id] if category_id else [],
                "tag_ids": normalized_tag_ids,
                "is_pending": is_pending,
                "is_recurring": is_recurring,
            }
            requires_normalized_filtering = (
                merchant_query is not None
                or min_amount is not None
                or max_amount is not None
            )
            if requires_normalized_filtering:
                results = []
                scan_offset = 0
                expected_provider_total = None
                while True:
                    raw = await client.get_transactions(
                        limit=500,
                        offset=scan_offset,
                        **provider_kwargs,
                    )
                    provider_page, provider_total = normalize_upstream_transaction_page(
                        raw,
                        500,
                        scan_offset,
                    )
                    if (
                        expected_provider_total is not None
                        and provider_total != expected_provider_total
                    ):
                        raise ValueError("Upstream transaction total changed during pagination")
                    expected_provider_total = provider_total
                    if provider_total > MAX_TRANSACTION_SCAN_ITEMS:
                        raise HTTPException(
                            400,
                            detail={
                                "error": "transaction_query_too_broad",
                                "message": "Narrow the transaction query before applying merchant or amount filters",
                            },
                        )
                    results.extend(provider_page)
                    if len(results) >= provider_total:
                        break
                    if not provider_page:
                        raise ValueError("Upstream transaction pagination ended unexpectedly")
                    scan_offset += len(provider_page)
                results = filter_normalized_transactions(
                    results,
                    merchant_query,
                    min_amount,
                    max_amount,
                )
                total = len(results)
                page = results[offset:offset + limit]
            else:
                raw = await client.get_transactions(
                    limit=limit,
                    offset=offset,
                    **provider_kwargs,
                )
                page, total = normalize_upstream_transaction_page(raw, limit, offset)
                if not page and offset < total:
                    raise ValueError("Upstream transaction pagination ended unexpectedly")
        except HTTPException:
            raise
        except Exception as e:
            raise upstream_error("transaction", e)
        provider = "live"
    next_offset = offset + len(page)
    return TransactionsResponse(
        provenance=provenance(provider),
        transactions=page,
        total=total,
        page=PageInfo(
            limit=limit,
            next_cursor=encode_cursor(next_offset) if next_offset < total else None,
        ),
    )


@app.get(
    "/transactions/{transaction_id}/splits",
    response_model=TransactionSplitsResponse,
)
async def get_transaction_splits(
    transaction_id: str = PathParam(..., min_length=1, max_length=512),
):
    """Get bounded normalized split detail for one transaction."""
    if DEMO_MODE:
        raw = DemoProvider.get_transaction_splits(transaction_id)
        if raw is None:
            raise HTTPException(
                404,
                detail={
                    "error": "transaction_not_found",
                    "message": f"Transaction {transaction_id} was not found",
                },
            )
        return TransactionSplitsResponse(
            provenance=provenance("demo"),
            transaction_id=transaction_id,
            splits=normalize_transaction_splits(raw),
        )

    client = await get_client()
    try:
        raw = await client.get_transaction_splits(transaction_id)
        transaction = raw.get("getTransaction") if isinstance(raw, dict) else None
        if transaction is None:
            raise HTTPException(
                404,
                detail={
                    "error": "transaction_not_found",
                    "message": f"Transaction {transaction_id} was not found",
                },
            )
        splits = normalize_transaction_splits(raw)
        if len(splits) > MAX_SPLIT_ITEMS:
            raise ValueError("Upstream split detail exceeded the item limit")
        return TransactionSplitsResponse(
            provenance=provenance("live"),
            transaction_id=transaction_id,
            splits=splits,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise upstream_error("transaction splits", e)


@app.get("/transactions/{transaction_id}", response_model=TransactionResponse)
async def get_transaction(
    transaction_id: str = PathParam(..., min_length=1, max_length=512),
):
    """Get a single transaction's details."""
    if DEMO_MODE:
        tx = DemoProvider.get_transaction_detail(transaction_id)
        if tx is None:
            raise HTTPException(
                404,
                detail={
                    "error": "transaction_not_found",
                    "message": f"Transaction {transaction_id} was not found",
                },
            )
        return TransactionResponse(
            provenance=provenance("demo"),
            transaction=normalize_transaction(tx),
        )

    client = await get_client()
    try:
        result = await client.get_transaction_details(transaction_id)
        raw = result.get("getTransaction") if isinstance(result, dict) else None
        if raw is None:
            raise HTTPException(
                404,
                detail={
                    "error": "transaction_not_found",
                    "message": f"Transaction {transaction_id} was not found",
                },
            )
        raw = dict(raw)
        category = raw.get("category")
        if isinstance(category, dict) and category.get("id") and not category.get("name"):
            categories = normalize_categories(await client.get_transaction_categories())
            category_name = next(
                (item.name for item in categories if item.id == category["id"]),
                "Uncategorized",
            )
            raw["category"] = {**category, "name": category_name}
        return TransactionResponse(
            provenance=provenance("live"),
            transaction=normalize_transaction(raw),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise upstream_error("transaction detail", e)


@app.patch("/transactions/{transaction_id}/category", response_model=CategoryUpdateResponse)
async def update_transaction_category(
    update: CategoryUpdate,
    transaction_id: str = PathParam(..., min_length=1, max_length=512),
):
    """Update a transaction's category in Monarch."""
    if DEMO_MODE:
        logger.info("Demo: category update for %s -> %s", transaction_id, update.categoryId)
        return CategoryUpdateResponse(
            status="updated",
            transaction_id=transaction_id,
            category_id=update.categoryId,
        )

    client = await get_client()
    try:
        result = await client.update_transaction(
            transaction_id,
            category_id=update.categoryId,
        )
        mutation = result.get("updateTransaction", {}) if isinstance(result, dict) else {}
        errors = mutation.get("errors") or []
        transaction = mutation.get("transaction") or {}
        category = transaction.get("category") or {}
        if errors or category.get("id") != update.categoryId:
            raise RuntimeError("Monarch rejected the category update")
        return CategoryUpdateResponse(
            status="updated",
            transaction_id=transaction_id,
            category_id=update.categoryId,
        )
    except Exception as e:
        raise upstream_error("category update", e)


@app.get("/categories", response_model=CategoriesResponse)
async def get_categories():
    """List all transaction categories."""
    if DEMO_MODE:
        return CategoriesResponse(
            provenance=provenance("demo"),
            categories=normalize_categories(DemoProvider.get_categories()),
        )

    client = await get_client()
    try:
        categories = await client.get_transaction_categories()
        return CategoriesResponse(
            provenance=provenance("live"),
            categories=normalize_categories(categories),
        )
    except Exception as e:
        raise upstream_error("category", e)


@app.get("/accounts", response_model=AccountsResponse)
async def get_accounts():
    """List all connected accounts."""
    if DEMO_MODE:
        return AccountsResponse(
            provenance=provenance("demo"),
            accounts=normalize_accounts(DemoProvider.get_accounts()),
        )

    client = await get_client()
    try:
        accounts = await client.get_accounts()
        return AccountsResponse(
            provenance=provenance("live"),
            accounts=normalize_accounts(accounts),
        )
    except Exception as e:
        raise upstream_error("account", e)


@app.get("/recurring", response_model=RecurringResponse)
async def get_recurring():
    """List recurring/subscription transactions."""
    if DEMO_MODE:
        return RecurringResponse(
            provenance=provenance("demo"),
            recurring=normalize_recurring(DemoProvider.get_recurring()),
        )

    client = await get_client()
    try:
        recurring = await client.get_recurring_transactions()
        return RecurringResponse(
            provenance=provenance("live"),
            recurring=normalize_recurring(recurring),
        )
    except Exception as e:
        raise upstream_error("recurring transaction", e)


@app.get("/cashflow", response_model=CashflowResponse)
async def get_cashflow(
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
):
    """Get cash flow summary (income vs expenses)."""
    if not start_date:
        start_date = datetime.now().replace(day=1).date()
    if not end_date:
        end_date = datetime.now().date()
    if end_date < start_date:
        raise HTTPException(
            400,
            detail={"error": "invalid_date_range", "message": "end_date must be on or after start_date"},
        )
    start_text = start_date.isoformat()
    end_text = end_date.isoformat()

    if DEMO_MODE:
        return normalize_cashflow(
            DemoProvider.get_cashflow(start_text, end_text),
            start_text,
            end_text,
            "demo",
        )

    client = await get_client()
    try:
        cashflow = await client.get_cashflow(start_date=start_text, end_date=end_text)
        return normalize_cashflow(cashflow, start_text, end_text, "live")
    except Exception as e:
        raise upstream_error("cash flow", e)


@app.get("/budgets", response_model=BudgetsResponse)
async def get_budgets():
    """Get budget status per category."""
    if DEMO_MODE:
        return BudgetsResponse(
            provenance=provenance("demo"),
            budgets=normalize_budgets(DemoProvider.get_budgets()),
        )

    client = await get_client()
    try:
        today = datetime.now().date()
        budgets = await client.get_budgets(
            start_date=today.replace(day=1).isoformat(),
            end_date=today.isoformat(),
        )
        return BudgetsResponse(
            provenance=provenance("live"),
            budgets=normalize_budgets(budgets),
        )
    except Exception as e:
        raise upstream_error("budget", e)


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
        async def setup():
            client = create_monarch_client()
            await client.interactive_login()
            session_manager.establish(client)
            print("Bridge authentication configured")

        asyncio.run(setup())
    else:
        host = SETTINGS.host
        port = args.port or SETTINGS.port
        logger.info("Starting Monarch Bridge on %s:%d (demo=%s)", host, port, DEMO_MODE)
        uvicorn.run(app, host=host, port=port, access_log=False)
