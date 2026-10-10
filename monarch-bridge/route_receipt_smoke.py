"""One-shot controlled-live smoke for the protected receipt route contract.

Output is one JSON object containing stable scenario statuses only. Never emit
identifiers, URLs, filenames, response bodies, exception text, or session paths.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
import tempfile
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import quote

import httpx

from receipt_probe import ReceiptProbeError


ENABLE_VALUE = "1"
MUTATION_CONFIRMATION = "I_ACCEPT_PROTECTED_RECEIPT_ROUTE_SMOKE_MUTATIONS"
SUCCESS_CODE = "protected_receipt_route_smoke_ok"
MAX_DISCOVERY_PAGES = 2
DISCOVERY_PAGE_SIZE = 25
MAX_JSON_BYTES = 64 * 1024
MAX_SMOKE_DOWNLOAD_BYTES = 2 * 1024 * 1024
MAX_TOTAL_SECONDS = 180.0
MAX_CLEANUP_SECONDS = 30.0
MAX_SYNTHETIC_CLEANUP_SECONDS = 15.0
MAX_MANUAL_RESTORE_SECONDS = 15.0
MAX_CANDIDATE_AGE = timedelta(days=14)
SERVICE_TOKEN_ENV = "TYRION_LIVE_ROUTE_RECEIPT_SERVICE_TOKEN"
_SCENARIOS = (
    "list",
    "match_preflight",
    "detail",
    "existing_download",
    "create",
    "upload_poll",
    "synthetic_download",
    "manual_unmatch",
    "match",
    "read_back",
    "cleanup",
    "manual_restore",
)
_PUBLIC_ERROR_CODES = frozenset(
    {
        "attachment_too_large",
        "attachment_unavailable",
        "bridge_auth_required",
        "invalid_request",
        "internal_error",
        "not_found",
        "payload_too_large",
        "pending_transaction_not_supported",
        "receipt_failed",
        "receipt_match_conflict",
        "receipt_not_found",
        "receipt_processing",
        "receipt_processing_timeout",
        "receipt_upstream_error",
        "request_failed",
        "session_expired",
        "session_in_use",
        "unsupported_content_encoding",
        "unsupported_media_type",
        "upstream_error",
        "upstream_rate_limited",
        "upstream_timeout",
    }
)
_GLYPHS = {
    " ": (0, 0, 0, 0, 0, 0, 0),
    ".": (0, 0, 0, 0, 0, 12, 12),
    "0": (14, 17, 19, 21, 25, 17, 14),
    "1": (4, 12, 4, 4, 4, 4, 14),
    "2": (14, 17, 1, 2, 4, 8, 31),
    "6": (14, 16, 16, 30, 17, 17, 14),
    "A": (14, 17, 17, 31, 17, 17, 17),
    "C": (14, 17, 16, 16, 16, 17, 14),
    "D": (30, 17, 17, 17, 17, 17, 30),
    "E": (31, 16, 16, 30, 16, 16, 31),
    "I": (31, 4, 4, 4, 4, 4, 31),
    "L": (16, 16, 16, 16, 16, 16, 31),
    "M": (17, 27, 21, 21, 17, 17, 17),
    "N": (17, 25, 21, 19, 17, 17, 17),
    "O": (14, 17, 17, 17, 17, 17, 14),
    "P": (30, 17, 17, 30, 16, 16, 16),
    "R": (30, 17, 17, 30, 20, 18, 17),
    "S": (15, 16, 16, 14, 1, 1, 30),
    "T": (31, 4, 4, 4, 4, 4, 4),
    "Y": (17, 17, 10, 4, 4, 4, 4),
}
_RECEIPT_LINES = (
    "TYRION RECEIPT",
    "DATE 2026 10 10",
    "ITEM 1.00",
    "TOTAL 1.00",
)


class RouteSmokeError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _summary(result: str) -> dict[str, str]:
    return {"result": result, **{scenario: "not_run" for scenario in _SCENARIOS}}


def _quiet_logging() -> None:
    for name in (
        "httpx",
        "httpcore",
        "gql",
        "graphql",
        "uvicorn.access",
        "monarch_bridge",
    ):
        logging.getLogger(name).setLevel(logging.WARNING)
    logging.getLogger("monarch_bridge").setLevel(logging.CRITICAL)


def _invented_receipt_png() -> bytes:
    scale = 4
    margin = 24
    glyph_width = 5
    glyph_height = 7
    line_gap = 12
    width = (
        margin * 2
        + max(len(line) for line in _RECEIPT_LINES)
        * (glyph_width + 1)
        * scale
    )
    height = (
        margin * 2
        + len(_RECEIPT_LINES) * glyph_height * scale
        + (len(_RECEIPT_LINES) - 1) * line_gap
    )
    pixels = bytearray(b"\xff" * (width * height * 3))
    for line_index, line in enumerate(_RECEIPT_LINES):
        top = margin + line_index * (glyph_height * scale + line_gap)
        for character_index, character in enumerate(line):
            left = margin + character_index * (glyph_width + 1) * scale
            for row_index, row in enumerate(_GLYPHS[character]):
                for column in range(glyph_width):
                    if not row & (1 << (glyph_width - column - 1)):
                        continue
                    for y_offset in range(scale):
                        for x_offset in range(scale):
                            x = left + column * scale + x_offset
                            y = top + row_index * scale + y_offset
                            index = (y * width + x) * 3
                            pixels[index:index + 3] = b"\x00\x00\x00"
    raw = b"".join(
        b"\x00" + pixels[row * width * 3:(row + 1) * width * 3]
        for row in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(
            b"IHDR",
            struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0),
        )
        + _png_chunk(b"IDAT", zlib.compress(raw, level=9))
        + _png_chunk(b"IEND", b"")
    )


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return (
        struct.pack(">I", len(data))
        + payload
        + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
    )


async def run() -> dict[str, str]:
    if os.getenv("TYRION_LIVE_ROUTE_RECEIPT_SMOKE") != ENABLE_VALUE:
        return _summary("protected_receipt_route_smoke_disabled")
    if (
        os.getenv("TYRION_LIVE_ROUTE_RECEIPT_MUTATION_CONFIRM")
        != MUTATION_CONFIRMATION
    ):
        return _summary("protected_receipt_route_mutation_confirmation_required")
    if not os.getenv("SESSION_FILE"):
        return _summary("protected_receipt_route_session_path_required")
    token = os.getenv(SERVICE_TOKEN_ENV, "")
    if len(token) < 32:
        return _summary("protected_receipt_route_service_token_required")

    os.environ["BRIDGE_LOAD_DOTENV"] = "false"
    os.environ["DEMO_MODE"] = "false"
    os.environ["BRIDGE_API_TOKEN"] = token
    _quiet_logging()
    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + MAX_TOTAL_SECONDS
        async with asyncio.timeout(MAX_TOTAL_SECONDS):
            import main as bridge

            owner_client = await bridge.get_client()
            return await run_route_smoke(
                bridge.app,
                owner_client,
                token=token,
                total_timeout=deadline - loop.time(),
            )
    except TimeoutError:
        return _summary("protected_receipt_route_total_timeout")
    except Exception:
        return _summary("protected_receipt_route_initialization_failed")


async def run_route_smoke(
    app: object,
    owner_client: object,
    *,
    token: str,
    now: datetime | None = None,
    total_timeout: float = MAX_TOTAL_SECONDS,
    delete_receipt_func: Callable[[object, str], Awaitable[bool]] | None = None,
    get_receipt_func: Callable[[object, str], Awaitable[object | None]] | None = None,
    unmatch_receipt_func: Callable[[object, object], Awaitable[None]] | None = None,
    match_receipt_func: Callable[[object, object, str], Awaitable[None]] | None = None,
) -> dict[str, str]:
    from receipt_probe import (
        delete_receipt,
        get_receipt,
        match_receipt,
        unmatch_receipt,
    )

    deleter = delete_receipt_func or delete_receipt
    getter = get_receipt_func or get_receipt
    unmatcher = unmatch_receipt_func or unmatch_receipt
    matcher = match_receipt_func or match_receipt
    summary = _summary(SUCCESS_CODE)
    synthetic_ids: list[str] = []
    creation_attempted = False
    candidate: dict[str, object] | None = None
    original_transaction_id: str | None = None
    primary_error: str | None = None
    cleanup_failed = False
    restoration_failed = False
    reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + total_timeout
    route_timeout = (
        total_timeout - MAX_CLEANUP_SECONDS
        if total_timeout > MAX_CLEANUP_SECONDS
        else total_timeout
    )
    transport = httpx.ASGITransport(
        app=app,
        client=("198.51.100.1", 443),
        raise_app_exceptions=False,
    )
    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with asyncio.timeout(route_timeout):
            async with httpx.AsyncClient(
                transport=transport,
                base_url="https://bridge.invalid",
                headers=headers,
                follow_redirects=False,
                trust_env=False,
                timeout=total_timeout,
            ) as route_client:
                candidate = await _discover_candidate(
                    route_client,
                    reference=reference,
                )
                summary["list"] = "passed"
                candidate_id = _required_identifier(
                    candidate,
                    "id",
                    scenario="list",
                )
                transaction_id = _required_identifier(
                    candidate,
                    "linkedTransactionId",
                    scenario="list",
                )
                original_transaction_id = transaction_id
                candidate_attachment = _single_pdf_attachment(
                    candidate,
                    scenario="list",
                )
                await _preflight_posted_transaction(
                    owner_client,
                    transaction_id,
                )
                summary["match_preflight"] = "passed"

                detail = await _json_request(
                    route_client,
                    "GET",
                    f"/receipts/{_path(candidate_id)}",
                    scenario="detail",
                    expected_status=200,
                )
                detailed = _required_receipt(detail, scenario="detail")
                if (
                    detailed.get("id") != candidate_id
                    or detailed.get("linkedTransactionId") != transaction_id
                    or detailed.get("status") != "matched"
                ):
                    raise RouteSmokeError("protected_receipt_route_detail_mismatch")
                detailed_attachment = _attachment_by_id(
                    detailed,
                    _required_identifier(
                        candidate_attachment,
                        "id",
                        scenario="list",
                    ),
                )
                detailed_attachment_id = _required_identifier(
                    detailed_attachment,
                    "id",
                    scenario="detail",
                )
                summary["detail"] = "passed"

                existing_content, existing_type = await _bytes_request(
                    route_client,
                    "GET",
                    (
                        f"/receipts/{_path(candidate_id)}/attachments/"
                        f"{_path(detailed_attachment_id)}/content"
                    ),
                    scenario="existing_download",
                    max_bytes=MAX_SMOKE_DOWNLOAD_BYTES,
                )
                _verify_download(
                    existing_content,
                    existing_type,
                    detailed_attachment,
                    exact=None,
                )
                summary["existing_download"] = "passed"

                creation_attempted = True
                created = await _json_request(
                    route_client,
                    "POST",
                    "/receipts",
                    scenario="create",
                    expected_status=201,
                    content=b"",
                )
                synthetic = _required_receipt(created, scenario="create")
                synthetic_id = _required_identifier(
                    synthetic,
                    "id",
                    scenario="create",
                )
                synthetic_ids.append(synthetic_id)
                if (
                    synthetic.get("status") != "processing"
                    or synthetic.get("linkedTransactionId") is not None
                    or synthetic.get("attachments") != []
                ):
                    raise RouteSmokeError("protected_receipt_route_create_mismatch")
                summary["create"] = "passed"

                invented = _invented_receipt_png()
                with tempfile.TemporaryDirectory(
                    prefix="tyrion-route-receipt-smoke-"
                ) as directory:
                    receipt_path = Path(directory) / "invented-receipt.png"
                    receipt_path.write_bytes(invented)
                    upload_content = receipt_path.read_bytes()
                uploaded = await _json_request(
                    route_client,
                    "PUT",
                    f"/receipts/{_path(synthetic_id)}/content",
                    scenario="upload_poll",
                    expected_status=200,
                    content=upload_content,
                    headers={"Content-Type": "image/png"},
                )
                processed = _required_receipt(
                    uploaded,
                    scenario="upload_poll",
                )
                if (
                    processed.get("id") != synthetic_id
                    or processed.get("status") != "awaiting_match"
                    or processed.get("linkedTransactionId") is not None
                ):
                    raise RouteSmokeError("protected_receipt_route_upload_mismatch")
                synthetic_attachment = _single_attachment(processed)
                synthetic_attachment_id = _required_identifier(
                    synthetic_attachment,
                    "id",
                    scenario="upload_poll",
                )
                summary["upload_poll"] = "passed"

                downloaded, downloaded_type = await _bytes_request(
                    route_client,
                    "GET",
                    (
                        f"/receipts/{_path(synthetic_id)}/attachments/"
                        f"{_path(synthetic_attachment_id)}/content"
                    ),
                    scenario="synthetic_download",
                    max_bytes=MAX_SMOKE_DOWNLOAD_BYTES,
                )
                _verify_download(
                    downloaded,
                    downloaded_type,
                    synthetic_attachment,
                    exact=invented,
                )
                summary["synthetic_download"] = "passed"

                await _ensure_manual_unmatched(
                    owner_client,
                    candidate_id,
                    transaction_id,
                    getter=getter,
                    unmatcher=unmatcher,
                )
                summary["manual_unmatch"] = "passed"

                matched = await _json_request(
                    route_client,
                    "POST",
                    f"/receipts/{_path(synthetic_id)}/match",
                    scenario="match",
                    expected_status=200,
                    json_body={
                        "transactionId": transaction_id,
                        "expectedLinkedTransactionId": None,
                        "confirmed": True,
                    },
                )
                matched_receipt = _required_receipt(
                    matched,
                    scenario="match",
                )
                if (
                    matched.get("status") != "matched"
                    or matched_receipt.get("id") != synthetic_id
                    or matched_receipt.get("linkedTransactionId") != transaction_id
                ):
                    raise RouteSmokeError("protected_receipt_route_match_mismatch")
                summary["match"] = "passed"

                read_back = await _json_request(
                    route_client,
                    "GET",
                    f"/receipts/{_path(synthetic_id)}",
                    scenario="read_back",
                    expected_status=200,
                )
                normalized = _required_receipt(
                    read_back,
                    scenario="read_back",
                )
                if (
                    normalized.get("id") != synthetic_id
                    or normalized.get("status") != "matched"
                    or normalized.get("linkedTransactionId") != transaction_id
                ):
                    raise RouteSmokeError("protected_receipt_route_read_back_mismatch")
                summary["read_back"] = "passed"
    except TimeoutError:
        primary_error = "protected_receipt_route_total_timeout"
    except RouteSmokeError as exc:
        primary_error = exc.code
    except Exception:
        primary_error = "protected_receipt_route_internal_error"
    finally:
        if creation_attempted and not synthetic_ids:
            cleanup_failed = True
        remaining = deadline - loop.time()
        if remaining <= 0:
            if synthetic_ids or creation_attempted:
                cleanup_failed = True
            if candidate is not None and original_transaction_id is not None:
                restoration_failed = True
        else:
            if synthetic_ids:
                try:
                    async with asyncio.timeout(
                        min(remaining, MAX_SYNTHETIC_CLEANUP_SECONDS)
                    ):
                        for receipt_id in dict.fromkeys(synthetic_ids):
                            try:
                                current = await getter(owner_client, receipt_id)
                                if current is not None and getattr(
                                    current,
                                    "linked_transaction_id",
                                    None,
                                ) is not None:
                                    await unmatcher(owner_client, current)
                                    current = await getter(owner_client, receipt_id)
                                    if current is None or getattr(
                                        current,
                                        "linked_transaction_id",
                                        None,
                                    ) is not None:
                                        cleanup_failed = True
                                        continue
                                if (
                                    current is not None
                                    and (
                                        not await deleter(owner_client, receipt_id)
                                        or await getter(owner_client, receipt_id)
                                        is not None
                                    )
                                ):
                                    cleanup_failed = True
                            except Exception:
                                cleanup_failed = True
                except TimeoutError:
                    cleanup_failed = True
                if not cleanup_failed:
                    summary["cleanup"] = "passed"
            if candidate is not None and original_transaction_id is not None:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    restoration_failed = True
                else:
                    try:
                        async with asyncio.timeout(
                            min(remaining, MAX_MANUAL_RESTORE_SECONDS)
                        ):
                            await _ensure_manual_restored(
                                owner_client,
                                _required_identifier(
                                    candidate,
                                    "id",
                                    scenario="manual_restore",
                                ),
                                original_transaction_id,
                                getter=getter,
                                matcher=matcher,
                            )
                        summary["manual_restore"] = "passed"
                    except Exception:
                        restoration_failed = True

    if cleanup_failed or restoration_failed:
        summary["result"] = "protected_receipt_route_cleanup_failed"
        if cleanup_failed:
            summary["cleanup"] = "failed_manual_inspection_required"
        if restoration_failed:
            summary["manual_restore"] = "failed_manual_inspection_required"
    elif synthetic_ids:
        if primary_error is not None:
            summary["result"] = primary_error
    elif primary_error is not None:
        summary["result"] = primary_error
    return summary


async def _ensure_manual_unmatched(
    client: object,
    receipt_id: str,
    original_transaction_id: str,
    *,
    getter: Callable[[object, str], Awaitable[object | None]],
    unmatcher: Callable[[object, object], Awaitable[None]],
) -> None:
    try:
        current = await getter(client, receipt_id)
    except Exception as exc:
        raise RouteSmokeError(
            "protected_receipt_route_manual_unmatch_failed"
        ) from exc
    linked = _linked_transaction_id(current)
    if linked != original_transaction_id:
        raise RouteSmokeError("protected_receipt_route_manual_unmatch_failed")
    try:
        await unmatcher(client, current)
    except Exception:
        pass
    try:
        current = await getter(client, receipt_id)
    except Exception as exc:
        raise RouteSmokeError(
            "protected_receipt_route_manual_unmatch_failed"
        ) from exc
    linked = _linked_transaction_id(current)
    if linked is not None:
        raise RouteSmokeError("protected_receipt_route_manual_unmatch_failed")


async def _ensure_manual_restored(
    client: object,
    receipt_id: str,
    original_transaction_id: str,
    *,
    getter: Callable[[object, str], Awaitable[object | None]],
    matcher: Callable[[object, object, str], Awaitable[None]],
) -> None:
    current = await getter(client, receipt_id)
    linked = _linked_transaction_id(current)
    if linked == original_transaction_id:
        return
    if linked is not None:
        raise RouteSmokeError("protected_receipt_route_manual_restore_failed")
    try:
        await matcher(client, current, original_transaction_id)
    except Exception:
        pass
    restored = await getter(client, receipt_id)
    if _linked_transaction_id(restored) != original_transaction_id:
        raise RouteSmokeError("protected_receipt_route_manual_restore_failed")


def _linked_transaction_id(receipt: object | None) -> str | None:
    if receipt is None:
        raise RouteSmokeError("protected_receipt_route_manual_receipt_missing")
    linked = getattr(receipt, "linked_transaction_id", None)
    if linked is not None and not isinstance(linked, str):
        raise RouteSmokeError("protected_receipt_route_manual_receipt_malformed")
    return linked


async def _discover_candidate(
    client: httpx.AsyncClient,
    *,
    reference: datetime,
) -> dict[str, object]:
    eligible: list[dict[str, object]] = []
    offset = 0
    for _ in range(MAX_DISCOVERY_PAGES):
        payload = await _json_request(
            client,
            "GET",
            (
                "/receipts?source=upload"
                f"&limit={DISCOVERY_PAGE_SIZE}&offset={offset}"
            ),
            scenario="list",
            expected_status=200,
        )
        receipts = payload.get("receipts")
        page = payload.get("page")
        if (
            not isinstance(receipts, list)
            or len(receipts) > DISCOVERY_PAGE_SIZE
            or not isinstance(page, dict)
            or page.get("limit") != DISCOVERY_PAGE_SIZE
            or page.get("offset") != offset
            or isinstance(page.get("total"), bool)
            or not isinstance(page.get("total"), int)
            or not isinstance(page.get("hasMore"), bool)
        ):
            raise RouteSmokeError("protected_receipt_route_list_malformed")
        for value in receipts:
            if not isinstance(value, dict):
                raise RouteSmokeError("protected_receipt_route_list_malformed")
            created = _parse_created_at(value.get("createdAt"))
            if (
                value.get("source") == "upload"
                and value.get("status") == "matched"
                and isinstance(value.get("linkedTransactionId"), str)
                and created is not None
                and reference - MAX_CANDIDATE_AGE <= created <= reference
            ):
                try:
                    _single_pdf_attachment(value, scenario="list")
                except RouteSmokeError:
                    continue
                eligible.append(value)
        offset += len(receipts)
        if not page["hasMore"]:
            break
        if not receipts:
            raise RouteSmokeError("protected_receipt_route_list_malformed")
    else:
        raise RouteSmokeError("protected_receipt_route_candidate_search_limit")
    if not eligible:
        raise RouteSmokeError("protected_receipt_route_candidate_not_found")
    if len(eligible) != 1:
        raise RouteSmokeError("protected_receipt_route_candidate_ambiguous")
    return eligible[0]


async def _preflight_posted_transaction(
    client: object,
    transaction_id: str,
) -> None:
    try:
        result = await client.get_transaction_details(
            transaction_id,
            redirect_posted=False,
        )
    except Exception as exc:
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_unavailable"
        ) from exc
    if not isinstance(result, dict):
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_malformed"
        )
    if "getTransaction" not in result:
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_malformed"
        )
    transaction = result.get("getTransaction")
    if transaction is None:
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_not_found"
        )
    if not isinstance(transaction, dict):
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_malformed"
        )
    returned_id = transaction.get("id")
    if not isinstance(returned_id, str):
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_malformed"
        )
    if returned_id != transaction_id:
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_identity_mismatch"
        )
    pending = transaction.get("pending")
    if not isinstance(pending, bool):
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_malformed"
        )
    if pending:
        raise RouteSmokeError(
            "protected_receipt_route_match_preflight_pending"
        )


async def _json_request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    scenario: str,
    expected_status: int,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
    json_body: dict[str, object] | None = None,
) -> dict[str, object]:
    body, media_type, status = await _bounded_request(
        client,
        method,
        path,
        scenario=scenario,
        max_bytes=MAX_JSON_BYTES,
        content=content,
        headers=headers,
        json_body=json_body,
    )
    if status != expected_status:
        raise RouteSmokeError(
            _http_failure_code(scenario, status, body, media_type)
        )
    if media_type != "application/json":
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        )
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        ) from exc
    if not isinstance(payload, dict):
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        )
    return payload


async def _bytes_request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    scenario: str,
    max_bytes: int,
) -> tuple[bytes, str]:
    body, media_type, status = await _bounded_request(
        client,
        method,
        path,
        scenario=scenario,
        max_bytes=max_bytes,
    )
    if status != 200:
        raise RouteSmokeError(
            _http_failure_code(scenario, status, body, media_type)
        )
    return body, media_type


async def _bounded_request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    scenario: str,
    max_bytes: int,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
    json_body: dict[str, object] | None = None,
) -> tuple[bytes, str, int]:
    try:
        async with client.stream(
            method,
            path,
            content=content,
            headers=headers,
            json=json_body,
        ) as response:
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise RouteSmokeError(
                        f"protected_receipt_route_{scenario}_response_too_large"
                    )
                chunks.append(chunk)
            media_type = (
                response.headers.get("content-type", "")
                .split(";", 1)[0]
                .strip()
                .lower()
            )
            return b"".join(chunks), media_type, response.status_code
    except RouteSmokeError:
        raise
    except httpx.HTTPError as exc:
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_transport_failed"
        ) from exc


def _http_failure_code(
    scenario: str,
    status: int,
    body: bytes,
    media_type: str,
) -> str:
    if 400 <= status <= 499:
        status_class = "4xx"
    elif 500 <= status <= 599:
        status_class = "5xx"
    else:
        status_class = "other"
    public_code = "unrecognized_error"
    if media_type == "application/json":
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("code") in _PUBLIC_ERROR_CODES:
                public_code = error["code"]
    return (
        f"protected_receipt_route_{scenario}_http_"
        f"{status_class}_{public_code}"
    )


def _required_receipt(
    payload: dict[str, object],
    *,
    scenario: str,
) -> dict[str, object]:
    value = payload.get("receipt")
    if not isinstance(value, dict):
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        )
    _required_identifier(value, "id", scenario=scenario)
    attachments = value.get("attachments")
    if not isinstance(attachments, list) or len(attachments) > 10:
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        )
    return value


def _required_identifier(
    value: dict[str, object],
    key: str,
    *,
    scenario: str,
) -> str:
    identifier = value.get(key)
    if (
        not isinstance(identifier, str)
        or not identifier
        or len(identifier) > 512
        or identifier != identifier.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in identifier)
    ):
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        )
    return identifier


def _single_pdf_attachment(
    receipt: dict[str, object],
    *,
    scenario: str,
) -> dict[str, object]:
    attachments = receipt.get("attachments")
    if not isinstance(attachments, list):
        raise RouteSmokeError(
            f"protected_receipt_route_{scenario}_response_malformed"
        )
    eligible = [
        value
        for value in attachments
        if isinstance(value, dict)
        and value.get("mediaType") == "application/pdf"
        and value.get("downloadAvailable") is True
        and _valid_size(value.get("sizeBytes"))
    ]
    if len(eligible) != 1:
        raise RouteSmokeError("protected_receipt_route_candidate_attachment_invalid")
    return eligible[0]


def _single_attachment(receipt: dict[str, object]) -> dict[str, object]:
    attachments = receipt.get("attachments")
    if not isinstance(attachments, list) or len(attachments) != 1:
        raise RouteSmokeError("protected_receipt_route_attachment_mismatch")
    value = attachments[0]
    if (
        not isinstance(value, dict)
        or value.get("mediaType") != "image/png"
        or value.get("downloadAvailable") is not True
        or not _valid_size(value.get("sizeBytes"))
    ):
        raise RouteSmokeError("protected_receipt_route_attachment_mismatch")
    return value


def _attachment_by_id(
    receipt: dict[str, object],
    attachment_id: str,
) -> dict[str, object]:
    attachments = receipt.get("attachments")
    if not isinstance(attachments, list):
        raise RouteSmokeError("protected_receipt_route_response_malformed")
    matches = [
        value
        for value in attachments
        if isinstance(value, dict) and value.get("id") == attachment_id
    ]
    if len(matches) != 1:
        raise RouteSmokeError("protected_receipt_route_detail_mismatch")
    return matches[0]


def _verify_download(
    content: bytes,
    media_type: str,
    attachment: dict[str, object],
    *,
    exact: bytes | None,
) -> None:
    expected_type = attachment.get("mediaType")
    expected_size = attachment.get("sizeBytes")
    if (
        not content
        or len(content) > MAX_SMOKE_DOWNLOAD_BYTES
        or media_type != expected_type
        or (expected_size is not None and len(content) != expected_size)
    ):
        raise RouteSmokeError("protected_receipt_route_download_mismatch")
    if exact is not None and content != exact:
        raise RouteSmokeError("protected_receipt_route_download_mismatch")


def _valid_size(value: object) -> bool:
    return (
        value is None
        or (
            not isinstance(value, bool)
            and isinstance(value, int)
            and 0 < value <= MAX_SMOKE_DOWNLOAD_BYTES
        )
    )


def _parse_created_at(value: object) -> datetime | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _path(identifier: str) -> str:
    return quote(identifier, safe="")


def main() -> int:
    result = asyncio.run(run())
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result["result"] == SUCCESS_CODE else 1


if __name__ == "__main__":
    raise SystemExit(main())
