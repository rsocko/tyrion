"""Versioned public DTOs and Monarch response normalizers."""

from datetime import date, datetime, timezone
from typing import Any, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "1.0"


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class ContractResponse(ApiModel):
    contract_version: str = CONTRACT_VERSION


class Provenance(ApiModel):
    provider: Literal["demo", "live"]
    fetched_at: datetime


class DataResponse(ContractResponse):
    provenance: Provenance


class ContractInfoResponse(ContractResponse):
    stability: Literal["stable"] = "stable"
    supported_versions: list[str] = Field(default_factory=lambda: [CONTRACT_VERSION])


class HealthResponse(ContractResponse):
    status: Literal["ok", "error"]
    mode: Literal["demo", "live"]
    authenticated: bool


class AuthStatusResponse(ContractResponse):
    authenticated: bool
    email: Optional[str] = None
    mode: Literal["demo", "live"]


class AuthActionResponse(ContractResponse):
    status: Literal["success", "mfa_required", "logged_out"]
    message: str
    email: Optional[str] = None


class Merchant(ApiModel):
    name: str
    logo_url: Optional[str] = None


class CategoryRef(ApiModel):
    id: str
    name: str


class AccountRef(ApiModel):
    id: str
    display_name: str
    mask: Optional[str] = None


class Transaction(ApiModel):
    id: str
    date: date
    amount: float
    merchant: Merchant
    category: Optional[CategoryRef] = None
    account: AccountRef
    is_pending: bool = False
    is_recurring: bool = False
    notes: Optional[str] = None
    tags: list[str] = Field(default_factory=list)


class PageInfo(ApiModel):
    limit: int
    next_cursor: Optional[str] = None


class TransactionsResponse(DataResponse):
    transactions: list[Transaction]
    total: int
    page: PageInfo


class TransactionResponse(DataResponse):
    transaction: Transaction


class Category(ApiModel):
    id: str
    name: str
    group: Optional[str] = None
    icon: Optional[str] = None


class CategoriesResponse(DataResponse):
    categories: list[Category]


class Account(ApiModel):
    id: str
    display_name: str
    type: str
    mask: Optional[str] = None
    institution: Optional[str] = None
    current_balance: float
    is_active: bool = True


class AccountsResponse(DataResponse):
    accounts: list[Account]


class RecurringObligation(ApiModel):
    id: str
    merchant: str
    amount: float
    frequency: str
    next_expected_date: Optional[date] = None
    account: Optional[AccountRef] = None
    category: Optional[CategoryRef] = None


class RecurringResponse(DataResponse):
    recurring: list[RecurringObligation]


class Budget(ApiModel):
    category: CategoryRef
    budgeted: float
    spent: float
    remaining: float
    percent_used: Optional[float] = None


class BudgetsResponse(DataResponse):
    budgets: list[Budget]


class CashflowCategory(ApiModel):
    category: str
    amount: float


class CashflowResponse(DataResponse):
    start_date: date
    end_date: date
    income: float
    expenses: float
    net: float
    by_category: list[CashflowCategory]


class DateRange(ApiModel):
    start: date
    end: date


class SyncResponse(DataResponse):
    status: Literal["complete"]
    transactions_fetched: int
    accounts_synced: int
    synced_at: datetime
    date_range: DateRange


class CategoryUpdateResponse(ContractResponse):
    status: Literal["updated"]
    transaction_id: str
    category_id: str


class ErrorDetail(ApiModel):
    code: str
    message: str


class ErrorResponse(ContractResponse):
    error: ErrorDetail


def provenance(provider: Literal["demo", "live"]) -> Provenance:
    return Provenance(provider=provider, fetched_at=datetime.now(timezone.utc))


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _pick(value: Any, *paths: str, default: Any = None) -> Any:
    for path in paths:
        current = value
        for part in path.split("."):
            current = _mapping(current).get(part)
            if current is None:
                break
        if current is not None:
            return current
    return default


def _text(value: Any, default: str = "") -> str:
    if isinstance(value, Mapping):
        value = value.get("name") or value.get("displayName")
    return str(value) if value is not None else default


def _money(value: Any) -> float:
    return round(float(value or 0), 2)


def _date(value: Any) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _items(payload: Any, *paths: str) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [_mapping(item) for item in payload]
    values = _pick(payload, *paths, default=[])
    return [_mapping(item) for item in values] if isinstance(values, list) else []


def normalize_category_ref(raw: Any) -> Optional[CategoryRef]:
    value = _mapping(raw)
    identifier = _pick(value, "id")
    if not identifier:
        return None
    return CategoryRef(id=str(identifier), name=_text(_pick(value, "name"), "Uncategorized"))


def normalize_account_ref(raw: Any) -> AccountRef:
    value = _mapping(raw)
    return AccountRef(
        id=str(_pick(value, "id", default="unknown")),
        display_name=_text(_pick(value, "displayName", "display_name", "name"), "Unknown account"),
        mask=_pick(value, "mask", "last4"),
    )


def normalize_transaction(raw: Any) -> Transaction:
    value = _mapping(raw)
    merchant = _mapping(_pick(value, "merchant", default={}))
    tags = _pick(value, "tags", default=[])
    return Transaction(
        id=str(_pick(value, "id")),
        date=_date(_pick(value, "date", "postedDate", "createdAt")),
        amount=_money(_pick(value, "amount")),
        merchant=Merchant(
            name=_text(_pick(merchant, "name", default=_pick(value, "merchantName")), "Unknown merchant"),
            logo_url=_pick(merchant, "logoUrl", "logo_url"),
        ),
        category=normalize_category_ref(_pick(value, "category", default={})),
        account=normalize_account_ref(_pick(value, "account", default={})),
        is_pending=bool(_pick(value, "isPending", "pending", default=False)),
        is_recurring=bool(_pick(value, "isRecurring", "recurring", default=False)),
        notes=_pick(value, "notes"),
        tags=[_text(_pick(tag, "name", default=tag)) for tag in tags] if isinstance(tags, list) else [],
    )


def normalize_transactions(payload: Any) -> list[Transaction]:
    return [
        normalize_transaction(item)
        for item in _items(payload, "transactions", "allTransactions.results", "results")
    ]


def normalize_categories(payload: Any) -> list[Category]:
    return [
        Category(
            id=str(_pick(item, "id")),
            name=_text(_pick(item, "name")),
            group=_text(_pick(item, "group.name", "group"), "") or None,
            icon=_pick(item, "icon"),
        )
        for item in _items(payload, "categories", "transactionCategories", "results")
    ]


def normalize_accounts(payload: Any) -> list[Account]:
    return [
        Account(
            id=str(_pick(item, "id")),
            display_name=_text(_pick(item, "displayName", "name"), "Unknown account"),
            type=_text(_pick(item, "type.name", "type"), "unknown"),
            mask=_pick(item, "mask", "last4"),
            institution=_text(_pick(item, "institution.name", "institution"), "") or None,
            current_balance=_money(_pick(item, "currentBalance", "balance")),
            is_active=(
                bool(_pick(item, "isActive", "active"))
                if _pick(item, "isActive", "active") is not None
                else not bool(_pick(item, "deactivatedAt"))
            ),
        )
        for item in _items(payload, "accounts", "results")
    ]


def normalize_recurring(payload: Any) -> list[RecurringObligation]:
    items = _items(
        payload,
        "recurring",
        "recurringTransactions",
        "recurringTransactionItems",
        "results",
    )
    return [
        RecurringObligation(
            id=str(_pick(item, "id", "stream.id")),
            merchant=_text(
                _pick(item, "merchant.name", "merchant", "stream.merchant.name"),
                "Unknown merchant",
            ),
            amount=_money(_pick(item, "amount", "lastAmount", "stream.amount")),
            frequency=_text(
                _pick(item, "frequency", "cadence", "stream.frequency"),
                "unknown",
            ),
            next_expected_date=(
                _date(_pick(item, "nextExpectedDate", "nextDate", "date"))
                if _pick(item, "nextExpectedDate", "nextDate", "date")
                else None
            ),
            account=(
                normalize_account_ref(_pick(item, "account"))
                if _pick(item, "account")
                else None
            ),
            category=normalize_category_ref(_pick(item, "category", default={})),
        )
        for item in items
    ]


def normalize_budgets(payload: Any) -> list[Budget]:
    items = _items(payload, "budgets", "results")
    budget_rows = _items(payload, "budgetData.monthlyAmountsByCategory")
    category_names = {
        str(_pick(category, "id")): _text(_pick(category, "name"), "Uncategorized")
        for group in _items(payload, "categoryGroups")
        for category in _items(group, "categories")
    }
    if budget_rows:
        items = []
        for row in budget_rows:
            category_id = str(_pick(row, "category.id"))
            for monthly in _items(row, "monthlyAmounts"):
                items.append({
                    "category": {
                        "id": category_id,
                        "name": category_names.get(category_id, "Uncategorized"),
                    },
                    "budgeted": _pick(
                        monthly,
                        "plannedCashFlowAmount",
                        "plannedSetAsideAmount",
                        default=0,
                    ),
                    "spent": _pick(monthly, "actualAmount", default=0),
                })
    normalized = []
    for index, item in enumerate(items):
        category_raw = _pick(item, "category", default={})
        if not isinstance(category_raw, Mapping):
            category_raw = {
                "id": _pick(item, "categoryId", default=f"category-{index}"),
                "name": category_raw,
            }
        category = normalize_category_ref(category_raw) or CategoryRef(
            id=str(_pick(item, "categoryId", default=f"category-{index}")),
            name=_text(_pick(item, "categoryName"), "Uncategorized"),
        )
        budgeted = abs(_money(_pick(item, "budgeted", "budgetAmount", "planned")))
        spent = abs(_money(_pick(item, "spent", "actual")))
        remaining = _money(budgeted - spent)
        percent = _pick(item, "percentUsed")
        normalized.append(Budget(
            category=category,
            budgeted=budgeted,
            spent=spent,
            remaining=remaining,
            percent_used=abs(round(float(percent), 2)) if percent is not None else (
                round(abs(spent) / abs(budgeted) * 100, 2) if budgeted else None
            ),
        ))
    return normalized


def normalize_cashflow(
    payload: Any,
    start: str,
    end: str,
    provider: Literal["demo", "live"],
) -> CashflowResponse:
    income = abs(_money(_pick(payload, "income", "totalIncome", "summary.summary.sumIncome")))
    raw_expenses = _money(
        _pick(payload, "expenses", "totalExpenses", "summary.summary.sumExpense")
    )
    expenses = -abs(raw_expenses)
    net = _money(_pick(payload, "net", "netCashflow", default=income + expenses))
    categories = []
    for item in _items(payload, "byCategory", "by_category", "categories"):
        amount = _money(_pick(item, "amount", "summary.sum"))
        category_type = _text(_pick(item, "groupBy.category.group.type"), "").lower()
        if category_type == "expense":
            amount = -abs(amount)
        elif category_type == "income":
            amount = abs(amount)
        categories.append(CashflowCategory(
            category=_text(
                _pick(item, "category.name", "category", "groupBy.category.name"),
                "Uncategorized",
            ),
            amount=amount,
        ))
    return CashflowResponse(
        provenance=provenance(provider),
        start_date=_date(_pick(payload, "startDate", default=start)),
        end_date=_date(_pick(payload, "endDate", default=end)),
        income=income,
        expenses=expenses,
        net=net,
        by_category=categories,
    )
