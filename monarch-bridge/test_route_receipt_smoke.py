"""Deterministic protected receipt route smoke-runner coverage."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response

from bridge_runtime import BridgeSettings
import main as bridge
import route_receipt_smoke
from receipt_probe import (
    AttachmentMetadata,
    DownloadedAttachment,
    ReceiptPage,
    ReceiptRecord,
)
from route_receipt_smoke import (
    MUTATION_CONFIRMATION,
    RouteSmokeError,
    SERVICE_TOKEN_ENV,
    SUCCESS_CODE,
    _SCENARIOS,
    _http_failure_code,
    _invented_receipt_png,
    _preflight_posted_transaction,
    _required_receipt,
    run,
    run_route_smoke,
)


TOKEN = "invented-route-smoke-token-value-000000000"
NOW = datetime(2026, 10, 10, 16, 0, tzinfo=timezone.utc)
PRIVATE_DETAIL = "private-upstream-identifier-and-path"


class RouteState:
    def __init__(self):
        self.owner = AsyncMock()
        self.owner.get_transaction_details.return_value = {
            "getTransaction": {
                "id": "transaction-opaque",
                "pending": False,
            }
        }
        self.records = {
            "manual-candidate": self._receipt(
                "manual-candidate",
                linked_transaction_id="transaction-opaque",
                media_type="application/pdf",
                content=b"%PDF-1.4 invented candidate",
            )
        }
        self.content = {
            "attachment-manual-candidate": b"%PDF-1.4 invented candidate"
        }
        self.adapter_clients: list[object] = []
        self.fail_at: str | None = None
        self.cleanup_calls: list[str] = []
        self.matched_reads = 0
        self.manual_reads = 0
        self.manual_unmatched = False
        self.synthetic_deleted = False

    def _receipt(
        self,
        identifier: str,
        *,
        linked_transaction_id: str | None = None,
        status: str = "completed",
        media_type: str | None = None,
        content: bytes | None = None,
    ) -> ReceiptRecord:
        extension = {
            "application/pdf": "pdf",
            "image/png": "png",
        }.get(media_type)
        attachments = (
            (
                AttachmentMetadata(
                    id=f"attachment-{identifier}",
                    filename=f"invented.{extension}",
                    extension=extension,
                    size_bytes=len(content),
                    download_available=True,
                    _asset_url="https://res.cloudinary.com/invented/asset",
                ),
            )
            if content is not None and extension is not None
            else ()
        )
        return ReceiptRecord(
            id=identifier,
            source="upload",
            status=status,
            created_at="2026-10-10T12:00:00Z",
            linked_transaction_id=linked_transaction_id,
            attachments=attachments,
        )

    def _capture(self, client):
        self.adapter_clients.append(client)
        if client is not self.owner:
            raise AssertionError("route or cleanup used a different client")

    async def list_receipts(self, client, *, source, limit, offset):
        self._capture(client)
        if self.fail_at == "list":
            raise RuntimeError(PRIVATE_DETAIL)
        values = list(self.records.values())
        return ReceiptPage(
            receipts=tuple(values[offset:offset + limit]),
            total_count=len(values),
            limit=limit,
            offset=offset,
        )

    async def get_receipt(self, client, receipt_id):
        self._capture(client)
        if receipt_id == "manual-candidate":
            self.manual_reads += 1
            if self.fail_at == "detail" and self.manual_reads == 1:
                raise RuntimeError(PRIVATE_DETAIL)
            if self.fail_at == "manual_unmatch_readback" and self.manual_reads == 3:
                raise RuntimeError(PRIVATE_DETAIL)
            if self.fail_at == "manual_restore_readback" and self.manual_reads == 5:
                raise RuntimeError(PRIVATE_DETAIL)
        if self.fail_at == "read_back" and receipt_id == "synthetic-receipt":
            record = self.records.get(receipt_id)
            if record and record.linked_transaction_id is not None:
                self.matched_reads += 1
                if self.matched_reads > 1:
                    return replace(record, linked_transaction_id=None)
        return self.records.get(receipt_id)

    async def create_receipt(self, client):
        self._capture(client)
        if self.fail_at == "create":
            raise RuntimeError(PRIVATE_DETAIL)
        value = self._receipt("synthetic-receipt", status="pending")
        self.records[value.id] = value
        return value

    async def upload_receipt_file(self, client, receipt_id, path):
        self._capture(client)
        if self.fail_at == "upload":
            raise RuntimeError(PRIVATE_DETAIL)
        content = path.read_bytes()
        self.content[f"attachment-{receipt_id}"] = content
        self.records[receipt_id] = self._receipt(
            receipt_id,
            status="pending",
            media_type="image/png",
            content=content,
        )

    async def start_receipt(self, client, receipt_id):
        self._capture(client)
        current = self.records[receipt_id]
        self.records[receipt_id] = replace(current, status="in_progress")
        return self.records[receipt_id]

    async def poll_receipt(self, client, receipt_id):
        self._capture(client)
        if self.fail_at == "poll":
            raise RuntimeError(PRIVATE_DETAIL)
        current = self.records[receipt_id]
        self.records[receipt_id] = replace(current, status="pending_matches")
        return self.records[receipt_id]

    async def download(self, attachment, *, max_bytes):
        content = self.content[attachment.id]
        media_type = (
            "application/pdf"
            if attachment.extension == "pdf"
            else "image/png"
        )
        if self.fail_at == "existing_download" and attachment.extension == "pdf":
            media_type = "image/png"
        if self.fail_at == "synthetic_download" and attachment.extension == "png":
            content = b"different"
        return DownloadedAttachment(content=content, media_type=media_type)

    async def match_receipt(self, client, receipt, transaction_id):
        self._capture(client)
        self.cleanup_calls.append(f"match:{receipt.id}")
        if self.fail_at == "match" and receipt.id == "synthetic-receipt":
            raise RuntimeError(PRIVATE_DETAIL)
        if (
            self.fail_at == "manual_restore"
            and receipt.id == "manual-candidate"
        ):
            raise RuntimeError(PRIVATE_DETAIL)
        self.records[receipt.id] = replace(
            receipt,
            linked_transaction_id=transaction_id,
        )
        if (
            self.fail_at == "manual_restore_after"
            and receipt.id == "manual-candidate"
        ):
            raise RuntimeError(PRIVATE_DETAIL)

    async def unmatch_receipt(self, client, receipt):
        self._capture(client)
        if (
            self.fail_at == "manual_unmatch"
            and receipt.id == "manual-candidate"
        ):
            raise RuntimeError(PRIVATE_DETAIL)
        self.cleanup_calls.append(f"unmatch:{receipt.id}")
        self.records[receipt.id] = replace(
            receipt,
            linked_transaction_id=None,
        )
        if receipt.id == "manual-candidate":
            self.manual_unmatched = True
        if (
            self.fail_at == "manual_unmatch_after"
            and receipt.id == "manual-candidate"
        ):
            raise RuntimeError(PRIVATE_DETAIL)

    async def delete_receipt(self, client, receipt_id):
        self._capture(client)
        self.cleanup_calls.append(f"delete:{receipt_id}")
        if self.fail_at == "cleanup":
            return False
        self.records.pop(receipt_id, None)
        self.synthetic_deleted = True
        return True


@pytest.fixture
def route_state(monkeypatch):
    state = RouteState()
    monkeypatch.setattr(bridge, "DEMO_MODE", False)
    monkeypatch.setattr(
        bridge,
        "SETTINGS",
        BridgeSettings(
            host="127.0.0.1",
            port=8100,
            api_token=TOKEN,
            allowed_origins=("https://invented.invalid",),
            session_file=bridge.SETTINGS.session_file,
            remote_tls=False,
            max_auth_body_bytes=16384,
        ),
    )
    monkeypatch.setattr(
        bridge,
        "get_client",
        AsyncMock(return_value=state.owner),
    )
    monkeypatch.setattr(bridge, "list_receipts", state.list_receipts)
    monkeypatch.setattr(bridge, "get_receipt", state.get_receipt)
    monkeypatch.setattr(bridge, "create_receipt", state.create_receipt)
    monkeypatch.setattr(
        bridge,
        "upload_receipt_file",
        state.upload_receipt_file,
    )
    monkeypatch.setattr(bridge, "start_receipt", state.start_receipt)
    monkeypatch.setattr(bridge, "poll_receipt", state.poll_receipt)
    monkeypatch.setattr(bridge, "download_attachment_payload", state.download)
    monkeypatch.setattr(bridge, "match_receipt", state.match_receipt)
    return state


async def execute(state, *, token=TOKEN, timeout=180.0):
    return await run_route_smoke(
        bridge.app,
        state.owner,
        token=token,
        now=NOW,
        total_timeout=timeout,
        delete_receipt_func=state.delete_receipt,
        get_receipt_func=state.get_receipt,
        unmatch_receipt_func=state.unmatch_receipt,
        match_receipt_func=state.match_receipt,
    )


@pytest.mark.anyio
async def test_route_smoke_runs_exact_protected_contract_and_same_owner_cleanup(
    route_state,
):
    result = await execute(route_state)

    assert result == {
        "result": SUCCESS_CODE,
        **{scenario: "passed" for scenario in _SCENARIOS},
    }
    assert route_state.cleanup_calls == [
        "unmatch:manual-candidate",
        "match:synthetic-receipt",
        "unmatch:synthetic-receipt",
        "delete:synthetic-receipt",
        "match:manual-candidate",
    ]
    assert route_state.adapter_clients
    assert all(client is route_state.owner for client in route_state.adapter_clients)
    assert (
        route_state.records["manual-candidate"].linked_transaction_id
        == "transaction-opaque"
    )
    assert "synthetic-receipt" not in route_state.records
    assert bridge.get_client.await_count >= 7


@pytest.mark.anyio
async def test_route_smoke_rejects_wrong_service_token_before_any_mutation(
    route_state,
):
    result = await execute(route_state, token="wrong-token-value-0000000000000000")

    assert (
        result["result"]
        == "protected_receipt_route_list_http_4xx_bridge_auth_required"
    )
    assert result["cleanup"] == "not_run"
    assert route_state.cleanup_calls == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("environment", "code"),
    (
        ({}, "protected_receipt_route_smoke_disabled"),
        (
            {"TYRION_LIVE_ROUTE_RECEIPT_SMOKE": "1"},
            "protected_receipt_route_mutation_confirmation_required",
        ),
        (
            {
                "TYRION_LIVE_ROUTE_RECEIPT_SMOKE": "1",
                "TYRION_LIVE_ROUTE_RECEIPT_MUTATION_CONFIRM": MUTATION_CONFIRMATION,
            },
            "protected_receipt_route_session_path_required",
        ),
        (
            {
                "TYRION_LIVE_ROUTE_RECEIPT_SMOKE": "1",
                "TYRION_LIVE_ROUTE_RECEIPT_MUTATION_CONFIRM": MUTATION_CONFIRMATION,
                "SESSION_FILE": "invented-external-path",
            },
            "protected_receipt_route_service_token_required",
        ),
    ),
)
async def test_route_smoke_gates_are_exact_and_do_not_load_dotenv(
    monkeypatch,
    environment,
    code,
):
    for name in (
        "TYRION_LIVE_ROUTE_RECEIPT_SMOKE",
        "TYRION_LIVE_ROUTE_RECEIPT_MUTATION_CONFIRM",
        "SESSION_FILE",
        "BRIDGE_API_TOKEN",
        SERVICE_TOKEN_ENV,
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    result = await run()

    assert result == {
        "result": code,
        **{scenario: "not_run" for scenario in _SCENARIOS},
    }
    assert PRIVATE_DETAIL not in json.dumps(result)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("transaction_result", "side_effect", "code"),
    (
        (
            {"getTransaction": None},
            None,
            "protected_receipt_route_match_preflight_not_found",
        ),
        (
            {
                "getTransaction": {
                    "id": "transaction-opaque",
                    "pending": True,
                }
            },
            None,
            "protected_receipt_route_match_preflight_pending",
        ),
        (
            {
                "getTransaction": {
                    "id": "transaction-redirected",
                    "pending": False,
                }
            },
            None,
            "protected_receipt_route_match_preflight_identity_mismatch",
        ),
        (
            {"getTransaction": {"id": "transaction-opaque"}},
            None,
            "protected_receipt_route_match_preflight_malformed",
        ),
        (
            {},
            None,
            "protected_receipt_route_match_preflight_malformed",
        ),
        (
            None,
            RuntimeError(PRIVATE_DETAIL),
            "protected_receipt_route_match_preflight_unavailable",
        ),
    ),
)
async def test_match_preflight_fails_before_synthetic_mutation(
    route_state,
    transaction_result,
    side_effect,
    code,
):
    route_state.owner.get_transaction_details.reset_mock()
    route_state.owner.get_transaction_details.return_value = transaction_result
    route_state.owner.get_transaction_details.side_effect = side_effect

    result = await execute(route_state)

    assert result["result"] == code
    assert result["match_preflight"] == "not_run"
    assert result["create"] == "not_run"
    assert result["cleanup"] == "not_run"
    assert "synthetic-receipt" not in route_state.records
    assert PRIVATE_DETAIL not in json.dumps(result)
    route_state.owner.get_transaction_details.assert_awaited_once_with(
        "transaction-opaque",
        redirect_posted=False,
    )


@pytest.mark.anyio
async def test_match_preflight_accepts_exact_posted_transaction_contract():
    client = AsyncMock()
    client.get_transaction_details.return_value = {
        "getTransaction": {
            "id": "transaction-invented",
            "pending": False,
        }
    }

    await _preflight_posted_transaction(client, "transaction-invented")

    client.get_transaction_details.assert_awaited_once_with(
        "transaction-invented",
        redirect_posted=False,
    )


@pytest.mark.parametrize(
    ("status", "body", "media_type", "expected"),
    (
        (
            409,
            b'{"error":{"code":"pending_transaction_not_supported",'
            b'"message":"private detail"}}',
            "application/json",
            (
                "protected_receipt_route_match_http_"
                "4xx_pending_transaction_not_supported"
            ),
        ),
        (
            502,
            b'{"error":{"code":"receipt_upstream_error",'
            b'"message":"private detail"}}',
            "application/json",
            (
                "protected_receipt_route_match_http_"
                "5xx_receipt_upstream_error"
            ),
        ),
        (
            418,
            b'{"error":{"code":"private-upstream-id"}}',
            "application/json",
            "protected_receipt_route_match_http_4xx_unrecognized_error",
        ),
        (
            302,
            b"https://private.invalid/redirect",
            "text/plain",
            "protected_receipt_route_match_http_other_unrecognized_error",
        ),
    ),
)
def test_match_http_failure_classification_is_allowlisted_and_sanitized(
    status,
    body,
    media_type,
    expected,
):
    result = _http_failure_code("match", status, body, media_type)

    assert result == expected
    assert "private" not in result
    assert "message" not in result


@pytest.mark.parametrize(
    "scenario",
    ("detail", "create", "upload_poll", "match", "read_back"),
)
def test_malformed_receipt_dto_failure_names_route_scenario(scenario):
    payload = {
        "receipt": {
            "id": PRIVATE_DETAIL,
            "attachments": "private-response-shape",
        }
    }

    with pytest.raises(RouteSmokeError) as raised:
        _required_receipt(payload, scenario=scenario)

    assert raised.value.code == (
        f"protected_receipt_route_{scenario}_response_malformed"
    )
    assert PRIVATE_DETAIL not in raised.value.code


@pytest.mark.anyio
async def test_route_smoke_preserves_sanitized_match_4xx_and_cleans_up(
    route_state,
):
    posted = {
        "getTransaction": {
            "id": "transaction-opaque",
            "pending": False,
        }
    }
    pending = {
        "getTransaction": {
            "id": "transaction-opaque",
            "pending": True,
        }
    }
    route_state.owner.get_transaction_details.side_effect = [posted, pending]

    result = await execute(route_state)

    assert (
        result["result"]
        == (
            "protected_receipt_route_match_http_"
            "4xx_pending_transaction_not_supported"
        )
    )
    assert result["match_preflight"] == "passed"
    assert result["match"] == "not_run"
    assert result["cleanup"] == "passed"
    assert "synthetic-receipt" not in route_state.records
    assert set(result) == {"result", *_SCENARIOS}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("candidate_count", "code"),
    (
        (0, "protected_receipt_route_candidate_not_found"),
        (2, "protected_receipt_route_candidate_ambiguous"),
    ),
)
async def test_route_smoke_candidate_absence_and_ambiguity_fail_closed(
    route_state,
    candidate_count,
    code,
):
    route_state.records.clear()
    for index in range(candidate_count):
        identifier = f"manual-{index}"
        route_state.records[identifier] = route_state._receipt(
            identifier,
            linked_transaction_id=f"transaction-{index}",
            media_type="application/pdf",
            content=b"%PDF invented",
        )

    result = await execute(route_state)

    assert result["result"] == code
    assert result["cleanup"] == "not_run"


@pytest.mark.anyio
async def test_route_smoke_candidate_discovery_pagination_is_hard_capped(
    route_state,
):
    route_state.records = {
        f"unmatched-{index}": route_state._receipt(f"unmatched-{index}")
        for index in range(51)
    }

    result = await execute(route_state)

    assert result["result"] == "protected_receipt_route_candidate_search_limit"
    assert bridge.get_client.await_count == 2


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("fail_at", "expected"),
    (
        ("detail", "protected_receipt_route_detail_http_5xx_internal_error"),
        ("existing_download", "protected_receipt_route_download_mismatch"),
        ("create", "protected_receipt_route_cleanup_failed"),
        (
            "upload",
            "protected_receipt_route_upload_poll_http_5xx_internal_error",
        ),
        (
            "poll",
            "protected_receipt_route_upload_poll_http_5xx_internal_error",
        ),
        ("synthetic_download", "protected_receipt_route_download_mismatch"),
        (
            "manual_unmatch",
            "protected_receipt_route_manual_unmatch_failed",
        ),
        (
            "manual_unmatch_readback",
            "protected_receipt_route_manual_unmatch_failed",
        ),
        ("match", "protected_receipt_route_match_http_5xx_upstream_error"),
        ("read_back", "protected_receipt_route_read_back_mismatch"),
    ),
)
async def test_route_smoke_sanitizes_failures_and_cleans_every_created_identity(
    route_state,
    fail_at,
    expected,
):
    route_state.fail_at = fail_at

    result = await execute(route_state)

    assert result["result"] == expected
    assert PRIVATE_DETAIL not in json.dumps(result)
    if fail_at in {"detail", "existing_download"}:
        assert result["cleanup"] == "not_run"
    elif fail_at == "create":
        assert result["cleanup"] == "failed_manual_inspection_required"
    else:
        assert result["cleanup"] == "passed"
        assert "synthetic-receipt" not in route_state.records
    assert result["manual_restore"] == "passed"
    assert (
        route_state.records["manual-candidate"].linked_transaction_id
        == "transaction-opaque"
    )


@pytest.mark.anyio
async def test_manual_unmatch_accepts_authoritative_success_after_mutation_error(
    route_state,
):
    route_state.fail_at = "manual_unmatch_after"

    result = await execute(route_state)

    assert result["result"] == SUCCESS_CODE
    assert result["manual_unmatch"] == "passed"
    assert result["manual_restore"] == "passed"
    assert (
        route_state.records["manual-candidate"].linked_transaction_id
        == "transaction-opaque"
    )


@pytest.mark.anyio
async def test_manual_unmatch_rejects_relationship_drift_before_mutation(
    route_state,
):
    route_state.records["manual-candidate"] = replace(
        route_state.records["manual-candidate"],
        linked_transaction_id=None,
    )
    unmatcher = AsyncMock()

    with pytest.raises(RouteSmokeError) as raised:
        await route_receipt_smoke._ensure_manual_unmatched(
            route_state.owner,
            "manual-candidate",
            "transaction-opaque",
            getter=route_state.get_receipt,
            unmatcher=unmatcher,
        )

    assert (
        raised.value.code
        == "protected_receipt_route_manual_unmatch_failed"
    )
    unmatcher.assert_not_awaited()


@pytest.mark.anyio
async def test_manual_restore_is_idempotent_when_relationship_is_already_restored(
    route_state,
):
    matcher = AsyncMock()

    await route_receipt_smoke._ensure_manual_restored(
        route_state.owner,
        "manual-candidate",
        "transaction-opaque",
        getter=route_state.get_receipt,
        matcher=matcher,
    )

    matcher.assert_not_awaited()


@pytest.mark.anyio
async def test_manual_restore_accepts_authoritative_success_after_mutation_error(
    route_state,
):
    route_state.fail_at = "manual_restore_after"

    result = await execute(route_state)

    assert result["result"] == SUCCESS_CODE
    assert result["manual_restore"] == "passed"
    assert (
        route_state.records["manual-candidate"].linked_transaction_id
        == "transaction-opaque"
    )


@pytest.mark.anyio
async def test_manual_restore_failure_overrides_primary_failure_and_stops_callers(
    route_state,
):
    route_state.fail_at = "manual_restore"

    result = await execute(route_state)

    assert result["result"] == "protected_receipt_route_cleanup_failed"
    assert result["cleanup"] == "passed"
    assert result["manual_restore"] == "failed_manual_inspection_required"
    assert "synthetic-receipt" not in route_state.records
    assert route_state.synthetic_deleted is True
    assert route_state.records["manual-candidate"].linked_transaction_id is None
    assert PRIVATE_DETAIL not in json.dumps(result)


@pytest.mark.anyio
async def test_manual_restore_readback_failure_requires_manual_inspection(
    route_state,
):
    route_state.fail_at = "manual_restore_readback"

    result = await execute(route_state)

    assert result["result"] == "protected_receipt_route_cleanup_failed"
    assert result["cleanup"] == "passed"
    assert result["manual_restore"] == "failed_manual_inspection_required"
    assert PRIVATE_DETAIL not in json.dumps(result)


@pytest.mark.anyio
async def test_synthetic_cleanup_precedes_manual_restoration_even_when_both_fail(
    route_state,
):
    async def delete_fails(client, receipt_id):
        route_state._capture(client)
        route_state.cleanup_calls.append(f"delete:{receipt_id}")
        return False

    async def restore_fails(client, receipt, transaction_id):
        route_state._capture(client)
        route_state.cleanup_calls.append(f"match:{receipt.id}")
        if receipt.id == "manual-candidate":
            raise RuntimeError(PRIVATE_DETAIL)
        await route_state.match_receipt(client, receipt, transaction_id)

    result = await run_route_smoke(
        bridge.app,
        route_state.owner,
        token=TOKEN,
        now=NOW,
        delete_receipt_func=delete_fails,
        get_receipt_func=route_state.get_receipt,
        unmatch_receipt_func=route_state.unmatch_receipt,
        match_receipt_func=restore_fails,
    )

    assert result["result"] == "protected_receipt_route_cleanup_failed"
    assert result["cleanup"] == "failed_manual_inspection_required"
    assert result["manual_restore"] == "failed_manual_inspection_required"
    assert route_state.cleanup_calls.index("delete:synthetic-receipt") < (
        route_state.cleanup_calls.index("match:manual-candidate")
    )


@pytest.mark.anyio
async def test_cleanup_failure_overrides_primary_failure_and_stops_for_inspection(
    route_state,
):
    route_state.fail_at = "match"

    async def cleanup_fails(client, receipt_id):
        route_state._capture(client)
        route_state.cleanup_calls.append("delete")
        return False

    result = await run_route_smoke(
        bridge.app,
        route_state.owner,
        token=TOKEN,
        now=NOW,
        delete_receipt_func=cleanup_fails,
        get_receipt_func=route_state.get_receipt,
        unmatch_receipt_func=route_state.unmatch_receipt,
        match_receipt_func=route_state.match_receipt,
    )

    assert result["result"] == "protected_receipt_route_cleanup_failed"
    assert result["cleanup"] == "failed_manual_inspection_required"
    assert "synthetic-receipt" in route_state.records


@pytest.mark.anyio
async def test_route_smoke_rejects_malformed_and_oversized_route_responses():
    malformed = FastAPI()

    @malformed.get("/receipts")
    async def malformed_list():
        return Response(content=b"not-json", media_type="application/json")

    oversized = FastAPI()

    @oversized.get("/receipts")
    async def oversized_list():
        return JSONResponse({"padding": "x" * (65 * 1024)})

    noop = AsyncMock()
    first = await run_route_smoke(
        malformed,
        object(),
        token=TOKEN,
        now=NOW,
        delete_receipt_func=noop,
        get_receipt_func=noop,
        unmatch_receipt_func=noop,
        match_receipt_func=noop,
    )
    second = await run_route_smoke(
        oversized,
        object(),
        token=TOKEN,
        now=NOW,
        delete_receipt_func=noop,
        get_receipt_func=noop,
        unmatch_receipt_func=noop,
        match_receipt_func=noop,
    )

    assert first["result"] == "protected_receipt_route_list_response_malformed"
    assert second["result"] == "protected_receipt_route_list_response_too_large"
    assert first["cleanup"] == second["cleanup"] == "not_run"


@pytest.mark.anyio
async def test_route_smoke_total_runtime_is_capped_and_sanitized():
    slow = FastAPI()

    @slow.get("/receipts")
    async def slow_list():
        import asyncio

        await asyncio.sleep(0.05)
        return {"receipts": [], "page": {}}

    noop = AsyncMock()
    result = await run_route_smoke(
        slow,
        object(),
        token=TOKEN,
        now=NOW,
        total_timeout=0.001,
        delete_receipt_func=noop,
        get_receipt_func=noop,
        unmatch_receipt_func=noop,
        match_receipt_func=noop,
    )

    assert result["result"] == "protected_receipt_route_total_timeout"
    assert result["cleanup"] == "not_run"


@pytest.mark.anyio
async def test_complete_run_timeout_includes_bridge_client_acquisition(
    monkeypatch,
):
    route_budgets = []

    async def delayed_client():
        await asyncio.sleep(0.015)
        return object()

    async def delayed_routes(app, owner_client, *, token, total_timeout):
        route_budgets.append(total_timeout)
        await asyncio.sleep(total_timeout + 0.02)
        return {"result": SUCCESS_CODE}

    monkeypatch.setenv("TYRION_LIVE_ROUTE_RECEIPT_SMOKE", "1")
    monkeypatch.setenv(
        "TYRION_LIVE_ROUTE_RECEIPT_MUTATION_CONFIRM",
        MUTATION_CONFIRMATION,
    )
    monkeypatch.setenv("SESSION_FILE", "invented-external-path")
    monkeypatch.setenv(SERVICE_TOKEN_ENV, TOKEN)
    monkeypatch.setattr(route_receipt_smoke, "MAX_TOTAL_SECONDS", 0.1)
    monkeypatch.setattr(route_receipt_smoke, "run_route_smoke", delayed_routes)
    monkeypatch.setattr(bridge, "get_client", delayed_client)

    result = await run()

    assert result["result"] == "protected_receipt_route_total_timeout"
    assert result["cleanup"] == "not_run"
    assert len(route_budgets) == 1
    assert 0 < route_budgets[0] < 0.095


@pytest.mark.anyio
async def test_cleanup_has_independent_hard_timeout(route_state, monkeypatch):
    route_state.fail_at = "match"
    monkeypatch.setattr(
        route_receipt_smoke,
        "MAX_SYNTHETIC_CLEANUP_SECONDS",
        0.01,
    )

    async def stalled_getter(client, receipt_id):
        route_state._capture(client)
        if receipt_id == "synthetic-receipt":
            await asyncio.sleep(1)
        return await route_state.get_receipt(client, receipt_id)

    result = await asyncio.wait_for(
        run_route_smoke(
            bridge.app,
            route_state.owner,
            token=TOKEN,
            now=NOW,
            total_timeout=1.0,
            delete_receipt_func=route_state.delete_receipt,
            get_receipt_func=stalled_getter,
            unmatch_receipt_func=route_state.unmatch_receipt,
            match_receipt_func=route_state.match_receipt,
        ),
        timeout=0.2,
    )

    assert result["result"] == "protected_receipt_route_cleanup_failed"
    assert result["cleanup"] == "failed_manual_inspection_required"
    assert result["manual_restore"] == "passed"
    assert (
        route_state.records["manual-candidate"].linked_transaction_id
        == "transaction-opaque"
    )


def test_invented_route_receipt_is_readable_and_within_upload_cap():
    content = _invented_receipt_png()

    assert content.startswith(b"\x89PNG\r\n\x1a\n")
    assert b"private" not in content
    assert 0 < len(content) < 2 * 1024 * 1024
