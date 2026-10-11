import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  idempotencyKeySchema,
  sourceReferenceSchema,
} from "@rsocko/tyrion-finance-insights";
import {
  parseReceiptBrokerResponseV1,
  parseReceiptIntakeResultV1,
  type ReceiptBrokerOutcomeV1,
  type ReceiptBrokerResponseV1,
  type ReceiptOrchestrationRecordV1,
  ReceiptOrchestrationConflictV1,
} from "@rsocko/tyrion-finance-insights/receipt";
import { ReceiptEvidenceHttpError } from "@/lib/receipt-evidence-auth";
import {
  MONARCH_RECEIPT_MAX_BYTES,
  ReceiptBridgeAdapter,
} from "@/lib/receipt-bridge-adapter";
import { spoolReceiptArtifact } from "@/lib/receipt-evidence-service";
import { getReceiptEvidenceRuntime } from "@/lib/receipt-evidence-runtime";

const BROKER_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const locks = new Map<string, Promise<void>>();

export interface ReceiptBrokerResult {
  status: 200 | 201 | 202;
  body: ReceiptBrokerResponseV1;
}

export async function submitReceiptBroker(
  request: Request
): Promise<ReceiptBrokerResult> {
  const runtime = getReceiptEvidenceRuntime();
  if (!runtime.gates.write) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_replica_write_disabled",
      "Receipt replica writes are disabled"
    );
  }
  const metadata = parseMetadata(request.headers);
  return withLock(metadata.idempotencyKey, async () => {
    const artifact = await spoolReceiptArtifact(request, {
      allowedMediaTypes: BROKER_MEDIA_TYPES,
      maximumBytes: MONARCH_RECEIPT_MAX_BYTES,
    });
    try {
      const occurrenceId = occurrenceIdFor(metadata.idempotencyKey);
      const bridge = ReceiptBridgeAdapter.fromEnvironment(
        runtime.identityNamespace
      );
      const intake = parseReceiptIntakeResultV1({
        schema_version: "1.0",
        intake_ref: metadata.idempotencyKey,
        outcome: "new_canonical",
        attempt_state: "accepted",
        canonical_document_ref: metadata.canonicalDocumentRef,
        review_ref: metadata.sourceRef,
        reason_codes: [],
        source_channel: "provider_api",
        source_occurrence_version: "1",
        source_as_of: null,
        retry_safe: false,
        external_replica_eligible: true,
      });
      const reservation = runtime.store.reserveBrokerCreate(
        occurrenceId,
        artifact.sha256,
        intake,
        now(),
        metadata.expectedRevision
      );
      let record = reservation.record;
      if (!reservation.claimed) {
        return {
          status: 200,
          body: response(record, "duplicate"),
        };
      }
      let created;
      try {
        created = await bridge.create();
      } catch {
        record = runtime.store.updateReplica(
          occurrenceId,
          record.revision,
          {
            lifecycle: "review",
            reasonCodes: ["monarch_create_outcome_unknown"],
          },
          now()
        );
        return { status: 202, body: response(record, "unknown") };
      }
      record = runtime.store.updateReplica(
        occurrenceId,
        record.revision,
        {
          replicaRef: bridge.publicReference(created.id),
          rawReceiptId: created.id,
          lifecycle: "review",
          reasonCodes: ["monarch_upload_reserved"],
        },
        now()
      );
      try {
        const normalized = bridge.evidence(
          await bridge.upload(created.id, artifact.path, artifact.mediaType),
          now()
        );
        record = runtime.store.updateReplica(
          occurrenceId,
          record.revision,
          {
            lifecycle: normalized.lifecycle,
            nativeEvidence: normalized.evidence,
            reasonCodes: [],
          },
          now()
        );
        const outcome =
          record.replicaLifecycle === "processing"
            ? "processing"
            : "acknowledged";
        return {
          status: outcome === "acknowledged" ? 201 : 202,
          body: response(record, outcome),
        };
      } catch {
        record = runtime.store.updateReplica(
          occurrenceId,
          record.revision,
          {
            lifecycle: "review",
            reasonCodes: ["monarch_upload_outcome_unknown"],
          },
          now()
        );
        return { status: 202, body: response(record, "unknown") };
      }
    } catch (error) {
      if (error instanceof ReceiptOrchestrationConflictV1) {
        throw conflict();
      }
      throw error;
    } finally {
      await rm(artifact.directory, { recursive: true, force: true });
    }
  });
}

export async function reconcileReceiptBroker(
  idempotencyKeyValue: string,
  headers: Headers
): Promise<ReceiptBrokerResult> {
  const runtime = getReceiptEvidenceRuntime();
  if (!runtime.gates.read || !runtime.gates.recovery) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_broker_reconcile_disabled",
      "Receipt broker reconciliation is disabled"
    );
  }
  const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
  const expectedRevision = parseExpectedRevision(headers, false);
  return withLock(idempotencyKey, async () => {
    let record = runtime.store.getByOccurrence(
      occurrenceIdFor(idempotencyKey)
    );
    if (!record) {
      throw new ReceiptEvidenceHttpError(
        404,
        "receipt_broker_not_found",
        "Receipt broker operation was not found"
      );
    }
    validateExpectedRevision(expectedRevision, record.revision, false);
    if (!record.rawReceiptId) {
      return { status: 202, body: response(record, "unknown") };
    }
    const bridge = ReceiptBridgeAdapter.fromEnvironment(
      runtime.identityNamespace
    );
    let observed;
    try {
      observed = await bridge.get(record.rawReceiptId);
    } catch {
      return {
        status: 202,
        body: response(record, "retryable", [
          "monarch_status_temporarily_unavailable",
        ]),
      };
    }
    const normalized = bridge.evidence(observed, now());
    try {
      record = runtime.store.updateReplica(
        record.sourceOccurrenceId,
        record.revision,
        {
          lifecycle: normalized.lifecycle,
          nativeEvidence: normalized.evidence,
          reasonCodes: [],
        },
        now()
      );
    } catch (error) {
      if (error instanceof ReceiptOrchestrationConflictV1) throw conflict();
      throw error;
    }
    const outcome =
      record.replicaLifecycle === "processing"
        ? "processing"
        : "acknowledged";
    return {
      status: outcome === "acknowledged" ? 200 : 202,
      body: response(record, outcome),
    };
  });
}

function parseMetadata(headers: Headers): {
  idempotencyKey: string;
  canonicalDocumentRef: string;
  sourceRef: string;
  expectedRevision: number | undefined;
} {
  return {
    idempotencyKey: parseIdempotencyKey(headers.get("idempotency-key")),
    canonicalDocumentRef: parseReference(
      headers.get("x-owl-canonical-document-ref")
    ),
    sourceRef: parseReference(headers.get("x-owl-source-ref")),
    expectedRevision: parseExpectedRevision(headers, false),
  };
}

function parseIdempotencyKey(value: string | null): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new ReceiptEvidenceHttpError(
      422,
      "invalid_idempotency_key",
      "Idempotency key is invalid"
    );
  }
  return parsed.data;
}

function parseReference(value: string | null): string {
  const parsed = sourceReferenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReceiptEvidenceHttpError(
      422,
      "invalid_receipt_metadata",
      "Receipt broker metadata is invalid"
    );
  }
  return parsed.data;
}

function parseExpectedRevision(
  headers: Headers,
  required: boolean
): number | undefined {
  const value = headers.get("x-tyrion-expected-revision");
  if (value === null && !required) return undefined;
  if (value === null || !/^(0|[1-9]\d{0,9})$/.test(value)) {
    throw new ReceiptEvidenceHttpError(
      422,
      "invalid_expected_revision",
      "Expected revision is invalid"
    );
  }
  return Number(value);
}

function validateExpectedRevision(
  expected: number | undefined,
  actual: number,
  required: boolean
): void {
  if (
    (required && expected === undefined) ||
    (expected !== undefined && expected !== actual)
  ) {
    throw conflict();
  }
}

function response(
  record: ReceiptOrchestrationRecordV1,
  outcome: ReceiptBrokerOutcomeV1,
  additionalReasons: readonly string[] = []
): ReceiptBrokerResponseV1 {
  const acknowledged = record.nativeEvidence !== null;
  return parseReceiptBrokerResponseV1({
    brokerContractVersion: "1.0",
    idempotencyKey: record.intake.intake_ref,
    outcome,
    acknowledged,
    retrySafe: outcome === "retryable",
    reconcileRequired:
      outcome === "unknown" ||
      outcome === "retryable" ||
      outcome === "processing" ||
      record.replicaLifecycle === "review" ||
      record.replicaLifecycle === "processing",
    replicaRef: record.replicaRef,
    replicaLifecycle: record.replicaLifecycle,
    revision: record.revision,
    nativeEvidence: record.nativeEvidence,
    reasonCodes: [
      ...new Set([...record.reasonCodes, ...additionalReasons]),
    ].slice(0, 12),
  });
}

function occurrenceIdFor(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}

function conflict(): ReceiptEvidenceHttpError {
  return new ReceiptEvidenceHttpError(
    409,
    "receipt_broker_conflict",
    "Receipt broker state conflicts with the request"
  );
}

async function withLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => current);
  locks.set(key, tail);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function now(): string {
  return new Date().toISOString();
}
