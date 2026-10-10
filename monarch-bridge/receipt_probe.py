"""Isolated validation adapter for private Monarch receipt operations.

This module intentionally does not define Bridge API routes or public DTOs. Callers
must supply the client owned by the Bridge session manager.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Awaitable, Callable, Literal, Protocol
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from gql import gql


ReceiptSource = Literal["upload", "email"]
ReceiptStatus = Literal[
    "in_progress",
    "pending",
    "pending_matches",
    "completed",
    "failed",
]

MAX_RECEIPT_PAGE = 100
MAX_RECEIPT_ATTACHMENTS = 10
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
MAX_POLL_ATTEMPTS = 8
MAX_POLL_SECONDS = 120.0
MAX_RECEIPT_SEARCH_PAGES = 5
MAX_TRANSACTION_ATTACHMENTS = 25
MAX_CANDIDATE_AGE = timedelta(days=14)
ALLOWED_DOWNLOAD_TYPES = frozenset(
    {"image/jpeg", "image/png", "application/pdf"}
)
TERMINAL_RECEIPT_STATUSES = frozenset({"pending_matches", "completed", "failed"})
_SOURCE_VENDOR = {"upload": "user_import", "email": "email_import"}
_VENDOR_SOURCE = {value: key for key, value in _SOURCE_VENDOR.items()}
_ALLOWED_ASSET_HOST_SUFFIXES = (".cloudinary.com",)
_ALLOWED_UPLOAD_HOSTS = frozenset({"api.cloudinary.com"})


class GraphQLClient(Protocol):
    async def gql_call(
        self,
        operation: str,
        graphql_query: object,
        variables: dict[str, object],
    ) -> dict[str, object]: ...


class ReceiptProbeError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AttachmentMetadata:
    id: str
    filename: str | None
    extension: str | None
    size_bytes: int | None
    download_available: bool
    _asset_url: str | None = field(default=None, repr=False, compare=False)

    def to_result(self) -> dict[str, object]:
        return {
            "id": self.id,
            "filename": self.filename,
            "extension": self.extension,
            "sizeBytes": self.size_bytes,
            "downloadAvailable": self.download_available,
        }


@dataclass(frozen=True)
class ReceiptRecord:
    id: str
    source: ReceiptSource
    status: ReceiptStatus
    created_at: str | None
    linked_transaction_id: str | None
    attachments: tuple[AttachmentMetadata, ...]

    def to_result(self) -> dict[str, object]:
        return {
            "id": self.id,
            "source": self.source,
            "status": self.status,
            "createdAt": self.created_at,
            "linkedTransactionId": self.linked_transaction_id,
            "attachments": [
                attachment.to_result() for attachment in self.attachments
            ],
        }


@dataclass(frozen=True)
class ReceiptPage:
    receipts: tuple[ReceiptRecord, ...]
    total_count: int
    limit: int
    offset: int

    def to_result(self) -> dict[str, object]:
        return {
            "receipts": [receipt.to_result() for receipt in self.receipts],
            "totalCount": self.total_count,
            "limit": self.limit,
            "offset": self.offset,
        }


@dataclass(frozen=True)
class TransactionAttachmentSnapshot:
    transaction_id: str
    attachments: tuple[AttachmentMetadata, ...]



_RECEIPT_FIELDS = """
fragment TyrionReceiptProbeFields on RetailSync {
  id
  vendor
  status
  createdAt
  orders {
    retailTransactions {
      id
      transaction {
        id
      }
    }
  }
  attachments {
    id
    filename
    extension
    sizeBytes
    originalAssetUrl
  }
}
"""

_LIST_RECEIPTS_QUERY = gql(
    """
query Common_RetailSyncsQueryWithTotal(
  $filters: RetailSyncFilterInput!
  $offset: Int!
  $limit: Int!
  $includeTotalCount: Boolean
) {
  retailSyncsWithTotal(
    filters: $filters
    offset: $offset
    limit: $limit
    includeTotalCount: $includeTotalCount
  ) {
    totalCount
    results {
      ...TyrionReceiptProbeFields
    }
  }
}
"""
    + _RECEIPT_FIELDS
)

_GET_RECEIPT_QUERY = gql(
    """
query Common_RetailSyncQuery($syncId: ID!) {
  retailSync(id: $syncId) {
    ...TyrionReceiptProbeFields
  }
}
"""
    + _RECEIPT_FIELDS
)

_CREATE_RECEIPT_MUTATION = gql(
    """
mutation Common_CreateRetailSync($input: CreateRetailSyncInput!) {
  createRetailSync(input: $input) {
    retailSync {
      id
      vendor
      status
      createdAt
    }
    errors {
      code
    }
  }
}
"""
)

_START_RECEIPT_MUTATION = gql(
    """
mutation Common_StartRetailSync($syncId: ID!) {
  startRetailSync(id: $syncId) {
    retailSync {
      id
      vendor
      status
      createdAt
    }
    errors {
      code
    }
  }
}
"""
)

_DELETE_RECEIPT_MUTATION = gql(
    """
mutation Common_DeleteRetailSync($syncId: ID!) {
  deleteUnmatchedRetailSync(id: $syncId) {
    success
    errors {
      code
    }
  }
}
"""
)

_MATCH_RECEIPT_MUTATION = gql(
    """
mutation Common_MatchRetailTransaction(
  $retailTransactionId: ID!
  $transactionId: ID!
) {
  matchRetailTransaction(
    retailTransactionId: $retailTransactionId
    transactionId: $transactionId
  ) {
    retailSync {
      id
    }
    errors {
      code
    }
  }
}
"""
)

_UNMATCH_RECEIPT_MUTATION = gql(
    """
mutation Web_UnmatchRetailTransaction($retailTransactionId: ID!) {
  unmatchRetailTransaction(retailTransactionId: $retailTransactionId) {
    retailSync {
      id
    }
    errors {
      code
    }
  }
}
"""
)

_GET_TRANSACTION_ATTACHMENT_QUERY = gql(
    """
query Mobile_GetAttachmentDetails($attachmentId: UUID!) {
  transactionAttachment(id: $attachmentId) {
    id
    filename
    extension
    sizeBytes
    originalAssetUrl
  }
}
"""
)

_LIST_TRANSACTION_ATTACHMENTS_QUERY = gql(
    """
query GetTransactionDrawer($id: UUID!, $redirectPosted: Boolean) {
  getTransaction(id: $id, redirectPosted: $redirectPosted) {
    id
    pending
    attachments {
      id
      filename
      extension
      sizeBytes
      originalAssetUrl
    }
  }
}
"""
)

_GET_TRANSACTION_ATTACHMENT_UPLOAD_INFO_MUTATION = gql(
    """
mutation Common_GetTransactionAttachmentUploadInfo($transactionId: UUID!) {
  getTransactionAttachmentUploadInfo(transactionId: $transactionId) {
    info {
      path
      requestParams {
        timestamp
        folder
        signature
        api_key
        upload_preset
      }
    }
  }
}
"""
)

_ADD_TRANSACTION_ATTACHMENT_MUTATION = gql(
    """
mutation Common_AddTransactionAttachment(
  $input: TransactionAddAttachmentMutationInput!
) {
  addTransactionAttachment(input: $input) {
    attachment {
      id
      filename
      extension
      sizeBytes
      originalAssetUrl
    }
    errors {
      code
    }
  }
}
"""
)

_DELETE_TRANSACTION_ATTACHMENT_MUTATION = gql(
    """
mutation Web_TransactionDrawerDeleteAttachment($id: UUID!) {
  deleteTransactionAttachment(id: $id) {
    deleted
  }
}
"""
)


async def list_receipts(
    client: GraphQLClient,
    *,
    source: ReceiptSource,
    limit: int = 100,
    offset: int = 0,
) -> ReceiptPage:
    if source not in _SOURCE_VENDOR:
        raise ReceiptProbeError("invalid_source")
    if not 1 <= limit <= MAX_RECEIPT_PAGE or offset < 0:
        raise ReceiptProbeError("invalid_page")
    data = await _graphql(
        client,
        "Common_RetailSyncsQueryWithTotal",
        _LIST_RECEIPTS_QUERY,
        {
            "filters": {"vendor": _SOURCE_VENDOR[source]},
            "offset": offset,
            "limit": limit,
            "includeTotalCount": True,
        },
    )
    payload = _required_dict(data, "retailSyncsWithTotal")
    total_count = payload.get("totalCount")
    results = payload.get("results")
    if (
        isinstance(total_count, bool)
        or not isinstance(total_count, int)
        or total_count < 0
        or not isinstance(results, list)
        or len(results) > limit
    ):
        raise ReceiptProbeError("malformed_receipt_page")
    receipts = tuple(_normalize_receipt(item) for item in results)
    if offset + len(receipts) > total_count:
        raise ReceiptProbeError("malformed_receipt_page")
    return ReceiptPage(receipts, total_count, limit, offset)


async def get_receipt(
    client: GraphQLClient,
    receipt_id: str,
) -> ReceiptRecord | None:
    _validate_identifier(receipt_id)
    data = await _graphql(
        client,
        "Common_RetailSyncQuery",
        _GET_RECEIPT_QUERY,
        {"syncId": receipt_id},
    )
    raw = data.get("retailSync")
    if raw is None:
        return None
    return _normalize_receipt(raw)


async def find_receipt(
    client: GraphQLClient,
    receipt_id: str,
    *,
    source: ReceiptSource,
    page_size: int = 25,
    max_pages: int = MAX_RECEIPT_SEARCH_PAGES,
) -> ReceiptRecord | None:
    _validate_identifier(receipt_id)
    if not 1 <= max_pages <= MAX_RECEIPT_SEARCH_PAGES:
        raise ReceiptProbeError("invalid_page_limit")
    offset = 0
    for _ in range(max_pages):
        page = await list_receipts(
            client,
            source=source,
            limit=page_size,
            offset=offset,
        )
        for receipt in page.receipts:
            if receipt.id == receipt_id:
                return receipt
        offset += len(page.receipts)
        if not page.receipts or offset >= page.total_count:
            return None
    raise ReceiptProbeError("receipt_search_limit")


async def discover_matched_pdf_candidate(
    client: GraphQLClient,
    *,
    now: datetime | None = None,
    page_size: int = 25,
    max_pages: int = 2,
    maximum_age: timedelta = MAX_CANDIDATE_AGE,
) -> ReceiptRecord:
    if not 1 <= page_size <= MAX_RECEIPT_PAGE:
        raise ReceiptProbeError("invalid_page")
    if not 1 <= max_pages <= MAX_RECEIPT_SEARCH_PAGES:
        raise ReceiptProbeError("invalid_page_limit")
    if maximum_age <= timedelta(0) or maximum_age > MAX_CANDIDATE_AGE:
        raise ReceiptProbeError("invalid_candidate_window")
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        raise ReceiptProbeError("invalid_candidate_window")
    cutoff = reference.astimezone(timezone.utc) - maximum_age
    eligible: list[ReceiptRecord] = []
    offset = 0
    for _ in range(max_pages):
        page = await list_receipts(
            client,
            source="upload",
            limit=page_size,
            offset=offset,
        )
        for receipt in page.receipts:
            created_at = _parse_created_at(receipt.created_at)
            if (
                created_at is None
                or created_at < cutoff
                or created_at > reference.astimezone(timezone.utc)
            ):
                continue
            if (
                receipt.linked_transaction_id is not None
                and any(
                    attachment.extension
                    and attachment.extension.lower() == "pdf"
                    for attachment in receipt.attachments
                )
            ):
                eligible.append(receipt)
        offset += len(page.receipts)
        if not page.receipts or offset >= page.total_count:
            break
    else:
        if offset < page.total_count:
            raise ReceiptProbeError("receipt_candidate_search_limit")
    if not eligible:
        raise ReceiptProbeError("receipt_candidate_not_found")
    if len(eligible) != 1:
        raise ReceiptProbeError("receipt_candidate_ambiguous")
    return eligible[0]


async def get_transaction_attachment(
    client: GraphQLClient,
    attachment_id: str,
) -> AttachmentMetadata | None:
    _validate_identifier(attachment_id)
    data = await _graphql(
        client,
        "Mobile_GetAttachmentDetails",
        _GET_TRANSACTION_ATTACHMENT_QUERY,
        {"attachmentId": attachment_id},
    )
    raw = data.get("transactionAttachment")
    if raw is None:
        return None
    return _normalize_attachment(raw)


async def list_transaction_attachments(
    client: GraphQLClient,
    transaction_id: str,
) -> TransactionAttachmentSnapshot:
    _validate_identifier(transaction_id)
    data = await _graphql(
        client,
        "GetTransactionDrawer",
        _LIST_TRANSACTION_ATTACHMENTS_QUERY,
        {"id": transaction_id, "redirectPosted": False},
    )
    raw = data.get("getTransaction")
    if raw is None:
        raise ReceiptProbeError("transaction_not_found")
    transaction = _as_dict(raw, "malformed_transaction")
    returned_id = transaction.get("id")
    if returned_id != transaction_id or transaction.get("pending") is not False:
        raise ReceiptProbeError("transaction_not_posted")
    raw_attachments = transaction.get("attachments")
    if (
        not isinstance(raw_attachments, list)
        or len(raw_attachments) > MAX_TRANSACTION_ATTACHMENTS
    ):
        raise ReceiptProbeError("malformed_transaction")
    return TransactionAttachmentSnapshot(
        transaction_id=transaction_id,
        attachments=tuple(
            _normalize_attachment(attachment) for attachment in raw_attachments
        ),
    )


async def upload_transaction_attachment(
    client: GraphQLClient,
    transaction_id: str,
    *,
    filename: str,
    content_type: str,
    content: bytes,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AttachmentMetadata:
    _validate_identifier(transaction_id)
    _validate_upload(filename, content_type, content)
    data = await _graphql(
        client,
        "Common_GetTransactionAttachmentUploadInfo",
        _GET_TRANSACTION_ATTACHMENT_UPLOAD_INFO_MUTATION,
        {"transactionId": transaction_id},
    )
    payload = _required_dict(data, "getTransactionAttachmentUploadInfo")
    info = _as_dict(payload.get("info"), "malformed_attachment_upload_info")
    public_id = await _upload_transaction_attachment_content(
        info,
        filename=filename,
        content_type=content_type,
        content=content,
        transport=transport,
    )
    extension = Path(filename).suffix.lstrip(".")
    data = await _graphql(
        client,
        "Common_AddTransactionAttachment",
        _ADD_TRANSACTION_ATTACHMENT_MUTATION,
        {
            "input": {
                "transactionId": transaction_id,
                "filename": Path(filename).stem,
                "publicId": public_id,
                "extension": extension,
                "sizeBytes": len(content),
            }
        },
    )
    payload = _mutation_payload(data, "addTransactionAttachment")
    return _normalize_attachment(
        _as_dict(payload.get("attachment"), "malformed_attachment")
    )


async def delete_transaction_attachment(
    client: GraphQLClient,
    attachment_id: str,
) -> bool:
    _validate_identifier(attachment_id)
    data = await _graphql(
        client,
        "Web_TransactionDrawerDeleteAttachment",
        _DELETE_TRANSACTION_ATTACHMENT_MUTATION,
        {"id": attachment_id},
    )
    payload = _required_dict(data, "deleteTransactionAttachment")
    deleted = payload.get("deleted")
    if not isinstance(deleted, bool):
        raise ReceiptProbeError("malformed_mutation_result")
    return deleted


async def create_receipt(client: GraphQLClient) -> ReceiptRecord:
    data = await _graphql(
        client,
        "Common_CreateRetailSync",
        _CREATE_RECEIPT_MUTATION,
        {"input": {"vendor": "user_import", "isBackfill": False}},
    )
    payload = _mutation_payload(data, "createRetailSync")
    return _normalize_receipt(_required_dict(payload, "retailSync"))


async def upload_receipt_file(
    client: object,
    receipt_id: str,
    path: Path,
) -> None:
    _validate_identifier(receipt_id)
    if not path.is_file():
        raise ReceiptProbeError("upload_file_missing")
    size = path.stat().st_size
    if size <= 0 or size > MAX_UPLOAD_BYTES:
        raise ReceiptProbeError("upload_size_invalid")
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = getattr(client, "_headers", None)
    if not isinstance(headers, dict):
        raise ReceiptProbeError("client_auth_unavailable")
    upload_headers = {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() != "content-type"
    }
    cookies = (
        getattr(client, "_cookies", None)
        if getattr(client, "_auth_mode", None) == "cookie"
        else None
    )
    metadata = {
        "orderId": str(uuid4()),
        "vendor": "user_import",
        "payloadType": "order",
        "contentType": content_type,
    }
    try:
        async with httpx.AsyncClient(
            headers=upload_headers,
            cookies=cookies,
            timeout=60.0,
            trust_env=True,
        ) as http:
            response = await http.post(
                f"https://api.monarch.com/retail-sync/{receipt_id}/files",
                data={
                    "payloads_count": "1",
                    "metadata_0": json.dumps(metadata, separators=(",", ":")),
                },
                files={"payload_0": (path.name, path.read_bytes(), content_type)},
            )
    except httpx.HTTPError as exc:
        raise ReceiptProbeError("receipt_upload_failed") from exc
    if response.status_code >= 400:
        raise ReceiptProbeError("receipt_upload_failed")


async def start_receipt(client: GraphQLClient, receipt_id: str) -> ReceiptRecord:
    _validate_identifier(receipt_id)
    data = await _graphql(
        client,
        "Common_StartRetailSync",
        _START_RECEIPT_MUTATION,
        {"syncId": receipt_id},
    )
    payload = _mutation_payload(data, "startRetailSync")
    return _normalize_receipt(_required_dict(payload, "retailSync"))


async def delete_receipt(client: GraphQLClient, receipt_id: str) -> bool:
    _validate_identifier(receipt_id)
    data = await _graphql(
        client,
        "Common_DeleteRetailSync",
        _DELETE_RECEIPT_MUTATION,
        {"syncId": receipt_id},
    )
    payload = _mutation_payload(data, "deleteUnmatchedRetailSync")
    success = payload.get("success")
    if not isinstance(success, bool):
        raise ReceiptProbeError("malformed_mutation_result")
    return success


async def match_receipt(
    client: GraphQLClient,
    receipt: ReceiptRecord,
    transaction_id: str,
) -> None:
    _validate_identifier(transaction_id)
    retail_transaction_id = await _retail_transaction_id(client, receipt.id)
    data = await _graphql(
        client,
        "Common_MatchRetailTransaction",
        _MATCH_RECEIPT_MUTATION,
        {
            "retailTransactionId": retail_transaction_id,
            "transactionId": transaction_id,
        },
    )
    _mutation_payload(data, "matchRetailTransaction")


async def unmatch_receipt(client: GraphQLClient, receipt: ReceiptRecord) -> None:
    retail_transaction_id = await _retail_transaction_id(client, receipt.id)
    data = await _graphql(
        client,
        "Web_UnmatchRetailTransaction",
        _UNMATCH_RECEIPT_MUTATION,
        {"retailTransactionId": retail_transaction_id},
    )
    _mutation_payload(data, "unmatchRetailTransaction")


async def poll_receipt(
    client: GraphQLClient,
    receipt_id: str,
    *,
    attempts: int = MAX_POLL_ATTEMPTS,
    timeout_seconds: float = MAX_POLL_SECONDS,
    initial_delay_seconds: float = 0.5,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> ReceiptRecord:
    if not 1 <= attempts <= MAX_POLL_ATTEMPTS:
        raise ReceiptProbeError("invalid_poll_limit")
    if not 0 < timeout_seconds <= MAX_POLL_SECONDS:
        raise ReceiptProbeError("invalid_poll_timeout")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_seconds
    delay = initial_delay_seconds
    last: ReceiptRecord | None = None
    for attempt in range(attempts):
        last = await get_receipt(client, receipt_id)
        if last is None:
            raise ReceiptProbeError("receipt_not_found")
        if last.status in TERMINAL_RECEIPT_STATUSES:
            return last
        if attempt + 1 >= attempts:
            break
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        await sleep(min(delay, remaining))
        delay = min(delay * 2, 8.0)
    raise ReceiptProbeError("receipt_poll_timeout")


async def download_attachment(
    attachment: AttachmentMetadata,
    *,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    if not 1 <= max_bytes <= MAX_DOWNLOAD_BYTES:
        raise ReceiptProbeError("invalid_download_limit")
    url = attachment._asset_url
    if not url or not _is_allowed_asset_url(url):
        raise ReceiptProbeError("attachment_url_invalid")
    if attachment.size_bytes is not None and attachment.size_bytes > max_bytes:
        raise ReceiptProbeError("attachment_too_large")
    try:
        async with httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=False,
            transport=transport,
            trust_env=transport is None,
        ) as http:
            async with http.stream("GET", url) as response:
                if response.status_code in (401, 403):
                    raise ReceiptProbeError("attachment_auth_rejected")
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").split(";", 1)[0]
                if content_type.lower() not in ALLOWED_DOWNLOAD_TYPES:
                    raise ReceiptProbeError("attachment_type_rejected")
                length = response.headers.get("content-length")
                if length is not None:
                    try:
                        if int(length) > max_bytes:
                            raise ReceiptProbeError("attachment_too_large")
                    except ValueError as exc:
                        raise ReceiptProbeError("attachment_length_invalid") from exc
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise ReceiptProbeError("attachment_too_large")
                    chunks.append(chunk)
    except ReceiptProbeError:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        raise ReceiptProbeError("attachment_download_failed") from exc
    return b"".join(chunks)


def attachments_match(
    expected: TransactionAttachmentSnapshot,
    actual: TransactionAttachmentSnapshot,
) -> bool:
    return (
        expected.transaction_id == actual.transaction_id
        and expected.attachments == actual.attachments
    )


async def _upload_transaction_attachment_content(
    info: dict[str, object],
    *,
    filename: str,
    content_type: str,
    content: bytes,
    transport: httpx.AsyncBaseTransport | None,
) -> str:
    raw_path = info.get("path")
    request_params = info.get("requestParams")
    if not isinstance(raw_path, str) or not isinstance(request_params, dict):
        raise ReceiptProbeError("malformed_attachment_upload_info")
    url = (
        raw_path
        if raw_path.startswith(("https://", "http://"))
        else f"https://api.cloudinary.com{raw_path}"
    )
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _ALLOWED_UPLOAD_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
    ):
        raise ReceiptProbeError("attachment_upload_url_invalid")
    form_data = {
        str(key): str(value)
        for key, value in request_params.items()
        if key != "__typename" and value is not None
    }
    try:
        async with httpx.AsyncClient(
            timeout=60.0,
            follow_redirects=False,
            transport=transport,
            trust_env=transport is None,
        ) as http:
            response = await http.post(
                url,
                data=form_data,
                files={"file": (filename, content, content_type)},
            )
        if response.status_code >= 400:
            raise ReceiptProbeError("attachment_upload_failed")
        result = response.json()
    except ReceiptProbeError:
        raise
    except (httpx.HTTPError, ValueError) as exc:
        raise ReceiptProbeError("attachment_upload_failed") from exc
    if not isinstance(result, dict) or not isinstance(result.get("public_id"), str):
        raise ReceiptProbeError("malformed_attachment_upload_response")
    public_id = result["public_id"]
    _validate_identifier(public_id)
    return public_id


async def _retail_transaction_id(
    client: GraphQLClient,
    receipt_id: str,
) -> str:
    _validate_identifier(receipt_id)
    data = await _graphql(
        client,
        "Common_RetailSyncQuery",
        _GET_RECEIPT_QUERY,
        {"syncId": receipt_id},
    )
    raw = _required_dict(data, "retailSync")
    orders = raw.get("orders")
    if not isinstance(orders, list) or not orders:
        raise ReceiptProbeError("receipt_transaction_unavailable")
    order = _as_dict(orders[0], "malformed_receipt")
    transactions = order.get("retailTransactions")
    if not isinstance(transactions, list) or not transactions:
        raise ReceiptProbeError("receipt_transaction_unavailable")
    transaction = _as_dict(transactions[0], "malformed_receipt")
    identifier = transaction.get("id")
    if not isinstance(identifier, str):
        raise ReceiptProbeError("malformed_receipt")
    _validate_identifier(identifier)
    return identifier


async def _graphql(
    client: GraphQLClient,
    operation: str,
    query: object,
    variables: dict[str, object],
) -> dict[str, object]:
    try:
        data = await client.gql_call(operation, query, variables)
    except Exception as exc:
        raise ReceiptProbeError("upstream_request_failed") from exc
    if not isinstance(data, dict):
        raise ReceiptProbeError("malformed_upstream_response")
    return data


def _normalize_receipt(raw: object) -> ReceiptRecord:
    data = _as_dict(raw, "malformed_receipt")
    identifier = data.get("id")
    vendor = data.get("vendor")
    status = data.get("status")
    if (
        not isinstance(identifier, str)
        or vendor not in _VENDOR_SOURCE
        or status
        not in {
            "in_progress",
            "pending",
            "pending_matches",
            "completed",
            "failed",
        }
    ):
        raise ReceiptProbeError("malformed_receipt")
    _validate_identifier(identifier)
    created_at = data.get("createdAt")
    if created_at is not None and (
        not isinstance(created_at, str) or len(created_at) > 64
    ):
        raise ReceiptProbeError("malformed_receipt")
    raw_attachments = data.get("attachments") or []
    if (
        not isinstance(raw_attachments, list)
        or len(raw_attachments) > MAX_RECEIPT_ATTACHMENTS
    ):
        raise ReceiptProbeError("malformed_receipt")
    return ReceiptRecord(
        id=identifier,
        source=_VENDOR_SOURCE[vendor],
        status=status,
        created_at=created_at,
        linked_transaction_id=_linked_transaction_id(data),
        attachments=tuple(
            _normalize_attachment(attachment) for attachment in raw_attachments
        ),
    )


def _normalize_attachment(raw: object) -> AttachmentMetadata:
    data = _as_dict(raw, "malformed_attachment")
    identifier = data.get("id")
    if not isinstance(identifier, str):
        raise ReceiptProbeError("malformed_attachment")
    _validate_identifier(identifier)
    filename = _bounded_optional_string(data.get("filename"), 255)
    extension = _bounded_optional_string(data.get("extension"), 16)
    size = data.get("sizeBytes")
    if isinstance(size, bool) or (
        size is not None and (not isinstance(size, int) or size < 0)
    ):
        raise ReceiptProbeError("malformed_attachment")
    asset_url = data.get("originalAssetUrl")
    if asset_url is not None and (
        not isinstance(asset_url, str) or len(asset_url) > 4096
    ):
        raise ReceiptProbeError("malformed_attachment")
    return AttachmentMetadata(
        id=identifier,
        filename=filename,
        extension=extension,
        size_bytes=size,
        download_available=bool(asset_url and _is_allowed_asset_url(asset_url)),
        _asset_url=asset_url,
    )


def _linked_transaction_id(data: dict[str, object]) -> str | None:
    orders = data.get("orders") or []
    if not isinstance(orders, list):
        raise ReceiptProbeError("malformed_receipt")
    for raw_order in orders:
        order = _as_dict(raw_order, "malformed_receipt")
        transactions = order.get("retailTransactions") or []
        if not isinstance(transactions, list):
            raise ReceiptProbeError("malformed_receipt")
        for raw_transaction in transactions:
            transaction = _as_dict(raw_transaction, "malformed_receipt")
            linked = transaction.get("transaction")
            if linked is None:
                continue
            linked_data = _as_dict(linked, "malformed_receipt")
            identifier = linked_data.get("id")
            if not isinstance(identifier, str):
                raise ReceiptProbeError("malformed_receipt")
            _validate_identifier(identifier)
            return identifier
    return None


def _mutation_payload(
    data: dict[str, object],
    key: str,
) -> dict[str, object]:
    payload = _required_dict(data, key)
    errors = payload.get("errors")
    if errors:
        raise ReceiptProbeError("upstream_mutation_rejected")
    return payload


def _required_dict(data: dict[str, object], key: str) -> dict[str, object]:
    return _as_dict(data.get(key), "malformed_upstream_response")


def _as_dict(value: object, code: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ReceiptProbeError(code)
    return value


def _validate_identifier(value: str) -> None:
    if not value or len(value) > 512 or any(ord(character) < 32 for character in value):
        raise ReceiptProbeError("invalid_identifier")


def _bounded_optional_string(value: object, maximum: int) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or any(ord(character) < 32 for character in value)
    ):
        raise ReceiptProbeError("malformed_attachment")
    return value


def _is_allowed_asset_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    return (
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and parsed.port in (None, 443)
        and any(
            hostname == suffix[1:] or hostname.endswith(suffix)
            for suffix in _ALLOWED_ASSET_HOST_SUFFIXES
        )
    )


def _parse_created_at(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ReceiptProbeError("malformed_receipt") from exc
    if parsed.tzinfo is None:
        raise ReceiptProbeError("malformed_receipt")
    return parsed.astimezone(timezone.utc)


def _validate_upload(filename: str, content_type: str, content: bytes) -> None:
    if (
        not filename
        or len(filename) > 255
        or Path(filename).name != filename
        or any(ord(character) < 32 for character in filename)
        or content_type not in ALLOWED_DOWNLOAD_TYPES
        or not content
        or len(content) > MAX_UPLOAD_BYTES
    ):
        raise ReceiptProbeError("upload_size_invalid")
