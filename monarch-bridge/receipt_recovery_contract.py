"""Strict contracts for the Monarch-first recovery worker."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

CONTRACT_VERSION = "1.0"
SOURCE_OCCURRENCE_VERSION = "1"
TRANSFORM_VERSION = "identity-v1"
ALLOWED_MEDIA_TYPES = frozenset({"application/pdf", "image/jpeg", "image/png"})
TERMINAL_ACCEPTED_STATES = frozenset({"accepted"})
INTAKE_OUTCOMES = frozenset(
    {
        "new_canonical",
        "source_occurrence_reused",
        "exact_hash_reused",
        "normalized_content_review",
        "semantic_review_candidate",
        "paperless_duplicate",
        "upload_outcome_unknown",
        "upload_retryable",
        "upload_failed",
    }
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ReceiptAttachment(StrictModel):
    id: str = Field(min_length=1, max_length=512)
    media_type: Literal["image/jpeg", "image/png", "application/pdf"] | None = Field(
        alias="mediaType"
    )
    size_bytes: int | None = Field(alias="sizeBytes", ge=0)
    download_available: bool = Field(alias="downloadAvailable")


class Receipt(StrictModel):
    id: str = Field(min_length=1, max_length=512)
    source: Literal["upload", "email"]
    status: Literal["processing", "awaiting_match", "matched", "failed"]
    created_at: datetime | None = Field(alias="createdAt")
    linked_transaction_id: str | None = Field(
        alias="linkedTransactionId", min_length=1, max_length=512
    )
    attachments: list[ReceiptAttachment] = Field(max_length=8)


class ReceiptPage(StrictModel):
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    total: int = Field(ge=0)
    has_more: bool = Field(alias="hasMore")


class Provenance(StrictModel):
    provider: Literal["live", "demo"]
    fetched_at: datetime = Field(alias="fetchedAt")


class ReceiptsResponse(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    provenance: Provenance
    receipts: list[Receipt] = Field(max_length=100)
    page: ReceiptPage


class ReceiptResponse(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    provenance: Provenance
    receipt: Receipt


class IntakeResult(StrictModel):
    schema_version: Literal["1.0"]
    intake_ref: str = Field(min_length=8, max_length=200)
    outcome: str
    attempt_state: Literal[
        "pending", "accepted", "unknown", "retryable", "failed", "review_required"
    ]
    canonical_document_ref: str | None = Field(
        default=None, min_length=8, max_length=200
    )
    review_ref: str | None = Field(default=None, min_length=8, max_length=200)
    reason_codes: list[str] = Field(max_length=8)
    source_channel: Literal["monarch_recovery"]
    source_occurrence_version: Literal["1"]
    source_as_of: datetime | None
    retry_safe: bool
    external_replica_eligible: Literal[False]

    @field_validator("outcome")
    @classmethod
    def outcome_is_known(cls, value: str) -> str:
        if value not in INTAKE_OUTCOMES:
            raise ValueError("unknown intake outcome")
        return value


@dataclass(frozen=True)
class RecoveryIdentity:
    source_occurrence_id: str
    external_replica_ref: str
    receipt_version: str


@dataclass(frozen=True)
class RecoverySettings:
    enabled: bool
    bridge_url: str
    bridge_token: str
    owl_url: str
    owl_token: str
    identity_namespace: bytes
    state_file: Path
    page_size: int
    max_pages: int
    max_items: int
    max_bytes: int
    request_timeout_seconds: float

    @classmethod
    def from_env(
        cls, environment: dict[str, str] | os._Environ[str] = os.environ
    ) -> RecoverySettings:
        enabled = environment.get("TYRION_MONARCH_RECOVERY_ENABLED") == "true"
        if not enabled:
            return cls(
                enabled=False,
                bridge_url="",
                bridge_token="",
                owl_url="",
                owl_token="",
                identity_namespace=b"",
                state_file=Path("."),
                page_size=25,
                max_pages=20,
                max_items=500,
                max_bytes=2 * 1024 * 1024,
                request_timeout_seconds=45.0,
            )
        bridge_token = _required_secret(environment, "BRIDGE_API_TOKEN")
        owl_token = _required_secret(environment, "OWL_RECEIPT_INTAKE_API_TOKEN")
        namespace = _required_secret(
            environment, "TYRION_RECEIPT_IDENTITY_NAMESPACE"
        ).encode()
        state_file = Path(
            environment.get(
                "TYRION_MONARCH_RECOVERY_STATE_FILE",
                "/var/lib/tyrion-recovery/checkpoint.json",
            )
        ).expanduser()
        if not state_file.is_absolute():
            raise ValueError("recovery state path must be absolute")
        return cls(
            enabled=True,
            bridge_url=_service_url(environment.get("BRIDGE_URL", "")),
            bridge_token=bridge_token,
            owl_url=_service_url(environment.get("OWL_RECEIPT_INTAKE_URL", "")),
            owl_token=owl_token,
            identity_namespace=namespace,
            state_file=state_file.resolve(),
            page_size=_bounded_int(
                environment, "TYRION_MONARCH_RECOVERY_PAGE_SIZE", 25, 1, 100
            ),
            max_pages=_bounded_int(
                environment, "TYRION_MONARCH_RECOVERY_MAX_PAGES", 20, 1, 100
            ),
            max_items=_bounded_int(
                environment, "TYRION_MONARCH_RECOVERY_MAX_ITEMS", 500, 1, 5000
            ),
            max_bytes=_bounded_int(
                environment,
                "TYRION_MONARCH_RECOVERY_MAX_BYTES",
                2 * 1024 * 1024,
                1024,
                2 * 1024 * 1024,
            ),
            request_timeout_seconds=float(
                _bounded_int(
                    environment,
                    "TYRION_MONARCH_RECOVERY_TIMEOUT_SECONDS",
                    45,
                    5,
                    120,
                )
            ),
        )


def recovery_identity(
    *,
    namespace: bytes,
    receipt: Receipt,
    attachment: ReceiptAttachment,
) -> RecoveryIdentity:
    replica_ref = opaque_reference(
        "receipt", namespace, f"{receipt.id}\0{attachment.id}"
    )
    version_payload = {
        "attachment_ref": opaque_reference("attachment", namespace, attachment.id),
        "attachment_count": len(receipt.attachments),
        "created_at": (receipt.created_at.isoformat() if receipt.created_at else None),
        "media_type": attachment.media_type,
        "size_bytes": attachment.size_bytes,
    }
    encoded_version = json.dumps(
        version_payload, sort_keys=True, separators=(",", ":")
    ).encode()
    receipt_version = f"metadata-v1-{hashlib.sha256(encoded_version).hexdigest()[:16]}"
    occurrence_payload = {
        "version": 1,
        "channel": "monarch_recovery",
        "parts": {
            "connector_ref": connector_reference(namespace),
            "receipt_ref": replica_ref,
            "receipt_version": receipt_version,
        },
    }
    occurrence = hashlib.sha256(
        json.dumps(occurrence_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return RecoveryIdentity(occurrence, replica_ref, receipt_version)


def connector_reference(namespace: bytes) -> str:
    return opaque_reference("connector", namespace, "monarch")


def opaque_reference(kind: str, namespace: bytes, raw_reference: str) -> str:
    digest = hashlib.sha256(
        namespace + b"\0" + kind.encode() + b"\0" + raw_reference.encode()
    ).digest()
    encoded = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return f"{kind}-v1_{encoded}"


def _required_secret(environment: dict[str, str] | os._Environ[str], name: str) -> str:
    value = environment.get(name, "")
    if len(value) < 32:
        raise ValueError(f"{name} is not configured")
    return value


def _service_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("service URL is invalid")
    return value.rstrip("/") + "/"


def _bounded_int(
    environment: dict[str, str] | os._Environ[str],
    name: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    try:
        value = int(environment.get(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"{name} is invalid") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} is out of range")
    return value
