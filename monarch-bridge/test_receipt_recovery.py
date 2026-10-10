"""Deterministic coverage for the disabled Monarch-first recovery worker."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError
from receipt_recovery_clients import (
    BridgeRecoveryClient,
    OwlRecoveryClient,
    RecoveryContractError,
)
from receipt_recovery_contract import (
    IntakeResult,
    Receipt,
    RecoverySettings,
    recovery_identity,
)
from receipt_recovery_state import (
    RecoveryCheckpoint,
    RecoveryState,
    ensure_external_path,
)
from receipt_recovery_worker import ReceiptRecoveryWorker

TOKEN = "t" * 32
NAMESPACE = b"n" * 32


def settings(tmp_path: Path) -> RecoverySettings:
    return RecoverySettings(
        enabled=True,
        bridge_url="http://bridge/",
        bridge_token=TOKEN,
        owl_url="http://owl/",
        owl_token=TOKEN,
        identity_namespace=NAMESPACE,
        state_file=tmp_path / "checkpoint.json",
        page_size=25,
        max_pages=4,
        max_items=20,
        max_bytes=1024,
        request_timeout_seconds=5,
    )


def receipt_payload(*, receipt_id: str = "receipt-invented") -> dict:
    return {
        "id": receipt_id,
        "source": "upload",
        "status": "matched",
        "createdAt": "2026-10-10T12:00:00Z",
        "linkedTransactionId": "transaction-invented",
        "attachments": [
            {
                "id": "attachment-invented",
                "mediaType": "image/png",
                "sizeBytes": 8,
                "downloadAvailable": True,
            }
        ],
    }


def receipt_model(*, receipt_id: str, attachment_id: str) -> Receipt:
    payload = receipt_payload(receipt_id=receipt_id)
    payload["attachments"][0]["id"] = attachment_id
    return Receipt.model_validate(payload)


def intake_payload(
    *,
    outcome: str = "new_canonical",
    attempt_state: str = "accepted",
    eligible: bool = False,
) -> dict:
    return {
        "schema_version": "1.0",
        "intake_ref": "intake_invented",
        "outcome": outcome,
        "attempt_state": attempt_state,
        "canonical_document_ref": (
            "document_invented" if attempt_state == "accepted" else None
        ),
        "review_ref": None,
        "reason_codes": ["invented_reason"],
        "source_channel": "monarch_recovery",
        "source_occurrence_version": "1",
        "source_as_of": "2026-10-10T12:00:00Z",
        "retry_safe": attempt_state == "retryable",
        "external_replica_eligible": eligible,
    }


class MemoryState:
    def __init__(self, checkpoint: RecoveryCheckpoint | None = None):
        self.checkpoint = checkpoint or RecoveryCheckpoint()
        self.saved: list[RecoveryCheckpoint] = []
        self.cleared = False

    def load(self) -> RecoveryCheckpoint:
        return self.checkpoint

    def save(self, checkpoint: RecoveryCheckpoint) -> None:
        self.checkpoint = checkpoint
        self.saved.append(checkpoint)

    def clear(self) -> None:
        self.cleared = True


@pytest.mark.anyio
async def test_recovery_queries_occurrence_then_streams_to_owl(tmp_path):
    artifact_path: Path | None = None
    bridge_methods = []
    owl_calls = []

    def bridge_handler(request: httpx.Request) -> httpx.Response:
        bridge_methods.append((request.method, request.url.path))
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if request.url.path == "/receipts":
            receipts = (
                [receipt_payload()] if request.url.params["source"] == "upload" else []
            )
            payload = {
                "contractVersion": "1.0",
                "provenance": {"provider": "live", "fetchedAt": "2026-10-10T12:00:00Z"},
                "receipts": receipts,
                "page": {
                    "limit": 25,
                    "offset": 0,
                    "total": len(receipts),
                    "hasMore": False,
                },
            }
            return httpx.Response(200, json=payload)
        if request.url.path == "/receipts/receipt-invented":
            return httpx.Response(
                200,
                json={
                    "contractVersion": "1.0",
                    "provenance": {
                        "provider": "live",
                        "fetchedAt": "2026-10-10T12:00:00Z",
                    },
                    "receipt": receipt_payload(),
                },
            )
        if request.url.path.endswith("/content"):
            return httpx.Response(
                200,
                content=b"\x89PNGdata",
                headers={"Content-Type": "image/png", "Content-Length": "8"},
            )
        raise AssertionError("unexpected Bridge operation")

    async def owl_handler(request: httpx.Request) -> httpx.Response:
        nonlocal artifact_path
        owl_calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if request.method == "GET":
            assert request.headers["x-owl-source-occurrence"]
            return httpx.Response(404)
        assert request.headers["x-owl-source-channel"] == "monarch_recovery"
        assert request.headers["x-owl-transform-version"] == "identity-v1"
        assert request.headers["x-owl-connector-ref"].startswith("receipt-v1_")
        body = await request.aread()
        assert body == b"\x89PNGdata"
        return httpx.Response(202, json=intake_payload())

    configured = settings(tmp_path)
    bridge = BridgeRecoveryClient(
        configured, transport=httpx.MockTransport(bridge_handler)
    )
    owl = OwlRecoveryClient(configured, transport=httpx.MockTransport(owl_handler))
    state = MemoryState()
    try:
        result = await ReceiptRecoveryWorker(
            configured,
            bridge,
            owl,
            state,  # type: ignore[arg-type]
        ).run()
    finally:
        await bridge.close()
        await owl.close()

    assert result.result == "recovery_complete"
    assert result.counts == {"accepted": 1}
    assert state.cleared
    assert all(method == "GET" for method, _ in bridge_methods)
    assert owl_calls == [
        ("GET", "/api/receipt-intake/v1/lookup"),
        ("POST", "/api/receipt-intake/v1/occurrences"),
    ]
    assert artifact_path is None


@pytest.mark.anyio
async def test_prior_occurrence_reuse_skips_detail_and_download(tmp_path):
    bridge_paths = []

    def bridge_handler(request: httpx.Request) -> httpx.Response:
        bridge_paths.append(request.url.path)
        if request.url.path != "/receipts":
            raise AssertionError("artifact must not be fetched")
        receipts = (
            [receipt_payload()] if request.url.params["source"] == "upload" else []
        )
        return httpx.Response(
            200,
            json={
                "contractVersion": "1.0",
                "provenance": {"provider": "live", "fetchedAt": "2026-10-10T12:00:00Z"},
                "receipts": receipts,
                "page": {
                    "limit": 25,
                    "offset": 0,
                    "total": len(receipts),
                    "hasMore": False,
                },
            },
        )

    def owl_handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        return httpx.Response(
            200,
            json=intake_payload(outcome="source_occurrence_reused"),
        )

    configured = settings(tmp_path)
    bridge = BridgeRecoveryClient(
        configured, transport=httpx.MockTransport(bridge_handler)
    )
    owl = OwlRecoveryClient(configured, transport=httpx.MockTransport(owl_handler))
    try:
        result = await ReceiptRecoveryWorker(
            configured,
            bridge,
            owl,
            MemoryState(),  # type: ignore[arg-type]
        ).run()
    finally:
        await bridge.close()
        await owl.close()
    assert result.counts == {"duplicate": 1}
    assert bridge_paths == ["/receipts", "/receipts"]


@pytest.mark.anyio
async def test_unknown_submit_is_looked_up_before_any_retry(tmp_path):
    lookup_count = 0
    submit_count = 0

    def bridge_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/receipts":
            source = request.url.params["source"]
            receipts = [receipt_payload()] if source == "upload" else []
            return httpx.Response(
                200,
                json={
                    "contractVersion": "1.0",
                    "provenance": {
                        "provider": "live",
                        "fetchedAt": "2026-10-10T12:00:00Z",
                    },
                    "receipts": receipts,
                    "page": {
                        "limit": 25,
                        "offset": 0,
                        "total": len(receipts),
                        "hasMore": False,
                    },
                },
            )
        if request.url.path == "/receipts/receipt-invented":
            return httpx.Response(
                200,
                json={
                    "contractVersion": "1.0",
                    "provenance": {
                        "provider": "live",
                        "fetchedAt": "2026-10-10T12:00:00Z",
                    },
                    "receipt": receipt_payload(),
                },
            )
        return httpx.Response(
            200,
            content=b"\x89PNGdata",
            headers={"Content-Type": "image/png", "Content-Length": "8"},
        )

    def owl_handler(request: httpx.Request) -> httpx.Response:
        nonlocal lookup_count, submit_count
        if request.method == "GET":
            lookup_count += 1
            return (
                httpx.Response(404)
                if lookup_count == 1
                else httpx.Response(
                    200,
                    json=intake_payload(outcome="paperless_duplicate"),
                )
            )
        submit_count += 1
        raise httpx.ConnectError("invented private value", request=request)

    configured = settings(tmp_path)
    bridge = BridgeRecoveryClient(
        configured, transport=httpx.MockTransport(bridge_handler)
    )
    owl = OwlRecoveryClient(configured, transport=httpx.MockTransport(owl_handler))
    try:
        result = await ReceiptRecoveryWorker(
            configured,
            bridge,
            owl,
            MemoryState(),  # type: ignore[arg-type]
        ).run()
    finally:
        await bridge.close()
        await owl.close()
    assert result.result == "recovery_complete"
    assert result.counts == {"duplicate": 1}
    assert lookup_count == 2
    assert submit_count == 1


def test_identity_matches_owl_channel_scoped_algorithm():
    receipt = Receipt.model_validate(receipt_payload())
    attachment = receipt.attachments[0]
    identity = recovery_identity(
        namespace=NAMESPACE, receipt=receipt, attachment=attachment
    )
    payload = {
        "version": 1,
        "channel": "monarch_recovery",
        "parts": {
            "connector_ref": (
                "connector-v1_"
                + __import__("base64")
                .urlsafe_b64encode(
                    hashlib.sha256(NAMESPACE + b"\0connector\0monarch").digest()
                )
                .decode()
                .rstrip("=")
            ),
            "receipt_ref": identity.external_replica_ref,
            "receipt_version": identity.receipt_version,
        },
    }
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert identity.source_occurrence_id == expected
    assert identity.external_replica_ref.startswith("receipt-v1_")


def test_monarch_recovery_result_must_disable_external_replica():
    with pytest.raises(ValidationError):
        IntakeResult.model_validate(intake_payload(eligible=True))


def test_disabled_settings_require_no_secrets():
    configured = RecoverySettings.from_env({"TYRION_MONARCH_RECOVERY_ENABLED": "false"})
    assert configured.enabled is False


def test_checkpoint_contains_only_safe_cursor(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "receipt_recovery_state._restrict", lambda *args, **kwargs: None
    )
    state = RecoveryState(tmp_path / "checkpoint.json")
    checkpoint = RecoveryCheckpoint(source="email", resume_after="a" * 64)
    state.save(checkpoint)
    assert state.load() == checkpoint
    assert json.loads(state.path.read_text(encoding="utf-8")) == {
        "resume_after": "a" * 64,
        "schema_version": 1,
        "source": "email",
    }
    state.clear()
    assert not state.path.exists()


def test_recovery_source_rejects_bridge_mutation_calls():
    source = Path("receipt_recovery_clients.py").read_text(encoding="utf-8")
    bridge_source = source.split("class OwlRecoveryClient", 1)[0]
    assert ".post(" not in bridge_source
    assert ".put(" not in bridge_source
    assert ".delete(" not in bridge_source
    assert "monarchmoney" not in source.lower()


@pytest.mark.anyio
async def test_restart_cursor_skips_completed_occurrence(tmp_path):
    first = receipt_model(receipt_id="receipt-first", attachment_id="attachment-first")
    second = receipt_model(
        receipt_id="receipt-second", attachment_id="attachment-second"
    )
    first_cursor = recovery_identity(
        namespace=NAMESPACE,
        receipt=first,
        attachment=first.attachments[0],
    ).source_occurrence_id
    looked_up = []

    class FakeBridge:
        async def list_receipts(self, source, offset):
            receipts = [first, second] if source == "upload" else []
            return SimpleNamespace(
                receipts=receipts,
                page=SimpleNamespace(has_more=False),
            )

        async def get_receipt(self, receipt_id):
            raise AssertionError("prior OWL result must skip detail")

    class FakeOwl:
        async def lookup(self, occurrence):
            looked_up.append(occurrence)
            return IntakeResult.model_validate(
                intake_payload(outcome="source_occurrence_reused")
            )

    state = MemoryState(RecoveryCheckpoint(source="upload", resume_after=first_cursor))
    result = await ReceiptRecoveryWorker(
        settings(tmp_path),
        FakeBridge(),  # type: ignore[arg-type]
        FakeOwl(),  # type: ignore[arg-type]
        state,  # type: ignore[arg-type]
    ).run()
    second_cursor = recovery_identity(
        namespace=NAMESPACE,
        receipt=second,
        attachment=second.attachments[0],
    ).source_occurrence_id
    assert looked_up == [second_cursor]
    assert result.counts == {"duplicate": 1}
    assert state.cleared


@pytest.mark.anyio
async def test_cursor_rescan_has_separate_budget_from_forward_progress(
    tmp_path,
):
    receipts = [
        receipt_model(
            receipt_id=f"receipt-{index}",
            attachment_id=f"attachment-{index}",
        )
        for index in range(5)
    ]

    class FakeBridge:
        async def list_receipts(self, source, offset):
            source_receipts = receipts if source == "upload" else []
            page_receipts = source_receipts[offset : offset + 2]
            return SimpleNamespace(
                receipts=page_receipts,
                page=SimpleNamespace(
                    has_more=offset + len(page_receipts) < len(source_receipts)
                ),
            )

        async def get_receipt(self, receipt_id):
            raise AssertionError("prior OWL result must skip detail")

    class FakeOwl:
        async def lookup(self, occurrence):
            return IntakeResult.model_validate(
                intake_payload(outcome="source_occurrence_reused")
            )

    configured = settings(tmp_path)
    configured = RecoverySettings(
        **{
            **configured.__dict__,
            "page_size": 2,
            "max_pages": 2,
            "max_items": 4,
        }
    )
    state = MemoryState()
    first = await ReceiptRecoveryWorker(
        configured,
        FakeBridge(),  # type: ignore[arg-type]
        FakeOwl(),  # type: ignore[arg-type]
        state,  # type: ignore[arg-type]
    ).run()
    assert first.result == "recovery_retryable"
    assert first.counts == {"duplicate": 4}
    assert (
        state.checkpoint.resume_after
        == recovery_identity(
            namespace=NAMESPACE,
            receipt=receipts[3],
            attachment=receipts[3].attachments[0],
        ).source_occurrence_id
    )

    second = await ReceiptRecoveryWorker(
        configured,
        FakeBridge(),  # type: ignore[arg-type]
        FakeOwl(),  # type: ignore[arg-type]
        state,  # type: ignore[arg-type]
    ).run()
    assert second.result == "recovery_complete"
    assert second.counts == {"duplicate": 1}
    assert state.cleared


@pytest.mark.anyio
@pytest.mark.parametrize("fail_submission", [False, True])
async def test_temporary_artifact_is_removed_on_success_and_failure(
    tmp_path, fail_submission
):
    receipt = receipt_model(
        receipt_id="receipt-cleanup", attachment_id="attachment-cleanup"
    )
    observed_path = None

    class FakeBridge:
        async def list_receipts(self, source, offset):
            receipts = [receipt] if source == "upload" else []
            return SimpleNamespace(
                receipts=receipts,
                page=SimpleNamespace(has_more=False),
            )

        async def get_receipt(self, receipt_id):
            return receipt

        async def download(self, receipt_id, attachment, destination):
            destination.write_bytes(b"\x89PNGdata")
            return hashlib.sha256(b"\x89PNGdata").hexdigest(), 8

    class FakeOwl:
        async def lookup(self, occurrence):
            return None

        async def submit(self, *, artifact, **kwargs):
            nonlocal observed_path
            observed_path = artifact
            assert artifact.read_bytes() == b"\x89PNGdata"
            if fail_submission:
                raise RecoveryContractError("invented private failure")
            return IntakeResult.model_validate(intake_payload())

    worker = ReceiptRecoveryWorker(
        settings(tmp_path),
        FakeBridge(),  # type: ignore[arg-type]
        FakeOwl(),  # type: ignore[arg-type]
        MemoryState(),  # type: ignore[arg-type]
    )
    if fail_submission:
        with pytest.raises(RecoveryContractError):
            await worker.run()
    else:
        assert (await worker.run()).result == "recovery_complete"
    assert observed_path is not None
    assert not observed_path.exists()
    assert not observed_path.parent.exists()


def test_temporary_and_checkpoint_paths_must_be_external(tmp_path):
    repository = tmp_path / "invented-repository"
    repository.mkdir()
    (repository / ".git").write_text("gitdir: invented", encoding="utf-8")
    with pytest.raises(ValueError):
        ensure_external_path(repository / "state" / "checkpoint.json")
    with pytest.raises(ValueError):
        RecoveryState(repository / "checkpoint.json")
