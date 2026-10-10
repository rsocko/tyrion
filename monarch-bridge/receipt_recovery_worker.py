"""Disabled-by-default one-shot Monarch-first receipt recovery."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from receipt_recovery_clients import (
    BridgeRecoveryClient,
    OwlRecoveryClient,
    RecoveryClientError,
    RecoveryContractError,
    RecoveryRetryableError,
    RecoveryUnknownOutcome,
)
from receipt_recovery_contract import (
    ALLOWED_MEDIA_TYPES,
    IntakeResult,
    Receipt,
    RecoveryIdentity,
    RecoverySettings,
    recovery_identity,
)
from receipt_recovery_state import (
    RecoveryBusyError,
    RecoveryCheckpoint,
    RecoveryState,
    ensure_external_path,
)

logger = logging.getLogger("receipt_recovery")
SOURCES = ("upload", "email")


@dataclass(frozen=True)
class RecoveryRunResult:
    result: str
    counts: dict[str, int]

    def output(self) -> str:
        return json.dumps(
            {"result": self.result, "counts": self.counts},
            sort_keys=True,
            separators=(",", ":"),
        )


class ReceiptRecoveryWorker:
    def __init__(
        self,
        settings: RecoverySettings,
        bridge: BridgeRecoveryClient,
        owl: OwlRecoveryClient,
        state: RecoveryState,
    ):
        self.settings = settings
        self.bridge = bridge
        self.owl = owl
        self.state = state
        self.counts: Counter[str] = Counter()

    async def run(self) -> RecoveryRunResult:
        checkpoint = self.state.load()
        source_index = SOURCES.index(checkpoint.source)
        processed = 0
        for source in SOURCES[source_index:]:
            resume_after = (
                checkpoint.resume_after if source == checkpoint.source else None
            )
            cursor_found = resume_after is None
            offset = 0
            rescan_pages = 0
            work_pages = 0
            page = None
            while work_pages < self.settings.max_pages:
                if not cursor_found and rescan_pages >= self.settings.max_pages:
                    # If a cursor disappears or the scan budget is reduced, clear
                    # it so the next run safely replays through OWL idempotency.
                    self.state.save(RecoveryCheckpoint(source=source))
                    return RecoveryRunResult("recovery_retryable", dict(self.counts))
                page = await self.bridge.list_receipts(source, offset)
                if cursor_found:
                    work_pages += 1
                else:
                    rescan_pages += 1
                if not page.receipts:
                    if page.page.has_more:
                        raise RecoveryContractError(
                            "bridge returned an empty non-terminal page"
                        )
                    break
                for listed in page.receipts:
                    identity = self._identity(listed)
                    if not cursor_found:
                        if identity.source_occurrence_id == resume_after:
                            cursor_found = True
                            work_pages = 0
                        continue
                    if processed >= self.settings.max_items:
                        return RecoveryRunResult(
                            "recovery_retryable", dict(self.counts)
                        )
                    terminal = await self._recover(listed, identity)
                    if not terminal:
                        return RecoveryRunResult(
                            "recovery_retryable", dict(self.counts)
                        )
                    processed += 1
                    self.state.save(
                        RecoveryCheckpoint(
                            source=source,
                            resume_after=identity.source_occurrence_id,
                        )
                    )
                if not page.page.has_more:
                    break
                next_offset = offset + len(page.receipts)
                if next_offset <= offset:
                    raise RecoveryContractError("bridge pagination made no progress")
                offset = next_offset
            if (
                page is not None
                and work_pages >= self.settings.max_pages
                and page.page.has_more
            ):
                return RecoveryRunResult("recovery_retryable", dict(self.counts))
            if not cursor_found:
                # The cursor disappeared. Replaying from the beginning is safe
                # because OWL owns occurrence idempotency.
                self.state.save(RecoveryCheckpoint(source=source))
                return RecoveryRunResult("recovery_retryable", dict(self.counts))
            if source != SOURCES[-1]:
                self.state.save(RecoveryCheckpoint(source=SOURCES[source_index + 1]))
                source_index += 1
        self.state.clear()
        return RecoveryRunResult("recovery_complete", dict(self.counts))

    def _identity(self, receipt: Receipt) -> RecoveryIdentity:
        if len(receipt.attachments) != 1:
            # A deterministic synthetic cursor is still required for terminal
            # unsupported cardinality. It never leaves this process.
            attachment = receipt.attachments[0] if receipt.attachments else None
            if attachment is None:
                from receipt_recovery_contract import ReceiptAttachment

                attachment = ReceiptAttachment(
                    id="missing",
                    mediaType=None,
                    sizeBytes=None,
                    downloadAvailable=False,
                )
        else:
            attachment = receipt.attachments[0]
        return recovery_identity(
            namespace=self.settings.identity_namespace,
            receipt=receipt,
            attachment=attachment,
        )

    async def _recover(self, listed: Receipt, identity: RecoveryIdentity) -> bool:
        prior = await self.owl.lookup(identity.source_occurrence_id)
        if prior is not None:
            prior_outcome = await self._reconcile_prior(prior)
            if prior_outcome == "terminal":
                return True
            if prior_outcome == "blocked":
                return False
        detail = await self.bridge.get_receipt(listed.id)
        if detail.id != listed.id or detail.source != listed.source:
            raise RecoveryContractError("bridge receipt detail is inconsistent")
        if len(detail.attachments) != 1:
            self.counts["failed"] += 1
            return True
        attachment = detail.attachments[0]
        detail_identity = recovery_identity(
            namespace=self.settings.identity_namespace,
            receipt=detail,
            attachment=attachment,
        )
        if detail_identity.source_occurrence_id != identity.source_occurrence_id:
            current = await self.owl.lookup(detail_identity.source_occurrence_id)
            if current is not None:
                current_outcome = await self._reconcile_prior(current)
                if current_outcome == "terminal":
                    return True
                if current_outcome == "blocked":
                    return False
        identity = detail_identity
        if not (
            attachment.download_available
            and attachment.media_type in ALLOWED_MEDIA_TYPES
            and attachment.size_bytes is not None
            and 0 < attachment.size_bytes <= self.settings.max_bytes
        ):
            self.counts["failed"] += 1
            return True
        with tempfile.TemporaryDirectory(
            prefix="tyrion-monarch-recovery-"
        ) as directory:
            artifact = Path(directory) / "artifact"
            ensure_external_path(artifact)
            digest, _ = await self.bridge.download(detail.id, attachment, artifact)
            result: IntakeResult
            try:
                result = await self.owl.submit(
                    artifact=artifact,
                    media_type=attachment.media_type,
                    identity=identity,
                    source_observed_at=detail.created_at,
                )
            except RecoveryUnknownOutcome:
                result = await self.owl.lookup(identity.source_occurrence_id)
                if result is None:
                    self.counts["unknown"] += 1
                    return False
            if result.attempt_state in {"unknown", "pending"}:
                result = await self.owl.reconcile(result.intake_ref)
            del digest
            return self._record_result(result)

    async def _reconcile_prior(self, result: IntakeResult) -> str:
        if result.attempt_state in {"unknown", "pending"}:
            result = await self.owl.reconcile(result.intake_ref)
        if result.attempt_state == "retryable" and result.retry_safe:
            return "continue"
        if result.attempt_state in {"unknown", "pending", "retryable"}:
            self.counts[
                "unknown"
                if result.attempt_state in {"unknown", "pending"}
                else "retryable"
            ] += 1
            return "blocked"
        self._record_result(result)
        return "terminal"

    def _record_result(self, result: IntakeResult) -> bool:
        if result.attempt_state == "accepted":
            key = (
                "duplicate"
                if result.outcome
                in {
                    "source_occurrence_reused",
                    "exact_hash_reused",
                    "paperless_duplicate",
                }
                else "accepted"
            )
            self.counts[key] += 1
            return True
        if result.attempt_state in {"failed", "review_required"}:
            self.counts["failed"] += 1
            return True
        if result.attempt_state in {"unknown", "pending"}:
            self.counts["unknown"] += 1
        else:
            self.counts["retryable"] += 1
        return False


async def run_once(settings: RecoverySettings) -> RecoveryRunResult:
    if not settings.enabled:
        return RecoveryRunResult("recovery_disabled", {})
    state = RecoveryState(settings.state_file)
    bridge = BridgeRecoveryClient(settings)
    owl = OwlRecoveryClient(settings)
    try:
        state.acquire()
        return await ReceiptRecoveryWorker(settings, bridge, owl, state).run()
    finally:
        state.release()
        await bridge.close()
        await owl.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one bounded Monarch-first receipt recovery cycle"
    )
    parser.add_argument("--run-once", action="store_true", required=True)
    parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    try:
        result = asyncio.run(run_once(RecoverySettings.from_env()))
    except RecoveryBusyError:
        result = RecoveryRunResult("recovery_busy", {})
    except RecoveryRetryableError:
        result = RecoveryRunResult("recovery_retryable", {})
    except (RecoveryClientError, ValueError, OSError):
        result = RecoveryRunResult("recovery_failed", {})
    print(result.output())
    return 0 if result.result in {"recovery_complete", "recovery_disabled"} else 1


if __name__ == "__main__":
    sys.exit(main())
