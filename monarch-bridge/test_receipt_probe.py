"""Deterministic receipt probe coverage using invented upstream structures."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import json
import logging
import struct
import sys
import types
import zlib

import httpx
import pytest

import receipt_probe
from live_receipt_probe import (
    SUCCESS_CODE,
    _classify_duplicate,
    _classify_fidelity,
    _delete_synthetic_receipts,
    _invented_receipt_pdf,
    _invented_receipt_png,
    _new_synthetic_attachment_candidates,
    _quiet_transport_logging,
    run,
    run_matrix,
)
from receipt_probe import (
    MAX_DOWNLOAD_BYTES,
    MAX_POLL_ATTEMPTS,
    AttachmentMetadata,
    ReceiptRecord,
    ReceiptProbeError,
    TransactionAttachmentSnapshot,
    attachments_match,
    delete_transaction_attachment,
    discover_matched_pdf_candidate,
    download_attachment,
    find_receipt,
    get_receipt,
    get_transaction_attachment,
    list_transaction_attachments,
    list_receipts,
    poll_receipt,
    upload_transaction_attachment,
    upload_receipt_file,
)


class FakeGraphQLClient:
    def __init__(self, *responses):
        self.responses = deque(responses)
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def gql_call(self, operation, graphql_query, variables):
        self.calls.append((operation, variables))
        response = self.responses.popleft()
        if isinstance(response, Exception):
            raise response
        return response


def test_invented_receipt_is_readable_nonempty_png():
    content = _invented_receipt_png()

    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    width, height = struct.unpack(">II", content[16:24])
    assert width >= 400
    assert height >= 180
    idat_start = content.index(b"IDAT") + 4
    idat_length = struct.unpack(">I", content[idat_start - 8:idat_start - 4])[0]
    raw = zlib.decompress(content[idat_start:idat_start + idat_length])
    assert raw.count(b"\x00") > width


def test_invented_receipt_is_readable_minimal_pdf():
    content = _invented_receipt_pdf()
    stream = content.split(b"stream\n", 1)[1].split(b"\nendstream", 1)[0]

    assert content.startswith(b"%PDF-1.4\n")
    assert b"(TYRION TEST RECEIPT)" in content
    assert f"/Length {len(stream)}".encode() in content
    assert b"xref\n" in content
    assert content.endswith(b"%%EOF\n")


def test_live_probe_suppresses_transport_request_logging():
    httpx_logger = logging.getLogger("httpx")
    httpcore_logger = logging.getLogger("httpcore")
    previous = (httpx_logger.level, httpcore_logger.level)
    try:
        httpx_logger.setLevel(logging.INFO)
        httpcore_logger.setLevel(logging.INFO)

        _quiet_transport_logging()

        assert httpx_logger.level == logging.WARNING
        assert httpcore_logger.level == logging.WARNING
    finally:
        httpx_logger.setLevel(previous[0])
        httpcore_logger.setLevel(previous[1])


@pytest.mark.anyio
async def test_live_matrix_gate_and_output_are_stable_and_sanitized(
    monkeypatch,
):
    private_value = "private-session-path"
    monkeypatch.delenv("TYRION_LIVE_RECEIPT_TESTS", raising=False)
    monkeypatch.setenv("SESSION_FILE", private_value)

    summary = await run()

    assert summary["result"] == "receipt_attachment_matrix_disabled"
    assert summary["email_ingestion"] == "skipped_no_configuration"
    assert summary["pending_identity"] == "skipped_no_pending_transaction"
    assert private_value not in json.dumps(summary)


@pytest.mark.anyio
async def test_live_matrix_initialization_failure_is_sanitized(
    monkeypatch,
):
    private_detail = "private-session-and-upstream-detail"

    async def failing_get_client():
        raise RuntimeError(private_detail)

    monkeypatch.setenv("TYRION_LIVE_RECEIPT_TESTS", "1")
    monkeypatch.setenv(
        "TYRION_LIVE_RECEIPT_MUTATION_CONFIRM",
        "I_ACCEPT_RECEIPT_ATTACHMENT_PROBE_MUTATIONS",
    )
    monkeypatch.setenv("SESSION_FILE", "invented-external-path")
    monkeypatch.setitem(
        sys.modules,
        "main",
        types.SimpleNamespace(get_client=failing_get_client),
    )

    summary = await run()

    assert summary["result"] == "receipt_attachment_matrix_internal_error"
    assert private_detail not in json.dumps(summary)


def receipt(
    *,
    identifier: str = "receipt-invented",
    vendor: str = "user_import",
    status: str = "pending_matches",
    linked_transaction_id: str | None = None,
    attachments: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    linked = (
        {"id": linked_transaction_id}
        if linked_transaction_id is not None
        else None
    )
    return {
        "id": identifier,
        "vendor": vendor,
        "status": status,
        "createdAt": "2026-10-09T12:00:00Z",
        "orders": [
            {
                "retailTransactions": [
                    {
                        "id": "retail-transaction-invented",
                        "transaction": linked,
                    }
                ]
            }
        ],
        "attachments": attachments or [],
    }


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("vendor", "source"),
    (("user_import", "upload"), ("email_import", "email")),
)
@pytest.mark.parametrize(
    "status",
    ("in_progress", "pending", "pending_matches", "completed", "failed"),
)
async def test_list_receipts_normalizes_exact_states_sources_and_nested_identity(
    vendor,
    source,
    status,
):
    client = FakeGraphQLClient(
        {
            "retailSyncsWithTotal": {
                "totalCount": 1,
                "results": [
                    receipt(
                        vendor=vendor,
                        status=status,
                        linked_transaction_id="transaction-invented",
                        attachments=[
                            {
                                "id": "attachment-invented",
                                "filename": "invented.png",
                                "extension": "png",
                                "sizeBytes": 68,
                                "originalAssetUrl": (
                                    "https://res.cloudinary.com/example/image/upload/"
                                    "invented.png"
                                ),
                            }
                        ],
                    )
                ],
            }
        }
    )

    page = await list_receipts(client, source=source, limit=10, offset=0)

    assert page.to_result() == {
        "receipts": [
            {
                "id": "receipt-invented",
                "source": source,
                "status": status,
                "createdAt": "2026-10-09T12:00:00Z",
                "linkedTransactionId": "transaction-invented",
                "attachments": [
                    {
                        "id": "attachment-invented",
                        "filename": "invented.png",
                        "extension": "png",
                        "sizeBytes": 68,
                        "downloadAvailable": True,
                    }
                ],
            }
        ],
        "totalCount": 1,
        "limit": 10,
        "offset": 0,
    }
    assert client.calls == [
        (
            "Common_RetailSyncsQueryWithTotal",
            {
                "filters": {"vendor": vendor},
                "offset": 0,
                "limit": 10,
                "includeTotalCount": True,
            },
        )
    ]
    assert "cloudinary" not in str(page.to_result())


@pytest.mark.anyio
async def test_get_transaction_attachment_omits_private_asset_url_from_result():
    client = FakeGraphQLClient(
        {
            "transactionAttachment": {
                "id": "attachment-invented",
                "filename": "proof",
                "extension": "pdf",
                "sizeBytes": 512,
                "originalAssetUrl": (
                    "https://res.cloudinary.com/example/raw/upload/proof.pdf"
                ),
            }
        }
    )

    attachment = await get_transaction_attachment(client, "attachment-invented")

    assert attachment is not None
    assert attachment.to_result() == {
        "id": "attachment-invented",
        "filename": "proof",
        "extension": "pdf",
        "sizeBytes": 512,
        "downloadAvailable": True,
    }
    assert client.calls[0][0] == "Mobile_GetAttachmentDetails"


@pytest.mark.anyio
async def test_candidate_discovery_requires_exactly_one_recent_matched_pdf():
    eligible = receipt(
        identifier="receipt-eligible",
        linked_transaction_id="transaction-invented",
        attachments=[
            {
                "id": "attachment-invented",
                "filename": "invented.pdf",
                "extension": "pdf",
                "sizeBytes": 512,
                "originalAssetUrl": None,
            }
        ],
    )
    client = FakeGraphQLClient(
        {
            "retailSyncsWithTotal": {
                "totalCount": 2,
                "results": [eligible, receipt(identifier="unmatched")],
            }
        }
    )

    candidate = await discover_matched_pdf_candidate(
        client,
        now=datetime(2026, 10, 10, tzinfo=timezone.utc),
    )

    assert candidate.id == "receipt-eligible"
    assert client.calls == [
        (
            "Common_RetailSyncsQueryWithTotal",
            {
                "filters": {"vendor": "user_import"},
                "offset": 0,
                "limit": 25,
                "includeTotalCount": True,
            },
        )
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("results", "code"),
    (
        ([], "receipt_candidate_not_found"),
        (
            [
                receipt(
                    identifier="one",
                    linked_transaction_id="transaction-one",
                    attachments=[
                        {
                            "id": "attachment-one",
                            "filename": None,
                            "extension": "pdf",
                            "sizeBytes": 1,
                            "originalAssetUrl": None,
                        }
                    ],
                ),
                receipt(
                    identifier="two",
                    linked_transaction_id="transaction-two",
                    attachments=[
                        {
                            "id": "attachment-two",
                            "filename": None,
                            "extension": "PDF",
                            "sizeBytes": 1,
                            "originalAssetUrl": None,
                        }
                    ],
                ),
            ],
            "receipt_candidate_ambiguous",
        ),
    ),
)
async def test_candidate_discovery_fails_closed_for_zero_or_multiple(results, code):
    client = FakeGraphQLClient(
        {
            "retailSyncsWithTotal": {
                "totalCount": len(results),
                "results": results,
            }
        }
    )

    with pytest.raises(ReceiptProbeError, match=f"^{code}$"):
        await discover_matched_pdf_candidate(
            client,
            now=datetime(2026, 10, 10, tzinfo=timezone.utc),
        )


@pytest.mark.anyio
async def test_candidate_discovery_stops_at_bounded_page_limit():
    client = FakeGraphQLClient(
        {
            "retailSyncsWithTotal": {
                "totalCount": 99,
                "results": [receipt(identifier="unmatched")],
            }
        }
    )

    with pytest.raises(ReceiptProbeError, match="^receipt_candidate_search_limit$"):
        await discover_matched_pdf_candidate(
            client,
            now=datetime(2026, 10, 10, tzinfo=timezone.utc),
            page_size=1,
            max_pages=1,
        )


@pytest.mark.anyio
async def test_transaction_attachment_list_and_delete_use_exact_operations():
    listed = FakeGraphQLClient(
        {
            "getTransaction": {
                "id": "transaction-invented",
                "pending": False,
                "attachments": [],
            }
        }
    )
    deleted = FakeGraphQLClient(
        {"deleteTransactionAttachment": {"deleted": True}}
    )

    snapshot = await list_transaction_attachments(
        listed, "transaction-invented"
    )
    result = await delete_transaction_attachment(
        deleted, "attachment-invented"
    )

    assert snapshot.attachments == ()
    assert result is True
    assert listed.calls == [
        (
            "GetTransactionDrawer",
            {"id": "transaction-invented", "redirectPosted": False},
        )
    ]
    assert deleted.calls == [
        (
            "Web_TransactionDrawerDeleteAttachment",
            {"id": "attachment-invented"},
        )
    ]


@pytest.mark.anyio
async def test_transaction_attachment_upload_uses_exact_two_step_shape():
    client = FakeGraphQLClient(
        {
            "getTransactionAttachmentUploadInfo": {
                "info": {
                    "path": "/v1_1/invented/upload",
                    "requestParams": {
                        "timestamp": 1,
                        "signature": "invented",
                        "api_key": "invented",
                    },
                }
            }
        },
        {
            "addTransactionAttachment": {
                "attachment": {
                    "id": "attachment-invented",
                    "filename": "invented",
                    "extension": "png",
                    "sizeBytes": 8,
                    "originalAssetUrl": None,
                },
                "errors": [],
            }
        },
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.cloudinary.com"
        return httpx.Response(200, json={"public_id": "public-invented"})

    attachment = await upload_transaction_attachment(
        client,
        "transaction-invented",
        filename="invented.png",
        content_type="image/png",
        content=b"invented",
        transport=httpx.MockTransport(handler),
    )

    assert attachment.id == "attachment-invented"
    assert client.calls == [
        (
            "Common_GetTransactionAttachmentUploadInfo",
            {"transactionId": "transaction-invented"},
        ),
        (
            "Common_AddTransactionAttachment",
            {
                "input": {
                    "transactionId": "transaction-invented",
                    "filename": "invented",
                    "publicId": "public-invented",
                    "extension": "png",
                    "sizeBytes": 8,
                }
            },
        ),
    ]


def test_attachment_snapshot_detects_metadata_drift_without_urls():
    original = AttachmentMetadata(
        "attachment-invented", "proof", "pdf", 10, True
    )
    changed = AttachmentMetadata(
        "attachment-invented", "proof", "pdf", 11, True
    )
    expected = TransactionAttachmentSnapshot(
        "transaction-invented", (original,)
    )

    assert attachments_match(
        expected,
        TransactionAttachmentSnapshot("transaction-invented", (original,)),
    )
    assert not attachments_match(
        expected,
        TransactionAttachmentSnapshot("transaction-invented", (changed,)),
    )


def test_ambiguous_attachment_recovery_requires_one_unique_exact_marker():
    original = AttachmentMetadata(
        "existing", "existing", "pdf", 10, True
    )
    synthetic = AttachmentMetadata(
        "synthetic", "tyrion-invented-marker", "png", 8, True
    )
    unrelated = AttachmentMetadata(
        "unrelated", "other", "png", 8, True
    )
    before = TransactionAttachmentSnapshot(
        "transaction-invented", (original,)
    )

    assert _new_synthetic_attachment_candidates(
        before,
        TransactionAttachmentSnapshot(
            "transaction-invented", (original, synthetic, unrelated)
        ),
        expected_filename="tyrion-invented-marker",
        expected_extension="png",
        expected_size=8,
    ) == (synthetic,)
    assert _new_synthetic_attachment_candidates(
        before,
        TransactionAttachmentSnapshot(
            "transaction-invented", (original, synthetic, synthetic)
        ),
        expected_filename="tyrion-invented-marker",
        expected_extension="png",
        expected_size=8,
    ) == (synthetic, synthetic)


@pytest.mark.anyio
async def test_find_receipt_pages_until_exact_opaque_id_correlation():
    client = FakeGraphQLClient(
        {
            "retailSyncsWithTotal": {
                "totalCount": 3,
                "results": [
                    receipt(identifier="receipt-one"),
                    receipt(identifier="receipt-two"),
                ],
            }
        },
        {
            "retailSyncsWithTotal": {
                "totalCount": 3,
                "results": [receipt(identifier="receipt-target")],
            }
        },
    )

    found = await find_receipt(
        client,
        "receipt-target",
        source="upload",
        page_size=2,
    )

    assert found is not None
    assert found.id == "receipt-target"
    assert [call[1]["offset"] for call in client.calls] == [0, 2]


@pytest.mark.anyio
async def test_find_receipt_fails_at_page_cap_instead_of_looping():
    client = FakeGraphQLClient(
        *[
            {
                "retailSyncsWithTotal": {
                    "totalCount": 99,
                    "results": [receipt(identifier=f"receipt-{index}")],
                }
            }
            for index in range(2)
        ]
    )

    with pytest.raises(ReceiptProbeError, match="^receipt_search_limit$"):
        await find_receipt(
            client,
            "receipt-target",
            source="upload",
            page_size=1,
            max_pages=2,
        )

    assert len(client.calls) == 2


@pytest.mark.anyio
async def test_poll_receipt_correlates_id_and_stops_at_terminal_state():
    client = FakeGraphQLClient(
        {"retailSync": receipt(status="in_progress")},
        {"retailSync": receipt(status="pending")},
        {"retailSync": receipt(status="pending_matches")},
    )
    delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)

    result = await poll_receipt(
        client,
        "receipt-invented",
        attempts=3,
        timeout_seconds=10,
        initial_delay_seconds=0.25,
        sleep=fake_sleep,
    )

    assert result.id == "receipt-invented"
    assert result.status == "pending_matches"
    assert delays == [0.25, 0.5]
    assert [call[0] for call in client.calls] == [
        "Common_RetailSyncQuery",
        "Common_RetailSyncQuery",
        "Common_RetailSyncQuery",
    ]


@pytest.mark.anyio
async def test_poll_receipt_has_hard_attempt_limit():
    client = FakeGraphQLClient(
        *[
            {"retailSync": receipt(status="in_progress")}
            for _ in range(MAX_POLL_ATTEMPTS)
        ]
    )

    with pytest.raises(ReceiptProbeError, match="^receipt_poll_timeout$"):
        await poll_receipt(
            client,
            "receipt-invented",
            attempts=MAX_POLL_ATTEMPTS,
            timeout_seconds=10,
            initial_delay_seconds=0,
            sleep=_no_sleep,
        )

    assert len(client.calls) == MAX_POLL_ATTEMPTS


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    (
        {"retailSyncsWithTotal": {"totalCount": "1", "results": []}},
        {"retailSyncsWithTotal": {"totalCount": 0, "results": {}}},
        {
            "retailSyncsWithTotal": {
                "totalCount": 1,
                "results": [receipt(), receipt(identifier="receipt-two")],
            }
        },
    ),
)
async def test_list_receipts_rejects_malformed_or_contradictory_pages(payload):
    with pytest.raises(ReceiptProbeError, match="^malformed_receipt_page$"):
        await list_receipts(
            FakeGraphQLClient(payload),
            source="upload",
            limit=1,
        )


@pytest.mark.anyio
async def test_receipt_rejects_oversized_attachment_collection():
    payload = {
        "retailSync": receipt(
            attachments=[
                {
                    "id": f"attachment-{index}",
                    "filename": "invented.png",
                    "extension": "png",
                    "sizeBytes": 1,
                    "originalAssetUrl": None,
                }
                for index in range(11)
            ]
        )
    }

    with pytest.raises(ReceiptProbeError, match="^malformed_receipt$"):
        await get_receipt(FakeGraphQLClient(payload), "receipt-invented")


@pytest.mark.anyio
@pytest.mark.parametrize("size", (0, (2 * 1024 * 1024) + 1))
async def test_receipt_upload_rejects_empty_or_oversized_input(tmp_path, size):
    path = tmp_path / "invented.png"
    path.write_bytes(b"x" * size)

    with pytest.raises(ReceiptProbeError, match="^upload_size_invalid$"):
        await upload_receipt_file(object(), "receipt-invented", path)


@pytest.mark.anyio
async def test_receipt_upload_replaces_json_content_type_with_multipart(
    tmp_path,
    monkeypatch,
):
    path = tmp_path / "invented.png"
    path.write_bytes(b"invented")
    captured: dict[str, object] = {}

    class FakeResponse:
        status_code = 200

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            captured["headers"] = kwargs["headers"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def post(self, url, *, data, files):
            request = httpx.Request(
                "POST",
                url,
                headers=captured["headers"],
                data=data,
                files=files,
            )
            captured["contentType"] = request.headers["content-type"]
            return FakeResponse()

    class Client:
        _headers = {
            "Authorization": "invented-auth-value",
            "Content-Type": "application/json",
        }
        _cookies = None
        _auth_mode = "token"

    monkeypatch.setattr(receipt_probe.httpx, "AsyncClient", FakeAsyncClient)

    await upload_receipt_file(Client(), "receipt-invented", path)

    assert captured["headers"] == {"Authorization": "invented-auth-value"}
    assert str(captured["contentType"]).startswith("multipart/form-data; boundary=")


@pytest.mark.anyio
async def test_upstream_failure_is_sanitized():
    private_detail = "signed-url-and-private-identifier"

    with pytest.raises(ReceiptProbeError) as raised:
        await get_receipt(
            FakeGraphQLClient(RuntimeError(private_detail)),
            "receipt-invented",
        )

    assert str(raised.value) == "upstream_request_failed"
    assert private_detail not in str(raised.value)


@pytest.mark.anyio
async def test_download_attachment_streams_with_mime_and_byte_limits():
    attachment = AttachmentMetadata(
        id="attachment-invented",
        filename="invented.png",
        extension="png",
        size_bytes=8,
        download_available=True,
        _asset_url="https://res.cloudinary.com/example/image/upload/invented.png",
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "image/png", "content-length": "8"},
            content=b"invented",
        )

    content = await download_attachment(
        attachment,
        max_bytes=8,
        transport=httpx.MockTransport(handler),
    )

    assert content == b"invented"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("headers", "content", "code"),
    (
        ({"content-type": "text/html"}, b"error", "attachment_type_rejected"),
        (
            {"content-type": "image/png", "content-length": str(MAX_DOWNLOAD_BYTES + 1)},
            b"",
            "attachment_too_large",
        ),
        (
            {"content-type": "image/png", "content-length": "invalid"},
            b"",
            "attachment_length_invalid",
        ),
    ),
)
async def test_download_attachment_rejects_unsafe_responses(
    headers,
    content,
    code,
):
    attachment = AttachmentMetadata(
        id="attachment-invented",
        filename=None,
        extension=None,
        size_bytes=None,
        download_available=True,
        _asset_url="https://res.cloudinary.com/example/raw/upload/invented",
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=headers, content=content)

    with pytest.raises(ReceiptProbeError, match=f"^{code}$"):
        await download_attachment(
            attachment,
            transport=httpx.MockTransport(handler),
        )


@pytest.mark.anyio
async def test_download_auth_rejection_is_stable_and_sanitized():
    attachment = AttachmentMetadata(
        id="attachment-invented",
        filename=None,
        extension=None,
        size_bytes=None,
        download_available=True,
        _asset_url="https://res.cloudinary.com/example/raw/upload/invented",
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, content=b"private signed url detail")

    with pytest.raises(ReceiptProbeError) as raised:
        await download_attachment(
            attachment,
            transport=httpx.MockTransport(handler),
        )

    assert raised.value.code == "attachment_auth_rejected"
    assert "private" not in str(raised.value)


@pytest.mark.anyio
async def test_matrix_restores_manual_match_after_ambiguous_unmatch(monkeypatch):
    candidate = ReceiptRecord(
        id="receipt-invented",
        source="upload",
        status="completed",
        created_at="2026-10-10T00:00:00Z",
        linked_transaction_id="transaction-invented",
        attachments=(),
    )
    calls: list[str] = []

    async def discover(client):
        return candidate

    async def unmatch(client, receipt_record):
        calls.append("unmatch")
        raise ReceiptProbeError("upstream_request_failed")

    async def match(client, receipt_record, transaction_id):
        calls.append("restore")

    async def get(client, receipt_id):
        calls.append("verify_restore")
        return candidate

    monkeypatch.setattr(receipt_probe, "discover_matched_pdf_candidate", discover)
    monkeypatch.setattr(receipt_probe, "unmatch_receipt", unmatch)
    monkeypatch.setattr(receipt_probe, "match_receipt", match)
    monkeypatch.setattr(receipt_probe, "get_receipt", get)

    summary = await run_matrix(object(), sleep=_no_sleep)

    assert summary["result"] == "upstream_request_failed"
    assert calls == ["unmatch", "restore", "verify_restore"]
    assert "receipt-invented" not in str(summary)
    assert "transaction-invented" not in str(summary)


def test_duplicate_and_byte_fidelity_classifications_are_stable():
    assert _classify_duplicate("first", "second") == "distinct"
    assert _classify_duplicate("same", "same") == "coalesced"
    assert _classify_duplicate("first", None) == "rejected"
    assert _classify_fidelity(b"invented", b"invented") == "identical"
    assert _classify_fidelity(b"invented", b"changed") == "transformed"


@pytest.mark.anyio
async def test_receipt_cleanup_attempts_all_objects_after_failures():
    deleted: list[str] = []
    checked: list[str] = []

    async def delete(client, receipt_id):
        deleted.append(receipt_id)
        if receipt_id == "synthetic-one":
            raise RuntimeError("private cleanup detail")
        return receipt_id != "synthetic-two"

    async def get(client, receipt_id):
        checked.append(receipt_id)
        return None

    succeeded = await _delete_synthetic_receipts(
        object(),
        [
            "synthetic-one",
            "synthetic-two",
            "synthetic-three",
            "synthetic-three",
        ],
        delete,
        get,
    )

    assert succeeded is False
    assert deleted == ["synthetic-one", "synthetic-two", "synthetic-three"]
    assert checked == ["synthetic-three"]


async def _no_sleep(delay: float) -> None:
    return None
