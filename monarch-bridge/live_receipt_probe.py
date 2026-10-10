"""Opt-in controlled-live receipt probe.

This script emits only one stable result code. It must never print upstream values,
identifiers, URLs, filenames, response bodies, exception text, or session paths.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path


ENABLE_VALUE = "1"
MUTATION_CONFIRMATION = "I_ACCEPT_RECEIPT_PROBE_MUTATIONS"
SUCCESS_CODE = "receipt_probe_ok"
_INVENTED_PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR"
    b"\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff"
    b"\x89\x99=\x1d"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


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
            path.write_bytes(_INVENTED_PNG)
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
