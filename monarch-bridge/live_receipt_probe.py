"""Opt-in controlled-live receipt probe.

This script emits only one stable result code. It must never print upstream values,
identifiers, URLs, filenames, response bodies, exception text, or session paths.
"""

from __future__ import annotations

import asyncio
import logging
import os
import struct
import tempfile
import zlib
from pathlib import Path


ENABLE_VALUE = "1"
MUTATION_CONFIRMATION = "I_ACCEPT_RECEIPT_PROBE_MUTATIONS"
SUCCESS_CODE = "receipt_probe_ok"
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


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return (
        struct.pack(">I", len(data))
        + payload
        + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
    )


def _quiet_transport_logging() -> None:
    for logger_name in ("httpx", "httpcore"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)


async def run() -> str:
    if os.getenv("TYRION_LIVE_RECEIPT_TESTS") != ENABLE_VALUE:
        return "receipt_probe_disabled"
    if (
        os.getenv("TYRION_LIVE_RECEIPT_MUTATION_CONFIRM")
        != MUTATION_CONFIRMATION
    ):
        return "receipt_probe_mutation_confirmation_required"
    if not os.getenv("SESSION_FILE"):
        return "receipt_probe_session_path_required"

    os.environ["BRIDGE_LOAD_DOTENV"] = "false"
    os.environ["DEMO_MODE"] = "false"

    from main import get_client
    _quiet_transport_logging()
    from receipt_probe import (
        ReceiptProbeError,
        create_receipt,
        delete_receipt,
        download_attachment,
        find_receipt,
        get_receipt,
        match_receipt,
        poll_receipt,
        start_receipt,
        unmatch_receipt,
        upload_receipt_file,
    )

    created = None
    match_attempted = False
    cleanup_failed = False
    try:
        client = await get_client()
        created = await create_receipt(client)
        with tempfile.TemporaryDirectory(prefix="tyrion-receipt-probe-") as directory:
            path = Path(directory) / "invented-receipt.png"
            path.write_bytes(_invented_receipt_png())
            await upload_receipt_file(client, created.id, path)
        await start_receipt(client, created.id)
        completed = await poll_receipt(client, created.id)
        if completed.status == "failed":
            return "receipt_probe_processing_failed"
        correlated = await find_receipt(
            client,
            completed.id,
            source="upload",
        )
        if correlated is None:
            return "receipt_probe_list_correlation_failed"
        fetched = await poll_receipt(
            client,
            correlated.id,
            attempts=1,
            timeout_seconds=1,
        )
        if fetched.id != completed.id:
            return "receipt_probe_get_correlation_failed"
        if not fetched.attachments:
            return "receipt_probe_attachment_missing"
        await download_attachment(fetched.attachments[0])

        transaction_id = os.getenv("TYRION_TEST_RECEIPT_TRANSACTION_ID")
        if transaction_id:
            match_attempted = True
            await match_receipt(client, fetched, transaction_id)
            matched = await get_receipt(client, fetched.id)
            if matched is None or matched.linked_transaction_id != transaction_id:
                return "receipt_probe_match_verification_failed"
            await unmatch_receipt(client, fetched)
            restored = await get_receipt(client, fetched.id)
            if restored is None or restored.linked_transaction_id is not None:
                return "receipt_probe_match_restoration_failed"
            match_attempted = False
        return SUCCESS_CODE
    except ReceiptProbeError as exc:
        return exc.code
    except Exception:
        return "receipt_probe_internal_error"
    finally:
        if created is not None:
            client = None
            try:
                client = await get_client()
                if match_attempted:
                    await unmatch_receipt(client, created)
            except Exception:
                cleanup_failed = True
            try:
                if client is None:
                    client = await get_client()
                if not await delete_receipt(client, created.id):
                    cleanup_failed = True
                elif await get_receipt(client, created.id) is not None:
                    cleanup_failed = True
            except Exception:
                cleanup_failed = True
        if cleanup_failed:
            os.environ["TYRION_RECEIPT_PROBE_CLEANUP_STATUS"] = "failed"


def main() -> int:
    result = asyncio.run(run())
    if os.getenv("TYRION_RECEIPT_PROBE_CLEANUP_STATUS") == "failed":
        result = "receipt_probe_cleanup_failed"
    print(result)
    return 0 if result == SUCCESS_CODE else 1


if __name__ == "__main__":
    raise SystemExit(main())
