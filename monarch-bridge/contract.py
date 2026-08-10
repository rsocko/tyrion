"""Versioned public DTOs and Monarch response normalizers."""

from datetime import date, datetime, timezone
from typing import Any, Literal, Mapping, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "1.0"
MAX_ACCOUNTS = 1_000
MAX_CATEGORY_GROUPS = 250
MAX_CATEGORIES = 2_000
MAX_TRANSACTION_TAGS = 1_000
MAX_RECURRING_OBLIGATIONS = 5_000
MAX_BUDGET_ROWS = 5_000


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        allow_inf_nan=False,
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
    status: Literal["ok", "degraded"]
    mode: Literal["demo", "live"]
    reachable: bool = True
    authenticated: bool
    auth_state: Literal["unauthenticated", "connected", "expired", "degraded"]


class AuthStatusResponse(ContractResponse):
    authenticated: bool
    auth_state: Literal["unauthenticated", "connected", "expired", "degraded"]
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


class TransactionTagRef(ApiModel):
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
    tag_references: list[TransactionTagRef] = Field(default_factory=list)


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
    group_id: Optional[str] = None
    group: Optional[str] = None
    icon: Optional[str] = None
    is_active: bool = True


class CategoriesResponse(DataResponse):
    categories: list[Category] = Field(max_length=MAX_CATEGORIES)


class CategoryGroup(ApiModel):
    id: str
    name: str
    is_active: bool = True


class CategoryGroupsResponse(DataResponse):
    category_groups: list[CategoryGroup] = Field(max_length=MAX_CATEGORY_GROUPS)


class TransactionTag(ApiModel):
    id: str
    name: str
    is_active: bool = True


class TransactionTagsResponse(DataResponse):
    tags: list[TransactionTag] = Field(max_length=MAX_TRANSACTION_TAGS)


class Account(ApiModel):
    id: str
    display_name: str
    type: str
    mask: Optional[str] = None
    institution: Optional[str] = None
    current_balance: float
    is_active: bool = True


class AccountsResponse(DataResponse):
    accounts: list[Account] = Field(max_length=MAX_ACCOUNTS)


class RecurringObligation(ApiModel):
    id: str
    merchant: str
    amount: float
    frequency: str
    next_expected_date: Optional[date] = None
    account: Optional[AccountRef] = None
    category: Optional[CategoryRef] = None


class RecurringResponse(DataResponse):
    recurring: list[RecurringObligation] = Field(
        max_length=MAX_RECURRING_OBLIGATIONS
    )


class Budget(ApiModel):
    category: CategoryRef
    budgeted: float
    spent: float
    remaining: float
    percent_used: Optional[float] = None


class BudgetsResponse(DataResponse):
    period_start: date
    period_end: date
    budgets: list[Budget] = Field(max_length=MAX_BUDGET_ROWS)


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


def _required_text(value: Any) -> str:
    text = _text(value).strip()
    if not text:
        raise ValueError("Required upstream text is missing")
    return text


def _money(value: Any) -> float:
    return round(float(value or 0), 2)


def _identifier(value: Any) -> str:
    identifier = str(value).strip() if value is not None else ""
    if not identifier:
        raise ValueError("Required upstream identifier is missing")
    return identifier


def _optional_text(value: Any) -> Optional[str]:
    if value is None or isinstance(value, (Mapping, list, tuple, set)):
        return None
    return str(value)


def _optional_http_url(value: Any) -> Optional[str]:
    if value is None:
        return None
    candidate = str(value).strip()
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return None
    return candidate if parsed.scheme in ("http", "https") and parsed.netloc else None


def _date(value: Any) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _items(payload: Any, *paths: str) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        return [_mapping(item) for item in payload]
    values = _pick(payload, *paths, default=[])
    return [_mapping(item) for item in values] if isinstance(values, list) else []


def _bounded_items(
    payload: Any,
    dataset: str,
    maximum: int,
    *paths: str,
) -> list[Mapping[str, Any]]:
    if isinstance(payload, list):
        values = payload
    elif isinstance(payload, Mapping):
        missing = object()
        values: Any = missing
        for path in paths:
            current: Any = payload
            for part in path.split("."):
                if not isinstance(current, Mapping) or part not in current:
                    current = missing
                    break
                current = current[part]
            if current is not missing:
                values = current
                break
        if values is missing:
            raise ValueError(f"Upstream {dataset} collection is missing")
    else:
        raise ValueError(f"Upstream {dataset} response must be an object or array")
    if not isinstance(values, list):
        raise ValueError(f"Upstream {dataset} collection must be an array")
    if len(values) > maximum:
        raise ValueError(f"Upstream {dataset} collection exceeded {maximum} items")
    if any(not isinstance(item, Mapping) for item in values):
        raise ValueError(f"Upstream {dataset} collection contains an invalid item")
    return list(values)


def normalize_category_ref(raw: Any) -> Optional[CategoryRef]:
    value = _mapping(raw)
    identifier = _pick(value, "id")
    if not identifier:
        return None
    return CategoryRef(id=_identifier(identifier), name=_text(_pick(value, "name"), "Uncategorized"))


def normalize_transaction_tag_ref(raw: Any) -> TransactionTagRef:
    if not isinstance(raw, Mapping):
        raise ValueError("Upstream transaction tag must be an object")
    return TransactionTagRef(
        id=_identifier(_pick(raw, "id")),
        name=_required_text(_pick(raw, "name")),
    )


def normalize_account_ref(raw: Any) -> AccountRef:
    value = _mapping(raw)
    return AccountRef(
        id=_identifier(_pick(value, "id")),
        display_name=_text(_pick(value, "displayName", "display_name", "name"), "Unknown account"),
        mask=_optional_text(_pick(value, "mask", "last4")),
    )


def normalize_transaction(raw: Any) -> Transaction:
    value = _mapping(raw)
    merchant = _mapping(_pick(value, "merchant", default={}))
    tags = _pick(value, "tags", default=[])
    if not isinstance(tags, list):
        raise ValueError("Upstream transaction tags must be an array")
    tag_references = [normalize_transaction_tag_ref(tag) for tag in tags]
    return Transaction(
        id=_identifier(_pick(value, "id")),
        date=_date(_pick(value, "date", "postedDate", "createdAt")),
        amount=_money(_pick(value, "amount")),
        merchant=Merchant(
            name=_text(_pick(merchant, "name", default=_pick(value, "merchantName")), "Unknown merchant"),
            logo_url=_optional_http_url(_pick(merchant, "logoUrl", "logo_url")),
        ),
        category=normalize_category_ref(_pick(value, "category", default={})),
        account=normalize_account_ref(_pick(value, "account", default={})),
        is_pending=bool(_pick(value, "isPending", "pending", default=False)),
        is_recurring=bool(_pick(value, "isRecurring", "recurring", default=False)),
        notes=_optional_text(_pick(value, "notes")),
        tags=[tag.name for tag in tag_references],
        tag_references=tag_references,
    )


def normalize_transactions(payload: Any) -> list[Transaction]:
    return [
        normalize_transaction(item)
        for item in _items(payload, "transactions", "allTransactions.results", "results")
    ]


def normalize_categories(payload: Any) -> list[Category]:
    normalized = []
    for item in _bounded_items(
        payload,
        "categories",
        MAX_CATEGORIES,
        "categories",
        "transactionCategories",
        "results",
    ):
        group = _pick(item, "group")
        group_id = _optional_text(_pick(item, "groupId"))
        group_name = _text(group, "") or None
        if isinstance(group, Mapping):
            group_id = _identifier(_pick(group, "id"))
        normalized.append(
            Category(
                id=_identifier(_pick(item, "id")),
                name=_required_text(_pick(item, "name")),
                group_id=group_id,
                group=group_name,
                icon=_optional_text(_pick(item, "icon")),
                is_active=not bool(_pick(item, "isDisabled", default=False)),
            )
        )
    return normalized


def normalize_category_groups(payload: Any) -> list[CategoryGroup]:
    return [
        CategoryGroup(
            id=_identifier(_pick(item, "id")),
            name=_required_text(_pick(item, "name")),
            is_active=not bool(_pick(item, "isDisabled", default=False)),
        )
        for item in _bounded_items(
            payload,
            "category groups",
            MAX_CATEGORY_GROUPS,
            "categoryGroups",
            "transactionCategoryGroups",
            "results",
        )
    ]


def normalize_transaction_tags(payload: Any) -> list[TransactionTag]:
    return [
        TransactionTag(
            id=_identifier(_pick(item, "id")),
            name=_required_text(_pick(item, "name")),
            is_active=not bool(_pick(item, "isDisabled", default=False)),
        )
        for item in _bounded_items(
            payload,
            "transaction tags",
            MAX_TRANSACTION_TAGS,
            "householdTransactionTags",
            "transactionTags",
            "tags",
            "results",
        )
    ]


def normalize_accounts(payload: Any) -> list[Account]:
    return [
        Account(
            id=_identifier(_pick(item, "id")),
            display_name=_required_text(_pick(item, "displayName", "name")),
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
        for item in _bounded_items(
            payload,
            "accounts",
            MAX_ACCOUNTS,
            "accounts",
            "results",
        )
    ]


def normalize_recurring(payload: Any) -> list[RecurringObligation]:
    items = _bounded_items(
        payload,
        "recurring obligations",
        MAX_RECURRING_OBLIGATIONS,
        "recurring",
        "recurringTransactions",
        "recurringTransactionItems",
        "results",
    )
    return [
        RecurringObligation(
            id=_identifier(_pick(item, "id", "stream.id")),
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


def normalize_budgets(payload: Any, period_start: Optional[date] = None) -> list[Budget]:
    budget_rows = []
    if isinstance(payload, Mapping) and "budgetData" in payload:
        budget_rows = _bounded_items(
            payload,
            "budget rows",
            MAX_BUDGET_ROWS,
            "budgetData.monthlyAmountsByCategory",
        )
        items: list[Mapping[str, Any]] = []
    else:
        items = _bounded_items(
            payload,
            "budget rows",
            MAX_BUDGET_ROWS,
            "budgets",
            "results",
        )
    category_names = {}
    category_count = 0
    category_groups = (
        _bounded_items(
            payload,
            "budget category groups",
            MAX_CATEGORY_GROUPS,
            "categoryGroups",
        )
        if budget_rows
        else []
    )
    for group in category_groups:
        categories = _bounded_items(
            group,
            "budget categories",
            MAX_CATEGORIES,
            "categories",
        )
        category_count += len(categories)
        if category_count > MAX_CATEGORIES:
            raise ValueError(
                f"Upstream budget categories exceeded {MAX_CATEGORIES} items"
            )
        for category in categories:
            category_names[_identifier(_pick(category, "id"))] = _required_text(
                _pick(category, "name")
            )
    if budget_rows:
        for row in budget_rows:
            category_id = _identifier(_pick(row, "category.id"))
            monthly_amounts = _bounded_items(
                row,
                "budget monthly amounts",
                1,
                "monthlyAmounts",
            )
            for monthly in monthly_amounts:
                month = _date(_pick(monthly, "month"))
                if period_start is not None and month != period_start:
                    raise ValueError("Upstream budget month did not match the requested period")
                items.append({
                    "category": {
                        "id": category_id,
                        "name": category_names.get(category_id),
                    },
                    "budgeted": _pick(
                        monthly,
                        "plannedCashFlowAmount",
                        "plannedSetAsideAmount",
                        default=0,
                    ),
                    "spent": _pick(monthly, "actualAmount", default=0),
                })
        if len(items) > MAX_BUDGET_ROWS:
            raise ValueError(f"Upstream budget rows exceeded {MAX_BUDGET_ROWS} items")
    normalized = []
    for item in items:
        category_raw = _pick(item, "category", default={})
        if not isinstance(category_raw, Mapping):
            category_raw = {"id": _pick(item, "categoryId"), "name": category_raw}
        category = CategoryRef(
            id=_identifier(_pick(category_raw, "id", default=_pick(item, "categoryId"))),
            name=_required_text(
                _pick(category_raw, "name", default=_pick(item, "categoryName"))
            ),
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
