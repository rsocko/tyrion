"""Narrow protected Bridge and OWL clients for receipt recovery."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import httpx
from pydantic import ValidationError
from receipt_recovery_contract import (
    SOURCE_OCCURRENCE_VERSION,
    TRANSFORM_VERSION,
    IntakeResult,
    Receipt,
    ReceiptAttachment,
    ReceiptResponse,
    ReceiptsResponse,
    RecoveryIdentity,
    RecoverySettings,
)


class RecoveryClientError(RuntimeError):
    pass


class RecoveryRetryableError(RecoveryClientError):
    pass


class RecoveryUnknownOutcome(RecoveryClientError):
    pass


class RecoveryContractError(RecoveryClientError):
    pass


class BridgeRecoveryClient:
    def __init__(
        self,
        settings: RecoverySettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.bridge_url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {settings.bridge_token}",
            },
            follow_redirects=False,
            timeout=settings.request_timeout_seconds,
            transport=transport,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def list_receipts(self, source: str, offset: int) -> ReceiptsResponse:
        payload = await self._get_json(
            "receipts",
            params={
                "source": source,
                "limit": self.settings.page_size,
                "offset": offset,
            },
        )
        try:
            parsed = ReceiptsResponse.model_validate(payload)
        except (ValueError, ValidationError) as exc:
            raise RecoveryContractError("bridge receipt page is invalid") from exc
        if (
            parsed.page.limit != self.settings.page_size
            or parsed.page.offset != offset
            or len(parsed.receipts) > parsed.page.limit
        ):
            raise RecoveryContractError("bridge pagination is inconsistent")
        expected_more = offset + len(parsed.receipts) < parsed.page.total
        if parsed.page.has_more != expected_more:
            raise RecoveryContractError("bridge pagination did not terminate safely")
        return parsed

    async def get_receipt(self, receipt_id: str) -> Receipt:
        payload = await self._get_json(f"receipts/{quote(receipt_id, safe='')}")
        try:
            return ReceiptResponse.model_validate(payload).receipt
        except (ValueError, ValidationError) as exc:
            raise RecoveryContractError("bridge receipt detail is invalid") from exc

    async def download(
        self,
        receipt_id: str,
        attachment: ReceiptAttachment,
        destination: Path,
    ) -> tuple[str, int]:
        path = (
            f"receipts/{quote(receipt_id, safe='')}/attachments/"
            f"{quote(attachment.id, safe='')}/content"
        )
        try:
            async with self.client.stream("GET", path) as response:
                if response.is_redirect:
                    raise RecoveryContractError("bridge download redirected")
                if response.status_code != 200:
                    await response.aread()
                    raise _http_failure(response.status_code, "bridge download")
                content_type = (
                    response.headers.get("content-type", "").split(";", 1)[0].lower()
                )
                if content_type != attachment.media_type:
                    raise RecoveryContractError(
                        "bridge download media type is inconsistent"
                    )
                if (
                    response.headers.get("content-encoding", "identity").lower()
                    != "identity"
                ):
                    raise RecoveryContractError("bridge download is encoded")
                declared_length = response.headers.get("content-length")
                if declared_length is not None:
                    try:
                        expected_length = int(declared_length)
                    except ValueError as exc:
                        raise RecoveryContractError(
                            "bridge download length is invalid"
                        ) from exc
                    if (
                        expected_length <= 0
                        or expected_length > self.settings.max_bytes
                    ):
                        raise RecoveryContractError(
                            "bridge download length is out of bounds"
                        )
                else:
                    expected_length = None
                digest = hashlib.sha256()
                size = 0
                with destination.open("xb") as output:
                    os.chmod(destination, 0o600)
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > self.settings.max_bytes:
                            raise RecoveryContractError(
                                "bridge download exceeds the byte limit"
                            )
                        output.write(chunk)
                        digest.update(chunk)
                if size == 0 or (
                    expected_length is not None and size != expected_length
                ):
                    raise RecoveryContractError(
                        "bridge download length is inconsistent"
                    )
                if attachment.size_bytes is not None and size != attachment.size_bytes:
                    raise RecoveryContractError(
                        "bridge attachment metadata is inconsistent"
                    )
                return digest.hexdigest(), size
        except httpx.TimeoutException as exc:
            raise RecoveryRetryableError("bridge download timed out") from exc
        except httpx.HTTPError as exc:
            raise RecoveryRetryableError("bridge download failed") from exc

    async def _get_json(
        self, path: str, *, params: dict[str, object] | None = None
    ) -> object:
        try:
            async with self.client.stream("GET", path, params=params) as response:
                if response.is_redirect:
                    raise RecoveryContractError("bridge read redirected")
                if response.status_code != 200:
                    await _discard(response)
                    raise _http_failure(response.status_code, "bridge read")
                return await _bounded_json(response, 256 * 1024)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise RecoveryRetryableError("bridge read failed") from exc


class OwlRecoveryClient:
    def __init__(
        self,
        settings: RecoverySettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.owl_url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {settings.owl_token}",
            },
            follow_redirects=False,
            timeout=settings.request_timeout_seconds,
            transport=transport,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def lookup(self, source_occurrence_id: str) -> IntakeResult | None:
        return await self._json_request(
            "GET",
            "api/receipt-intake/v1/lookup",
            headers={"X-OWL-Source-Occurrence": source_occurrence_id},
            allow_not_found=True,
        )

    async def reconcile(self, intake_ref: str) -> IntakeResult:
        result = await self._json_request(
            "POST",
            (
                "api/receipt-intake/v1/occurrences/"
                f"{quote(intake_ref, safe='')}/reconcile"
            ),
        )
        if result is None:
            raise RecoveryContractError("OWL reconciliation returned no result")
        return result

    async def submit(
        self,
        *,
        artifact: Path,
        media_type: str,
        identity: RecoveryIdentity,
        source_observed_at: datetime | None,
    ) -> IntakeResult:
        headers = {
            "Content-Type": media_type,
            "X-OWL-Source-Channel": "monarch_recovery",
            "X-OWL-Source-Occurrence-Version": SOURCE_OCCURRENCE_VERSION,
            "X-OWL-Source-Occurrence": identity.source_occurrence_id,
            "X-OWL-Connector-Ref": identity.external_replica_ref,
            "X-OWL-Transform-Version": TRANSFORM_VERSION,
        }
        if source_observed_at is not None:
            headers["X-OWL-Source-Observed-At"] = source_observed_at.isoformat()
        try:
            async with self.client.stream(
                "POST",
                "api/receipt-intake/v1/occurrences",
                headers=headers,
                content=_file_chunks(artifact),
            ) as response:
                if response.is_redirect:
                    raise RecoveryContractError("OWL intake redirected")
                if response.status_code != 202:
                    await _discard(response)
                    raise _http_failure(response.status_code, "OWL intake")
                return await _parse_intake(response)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise RecoveryUnknownOutcome("OWL intake outcome is unknown") from exc

    async def _json_request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        allow_not_found: bool = False,
    ) -> IntakeResult | None:
        try:
            async with self.client.stream(method, path, headers=headers) as response:
                if response.is_redirect:
                    raise RecoveryContractError("OWL read redirected")
                if allow_not_found and response.status_code == 404:
                    await _discard(response)
                    return None
                if response.status_code != 200:
                    await _discard(response)
                    raise _http_failure(response.status_code, "OWL read")
                return await _parse_intake(response)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise RecoveryRetryableError("OWL read failed") from exc


async def _file_chunks(path: Path) -> AsyncIterator[bytes]:
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            yield chunk


async def _parse_intake(response: httpx.Response) -> IntakeResult:
    try:
        return IntakeResult.model_validate(await _bounded_json(response, 64 * 1024))
    except (ValueError, ValidationError) as exc:
        raise RecoveryContractError("OWL intake result is invalid") from exc


async def _bounded_json(response: httpx.Response, maximum_bytes: int) -> object:
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > maximum_bytes:
            raise RecoveryContractError("protected response exceeds the byte limit")
    try:
        return json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecoveryContractError("protected response is malformed") from exc


async def _discard(response: httpx.Response) -> None:
    await response.aclose()


def _http_failure(status_code: int, operation: str) -> RecoveryClientError:
    if status_code in {408, 425, 429, 502, 503, 504}:
        return RecoveryRetryableError(f"{operation} is retryable")
    return RecoveryContractError(f"{operation} was rejected")
