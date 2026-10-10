"""Opt-in controlled-live receipt and transaction-attachment matrix.

Output is one JSON object containing stable result and classification fields only.
Never emit upstream values, identifiers, URLs, filenames, response bodies, exception
text, or session paths.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
import tempfile
import zlib
from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4


ENABLE_VALUE = "1"
MUTATION_CONFIRMATION = "I_ACCEPT_RECEIPT_ATTACHMENT_PROBE_MUTATIONS"
SUCCESS_CODE = "receipt_attachment_matrix_ok"
_GLYPHS = {
    " ": (0, 0, 0, 0, 0, 0, 0),
    "-": (0, 0, 0, 31, 0, 0, 0),
    ".": (0, 0, 0, 0, 0, 12, 12),
    "0": (14, 17, 19, 21, 25, 17, 14),
    "1": (4, 12, 4, 4, 4, 4, 14),
    "2": (14, 17, 1, 2, 4, 8, 31),
    "3": (30, 1, 1, 14, 1, 1, 30),
    "4": (2, 6, 10, 18, 31, 2, 2),
    "5": (31, 16, 16, 30, 1, 1, 30),
    "6": (14, 16, 16, 30, 17, 17, 14),
    "7": (31, 1, 2, 4, 8, 8, 8),
    "8": (14, 17, 17, 14, 17, 17, 14),
    "9": (14, 17, 17, 15, 1, 1, 14),
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
    "TYRION TEST RECEIPT",
    "DATE 2026-10-10",
    "ITEM 1.00",
    "TOTAL 1.00",
)


def _invented_receipt_png() -> bytes:
    scale = 4
    margin = 24
    line_gap = 12
    glyph_width = 5
    glyph_height = 7
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
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, level=9))
        + _png_chunk(b"IEND", b"")
    )


def _invented_receipt_pdf() -> bytes:
    stream = (
        b"BT /F1 14 Tf 30 140 Td (TYRION TEST RECEIPT) Tj "
        b"0 -24 Td (TOTAL 1.00) Tj ET"
    )
    objects = (
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode()
        + stream
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    )
    content = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(content))
        content.extend(f"{index} 0 obj\n".encode())
        content.extend(obj)
        content.extend(b"\nendobj\n")
    xref = len(content)
    content.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    content.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        content.extend(f"{offset:010d} 00000 n \n".encode())
    content.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(content)


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return (
        struct.pack(">I", len(data))
        + payload
        + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
    )


def _quiet_transport_logging() -> None:
    for logger_name in ("httpx", "httpcore", "gql", "graphql"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)


def _base_summary(code: str) -> dict[str, str]:
    return {
        "result": code,
        "manual_match": "not_run",
        "transaction_attachment": "not_run",
        "receipt_png": "not_run",
        "receipt_pdf": "not_run",
        "duplicate_upload": "not_run",
        "failed_receipt_delete": "not_run",
        "asset_immediate": "not_run",
        "asset_delayed": "not_run",
        "email_ingestion": "skipped_no_configuration",
        "pending_identity": "skipped_no_pending_transaction",
    }


def _classify_fidelity(expected: bytes, actual: bytes) -> str:
    return "identical" if actual == expected else "transformed"


def _classify_duplicate(first_id: str, second_id: str | None) -> str:
    if second_id is None:
        return "rejected"
    return "coalesced" if first_id == second_id else "distinct"


async def run() -> dict[str, str]:
    if os.getenv("TYRION_LIVE_RECEIPT_TESTS") != ENABLE_VALUE:
        return _base_summary("receipt_attachment_matrix_disabled")
    if os.getenv("TYRION_LIVE_RECEIPT_MUTATION_CONFIRM") != MUTATION_CONFIRMATION:
        return _base_summary("receipt_attachment_mutation_confirmation_required")
    if not os.getenv("SESSION_FILE"):
        return _base_summary("receipt_attachment_session_path_required")
    os.environ["BRIDGE_LOAD_DOTENV"] = "false"
    os.environ["DEMO_MODE"] = "false"
    _quiet_transport_logging()
    try:
        from main import get_client

        return await run_matrix(await get_client())
    except Exception:
        return _base_summary("receipt_attachment_matrix_internal_error")


async def run_matrix(
    client: object,
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, str]:
    from receipt_probe import (
        ReceiptProbeError,
        TransactionAttachmentSnapshot,
        attachments_match,
        create_receipt,
        delete_receipt,
        delete_transaction_attachment,
        discover_matched_pdf_candidate,
        download_attachment,
        get_receipt,
        get_transaction_attachment,
        list_transaction_attachments,
        match_receipt,
        poll_receipt,
        start_receipt,
        unmatch_receipt,
        upload_receipt_file,
        upload_transaction_attachment,
    )

    summary = _base_summary(SUCCESS_CODE)
    synthetic_receipt_ids: list[str] = []
    synthetic_attachment_id: str | None = None
    candidate = None
    original_transaction_id: str | None = None
    manual_restore_required = False
    cleanup_failed = False
    primary_error: str | None = None

    async def create_synthetic(name: str, content: bytes):
        created = await create_receipt(client)
        synthetic_receipt_ids.append(created.id)
        with tempfile.TemporaryDirectory(prefix="tyrion-receipt-matrix-") as directory:
            path = Path(directory) / name
            path.write_bytes(content)
            await upload_receipt_file(client, created.id, path)
        await start_receipt(client, created.id)
        return await poll_receipt(client, created.id)

    async def fidelity(receipt, expected: bytes) -> str:
        if not receipt.attachments:
            return "missing"
        downloaded = await download_attachment(receipt.attachments[0])
        return _classify_fidelity(expected, downloaded)

    try:
        candidate = await discover_matched_pdf_candidate(client)
        original_transaction_id = candidate.linked_transaction_id
        if original_transaction_id is None:
            raise ReceiptProbeError("receipt_candidate_not_found")

        manual_restore_required = True
        await unmatch_receipt(client, candidate)
        unmatched = await get_receipt(client, candidate.id)
        if unmatched is None or unmatched.linked_transaction_id is not None:
            raise ReceiptProbeError("manual_receipt_unmatch_verification_failed")
        await match_receipt(client, candidate, original_transaction_id)
        restored = await get_receipt(client, candidate.id)
        if restored is None or restored.linked_transaction_id != original_transaction_id:
            raise ReceiptProbeError("manual_receipt_rematch_verification_failed")
        manual_restore_required = False
        summary["manual_match"] = "restored"

        before = await list_transaction_attachments(client, original_transaction_id)
        attachment_content = _invented_receipt_png()
        attachment_filename = f"tyrion-invented-{uuid4().hex}.png"
        try:
            uploaded = await upload_transaction_attachment(
                client,
                original_transaction_id,
                filename=attachment_filename,
                content_type="image/png",
                content=attachment_content,
            )
        except ReceiptProbeError:
            ambiguous = await list_transaction_attachments(
                client, original_transaction_id
            )
            candidates = _new_synthetic_attachment_candidates(
                before,
                ambiguous,
                expected_filename=Path(attachment_filename).stem,
                expected_extension="png",
                expected_size=len(attachment_content),
            )
            if len(candidates) == 1:
                synthetic_attachment_id = candidates[0].id
            raise
        synthetic_attachment_id = uploaded.id
        if any(item.id == uploaded.id for item in before.attachments):
            collision_snapshot = await list_transaction_attachments(
                client, original_transaction_id
            )
            candidates = _new_synthetic_attachment_candidates(
                before,
                collision_snapshot,
                expected_filename=Path(attachment_filename).stem,
                expected_extension="png",
                expected_size=len(attachment_content),
            )
            synthetic_attachment_id = None
            if len(candidates) == 1:
                synthetic_attachment_id = candidates[0].id
            raise ReceiptProbeError("transaction_attachment_identity_collision")
        during = await list_transaction_attachments(client, original_transaction_id)
        synthetic_matches = [
            item for item in during.attachments if item.id == uploaded.id
        ]
        remaining = TransactionAttachmentSnapshot(
            during.transaction_id,
            tuple(item for item in during.attachments if item.id != uploaded.id),
        )
        if (
            len(synthetic_matches) != 1
            or synthetic_matches[0] != uploaded
            or not attachments_match(before, remaining)
        ):
            raise ReceiptProbeError("transaction_attachment_drift")
        fetched_attachment = await get_transaction_attachment(client, uploaded.id)
        if fetched_attachment is None:
            raise ReceiptProbeError("transaction_attachment_readback_missing")
        first = await download_attachment(fetched_attachment)
        summary["transaction_attachment"] = _classify_fidelity(
            attachment_content, first
        )
        summary["asset_immediate"] = await _classify_asset_reuse(
            fetched_attachment,
            first,
            download_attachment,
        )
        await sleep(2.0)
        summary["asset_delayed"] = await _classify_asset_reuse(
            fetched_attachment,
            first,
            download_attachment,
        )
        if not await delete_transaction_attachment(client, uploaded.id):
            raise ReceiptProbeError("transaction_attachment_delete_failed")
        if await get_transaction_attachment(client, uploaded.id) is not None:
            raise ReceiptProbeError("transaction_attachment_delete_readback_failed")
        synthetic_attachment_id = None
        after = await list_transaction_attachments(client, original_transaction_id)
        if not attachments_match(before, after):
            raise ReceiptProbeError("transaction_attachment_drift")

        png = _invented_receipt_png()
        png_receipt = await create_synthetic("invented-receipt.png", png)
        if png_receipt.status == "failed":
            raise ReceiptProbeError("receipt_png_rejected")
        summary["receipt_png"] = await fidelity(png_receipt, png)

        pdf = _invented_receipt_pdf()
        pdf_receipt = await create_synthetic("invented-receipt.pdf", pdf)
        if pdf_receipt.status == "failed":
            raise ReceiptProbeError("receipt_pdf_rejected")
        summary["receipt_pdf"] = await fidelity(pdf_receipt, pdf)

        duplicate_one = await create_synthetic("duplicate-one.png", png)
        try:
            duplicate_two = await create_synthetic("duplicate-two.png", png)
        except ReceiptProbeError as exc:
            if exc.code != "upstream_mutation_rejected":
                raise
            summary["duplicate_upload"] = _classify_duplicate(
                duplicate_one.id, None
            )
        else:
            summary["duplicate_upload"] = (
                "rejected"
                if duplicate_two.status == "failed"
                else _classify_duplicate(duplicate_one.id, duplicate_two.id)
            )

        failed = await create_synthetic(
            "invented-non-receipt.txt",
            b"This invented file is intentionally not a receipt.\n",
        )
        summary["failed_receipt_delete"] = (
            "deletable" if failed.status == "failed" else "not_failed"
        )
    except ReceiptProbeError as exc:
        primary_error = exc.code
    except Exception:
        primary_error = "receipt_attachment_matrix_internal_error"
    finally:
        if manual_restore_required and candidate is not None and original_transaction_id:
            try:
                await match_receipt(client, candidate, original_transaction_id)
                restored = await get_receipt(client, candidate.id)
                if (
                    restored is None
                    or restored.linked_transaction_id != original_transaction_id
                ):
                    cleanup_failed = True
            except Exception:
                cleanup_failed = True
        if synthetic_attachment_id is not None:
            try:
                if not await delete_transaction_attachment(
                    client, synthetic_attachment_id
                ):
                    cleanup_failed = True
            except Exception:
                cleanup_failed = True
        if not await _delete_synthetic_receipts(
            client,
            synthetic_receipt_ids,
            delete_receipt,
            get_receipt,
        ):
            cleanup_failed = True
        if original_transaction_id is not None and "before" in locals():
            try:
                current = await list_transaction_attachments(
                    client, original_transaction_id
                )
                if not attachments_match(before, current):
                    cleanup_failed = True
            except Exception:
                cleanup_failed = True

    if cleanup_failed:
        summary["result"] = "receipt_attachment_cleanup_failed"
    elif primary_error is not None:
        summary["result"] = primary_error
    return summary


def _new_synthetic_attachment_candidates(
    before,
    after,
    *,
    expected_filename,
    expected_extension,
    expected_size,
):
    original_ids = {item.id for item in before.attachments}
    return tuple(
        item
        for item in after.attachments
        if (
            item.id not in original_ids
            and item.filename == expected_filename
            and item.extension == expected_extension
            and item.size_bytes == expected_size
        )
    )


async def _delete_synthetic_receipts(
    client,
    receipt_ids,
    delete_receipt,
    get_receipt,
) -> bool:
    succeeded = True
    for receipt_id in dict.fromkeys(receipt_ids):
        try:
            if (
                not await delete_receipt(client, receipt_id)
                or await get_receipt(client, receipt_id) is not None
            ):
                succeeded = False
        except Exception:
            succeeded = False
    return succeeded


async def _classify_asset_reuse(attachment, expected, downloader) -> str:
    from receipt_probe import ReceiptProbeError

    try:
        content = await downloader(attachment)
    except ReceiptProbeError as exc:
        if exc.code == "attachment_auth_rejected":
            return "auth_rejected"
        return "unavailable"
    return "reusable_identical" if content == expected else "reusable_changed"


def main() -> int:
    result = asyncio.run(run())
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result["result"] == SUCCESS_CODE else 1


if __name__ == "__main__":
    raise SystemExit(main())
