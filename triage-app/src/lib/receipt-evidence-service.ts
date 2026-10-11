import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  RECEIPT_ARTIFACT_MAX_BYTES_V1,
  receiptBlobSha256SchemaV1,
  receiptEvidenceResponseV1,
  receiptSourceOccurrenceSchemaV1,
  ReceiptOrchestrationConflictV1,
} from "@rsocko/tyrion-finance-insights/receipt";
import { ReceiptEvidenceHttpError } from "@/lib/receipt-evidence-auth";
import {
  MONARCH_RECEIPT_MAX_BYTES,
  ReceiptBridgeAdapter,
} from "@/lib/receipt-bridge-adapter";
import { getReceiptEvidenceRuntime } from "@/lib/receipt-evidence-runtime";
import { ReceiptOwlClient } from "@/lib/receipt-owl-client";

const ALLOWED_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
]);
const MONARCH_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const locks = new Map<string, Promise<void>>();

export async function submitReceiptEvidence(
  request: Request
): Promise<unknown> {
  const runtime = getReceiptEvidenceRuntime();
  if (!runtime.gates.write) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_replica_write_disabled",
      "Receipt replica writes are disabled"
    );
  }
  const sourceOccurrenceId = parseOccurrenceHeader(request.headers);
  validateOwlHeaders(request.headers);
  return withOccurrenceLock(sourceOccurrenceId, async () => {
    const artifact = await spoolReceiptArtifact(request);
    try {
      const prior = runtime.store.getByOccurrence(sourceOccurrenceId);
      if (prior) {
        if (prior.blobSha256 !== artifact.sha256) {
          throw new ReceiptEvidenceHttpError(
            409,
            "receipt_occurrence_hash_conflict",
            "Receipt occurrence content conflicts with prior state"
          );
        }
        if (prior.replicaLifecycle !== "not_submitted") {
          return receiptEvidenceResponseV1(prior);
        }
      }

      const owl = ReceiptOwlClient.fromEnvironment();
      const priorIntake = await owl.lookup({ sourceOccurrenceId });
      const intake =
        priorIntake &&
        !(
          priorIntake.attempt_state === "retryable" &&
          priorIntake.retry_safe
        )
          ? priorIntake
          : await owl.submit(
              artifact.path,
              artifact.mediaType,
              request.headers
            );
      let record = runtime.store.recordIntake(
        sourceOccurrenceId,
        artifact.sha256,
        intake,
        now(),
        prior?.revision
      );
      if (
        !intake.external_replica_eligible ||
        !intake.canonical_document_ref ||
        intake.attempt_state !== "accepted"
      ) {
        const lifecycle =
          intake.attempt_state === "review_required" ||
          intake.attempt_state === "unknown" ||
          intake.attempt_state === "pending"
            ? "review"
            : intake.attempt_state === "failed"
              ? "failed"
              : intake.attempt_state === "retryable"
                ? "retryable"
              : "not_applicable";
        const reasonCodes =
          intake.attempt_state === "unknown"
            ? ["owl_intake_outcome_unknown"]
            : [];
        record = runtime.store.updateReplica(
          sourceOccurrenceId,
          record.revision,
          { lifecycle, reasonCodes },
          now()
        );
        return receiptEvidenceResponseV1(record);
      }
      if (
        !MONARCH_MEDIA_TYPES.has(artifact.mediaType) ||
        artifact.size > MONARCH_RECEIPT_MAX_BYTES
      ) {
        record = runtime.store.updateReplica(
          sourceOccurrenceId,
          record.revision,
          {
            lifecycle: "not_applicable",
            reasonCodes: ["monarch_artifact_not_supported"],
          },
          now()
        );
        return receiptEvidenceResponseV1(record);
      }
      const bridge = ReceiptBridgeAdapter.fromEnvironment(
        runtime.identityNamespace
      );
      record = runtime.store.updateReplica(
        sourceOccurrenceId,
        record.revision,
        {
          lifecycle: "review",
          reasonCodes: ["monarch_create_reserved"],
        },
        now()
      );
      let created;
      try {
        created = await bridge.create();
      } catch {
        record = runtime.store.updateReplica(
          sourceOccurrenceId,
          record.revision,
          {
            lifecycle: "review",
            reasonCodes: ["monarch_create_outcome_unknown"],
          },
          now()
        );
        return receiptEvidenceResponseV1(record);
      }
      const replicaRef = bridge.publicReference(created.id);
      record = runtime.store.updateReplica(
        sourceOccurrenceId,
        record.revision,
        {
          replicaRef,
          rawReceiptId: created.id,
          lifecycle: "review",
          reasonCodes: ["monarch_upload_reserved"],
        },
        now()
      );
      try {
        const uploaded = await bridge.upload(
          created.id,
          artifact.path,
          artifact.mediaType
        );
        const observedAt = now();
        const normalized = bridge.evidence(uploaded, observedAt);
        record = runtime.store.updateReplica(
          sourceOccurrenceId,
          record.revision,
          {
            lifecycle: normalized.lifecycle,
            nativeEvidence: normalized.evidence,
            reasonCodes: [],
          },
          observedAt
        );
        return receiptEvidenceResponseV1(record);
      } catch {
        record = runtime.store.updateReplica(
          sourceOccurrenceId,
          record.revision,
          {
            lifecycle: "review",
            reasonCodes: ["monarch_upload_outcome_unknown"],
          },
          now()
        );
        return receiptEvidenceResponseV1(record);
      }
    } catch (error) {
      if (error instanceof ReceiptOrchestrationConflictV1) {
        throw new ReceiptEvidenceHttpError(
          409,
          `receipt_${error.code}`,
          "Receipt orchestration state conflicts with the request"
        );
      }
      throw error;
    } finally {
      await rm(artifact.directory, { recursive: true, force: true });
    }
  });
}

export async function readReceiptEvidence(
  intakeRef: string
): Promise<unknown> {
  const runtime = getReceiptEvidenceRuntime();
  if (!runtime.gates.read) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_evidence_read_disabled",
      "Receipt evidence reads are disabled"
    );
  }
  const record = runtime.store.getByIntakeRef(intakeRef);
  if (!record) {
    throw new ReceiptEvidenceHttpError(
      404,
      "receipt_evidence_not_found",
      "Receipt evidence was not found"
    );
  }
  return receiptEvidenceResponseV1(record);
}

export async function reconcileReceiptEvidence(
  intakeRef: string
): Promise<unknown> {
  const runtime = getReceiptEvidenceRuntime();
  if (!runtime.gates.read) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_evidence_read_disabled",
      "Receipt evidence reads are disabled"
    );
  }
  if (!runtime.gates.recovery) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_recovery_disabled",
      "Receipt evidence recovery is disabled"
    );
  }
  const initial = runtime.store.getByIntakeRef(intakeRef);
  if (!initial) {
    throw new ReceiptEvidenceHttpError(
      404,
      "receipt_evidence_not_found",
      "Receipt evidence was not found"
    );
  }
  return withOccurrenceLock(initial.sourceOccurrenceId, async () => {
    let record = runtime.store.getByOccurrence(initial.sourceOccurrenceId);
    if (!record) {
      throw new ReceiptEvidenceHttpError(
        404,
        "receipt_evidence_not_found",
        "Receipt evidence was not found"
      );
    }
    if (record.intake.attempt_state === "unknown") {
      const intake =
        await ReceiptOwlClient.fromEnvironment().reconcile(intakeRef);
      record = runtime.store.recordIntake(
        record.sourceOccurrenceId,
        record.blobSha256,
        intake,
        now(),
        record.revision
      );
      const lifecycle =
        intake.attempt_state === "accepted" &&
        intake.external_replica_eligible &&
        intake.canonical_document_ref
          ? "not_submitted"
          : intake.attempt_state === "failed"
            ? "failed"
            : intake.attempt_state === "retryable"
              ? "retryable"
              : intake.attempt_state === "unknown" ||
                  intake.attempt_state === "pending" ||
                  intake.attempt_state === "review_required"
                ? "review"
                : "not_applicable";
      record = runtime.store.updateReplica(
        record.sourceOccurrenceId,
        record.revision,
        {
          lifecycle,
          reasonCodes:
            intake.attempt_state === "unknown"
              ? ["owl_intake_outcome_unknown"]
              : [],
        },
        now()
      );
    }
    if (
      record.replicaLifecycle === "review" &&
      record.rawReceiptId &&
      (record.reasonCodes.includes("monarch_upload_reserved") ||
        record.reasonCodes.includes("monarch_upload_outcome_unknown"))
    ) {
      try {
        const bridge = ReceiptBridgeAdapter.fromEnvironment(
          runtime.identityNamespace
        );
        const observedAt = now();
        const normalized = bridge.evidence(
          await bridge.get(record.rawReceiptId),
          observedAt
        );
        record = runtime.store.updateReplica(
          record.sourceOccurrenceId,
          record.revision,
          {
            lifecycle: normalized.lifecycle,
            nativeEvidence: normalized.evidence,
            reasonCodes: [],
          },
          observedAt
        );
      } catch {
        return receiptEvidenceResponseV1(record, [
          "monarch_outcome_still_unknown",
        ]);
      }
    }
    return receiptEvidenceResponseV1(record);
  });
}

function parseOccurrenceHeader(headers: Headers): string {
  const value = headers.get("x-owl-source-occurrence");
  const parsed = receiptSourceOccurrenceSchemaV1.safeParse(value);
  if (!parsed.success) {
    throw new ReceiptEvidenceHttpError(
      422,
      "invalid_source_occurrence",
      "Source occurrence is invalid"
    );
  }
  return parsed.data;
}

export async function spoolReceiptArtifact(
  request: Request,
  options: {
    allowedMediaTypes?: ReadonlySet<string>;
    maximumBytes?: number;
  } = {}
): Promise<{
  directory: string;
  path: string;
  mediaType: string;
  sha256: string;
  size: number;
}> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const allowedMediaTypes = options.allowedMediaTypes ?? ALLOWED_MEDIA_TYPES;
  const maximumBytes =
    options.maximumBytes ?? RECEIPT_ARTIFACT_MAX_BYTES_V1;
  if (!mediaType || !allowedMediaTypes.has(mediaType)) {
    throw new ReceiptEvidenceHttpError(
      415,
      "unsupported_media_type",
      "Receipt artifact media type is not supported"
    );
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > maximumBytes)
  ) {
    throw new ReceiptEvidenceHttpError(
      413,
      "payload_too_large",
      "Receipt artifact exceeds the size limit"
    );
  }
  if (!request.body) {
    throw new ReceiptEvidenceHttpError(
      422,
      "empty_artifact",
      "Receipt artifact is empty"
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "tyrion-receipt-"));
  const path = join(directory, "artifact");
  const digest = createHash("sha256");
  let size = 0;
  const source = Readable.fromWeb(
    request.body as unknown as import("node:stream/web").ReadableStream
  );
  source.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      source.destroy(new Error("payload_too_large"));
      return;
    }
    digest.update(chunk);
  });
  try {
    await pipeline(source, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof Error && error.message === "payload_too_large") {
      throw new ReceiptEvidenceHttpError(
        413,
        "payload_too_large",
        "Receipt artifact exceeds the size limit"
      );
    }
    throw new ReceiptEvidenceHttpError(
      400,
      "invalid_artifact",
      "Receipt artifact could not be read"
    );
  }
  if (size === 0 || (await stat(path)).size !== size) {
    await rm(directory, { recursive: true, force: true });
    throw new ReceiptEvidenceHttpError(
      422,
      "empty_artifact",
      "Receipt artifact is empty"
    );
  }
  const sha256 = digest.digest("hex");
  receiptBlobSha256SchemaV1.parse(sha256);
  try {
    await validateArtifactSignature(path, mediaType);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, path, mediaType, sha256, size };
}

function validateOwlHeaders(headers: Headers): void {
  const channel = headers.get("x-owl-source-channel");
  const version = headers.get("x-owl-source-occurrence-version") ?? "1";
  if (
    ![
      "email_attachment",
      "email_body",
      "scanner_job",
      "phone_upload",
      "manual_upload",
      "provider_api",
      "monarch_recovery",
    ].includes(channel ?? "") ||
    !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(version)
  ) {
    throw new ReceiptEvidenceHttpError(
      422,
      "invalid_receipt_metadata",
      "Receipt source metadata is invalid"
    );
  }
  const bounded = [
    ["x-owl-connector-ref", 200],
    ["x-owl-transform-version", 64],
    ["x-owl-normalized-version", 64],
    ["x-owl-semantic-version", 64],
  ] as const;
  for (const [name, maximum] of bounded) {
    const value = headers.get(name);
    if (value !== null && (!value || value.length > maximum || /\s/.test(value))) {
      throw new ReceiptEvidenceHttpError(
        422,
        "invalid_receipt_metadata",
        "Receipt source metadata is invalid"
      );
    }
  }
  for (const name of [
    "x-owl-normalized-fingerprint",
    "x-owl-semantic-fingerprint",
  ]) {
    const value = headers.get(name);
    if (value !== null && !/^[a-f0-9]{64}$/.test(value)) {
      throw new ReceiptEvidenceHttpError(
        422,
        "invalid_receipt_metadata",
        "Receipt source metadata is invalid"
      );
    }
  }
  if (
    Boolean(headers.get("x-owl-normalized-fingerprint")) !==
      Boolean(headers.get("x-owl-normalized-version")) ||
    Boolean(headers.get("x-owl-semantic-fingerprint")) !==
      Boolean(headers.get("x-owl-semantic-version"))
  ) {
    throw new ReceiptEvidenceHttpError(
      422,
      "invalid_receipt_metadata",
      "Receipt fingerprint metadata is incomplete"
    );
  }
}

async function validateArtifactSignature(
  path: string,
  mediaType: string
): Promise<void> {
  const file = await open(path, "r");
  try {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await file.read(signature, 0, signature.length, 0);
    const valid =
      (mediaType === "application/pdf" &&
        bytesRead >= 5 &&
        signature.subarray(0, 5).equals(Buffer.from("%PDF-"))) ||
      (mediaType === "image/png" &&
        bytesRead >= 8 &&
        signature.equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        )) ||
      (mediaType === "image/jpeg" &&
        bytesRead >= 3 &&
        signature[0] === 0xff &&
        signature[1] === 0xd8 &&
        signature[2] === 0xff) ||
      (mediaType === "image/tiff" &&
        bytesRead >= 4 &&
        ((signature[0] === 0x49 &&
          signature[1] === 0x49 &&
          signature[2] === 0x2a &&
          signature[3] === 0x00) ||
          (signature[0] === 0x4d &&
            signature[1] === 0x4d &&
            signature[2] === 0x00 &&
            signature[3] === 0x2a)));
    if (!valid) {
      throw new ReceiptEvidenceHttpError(
        422,
        "artifact_signature_mismatch",
        "Receipt artifact does not match its media type"
      );
    }
  } finally {
    await file.close();
  }
}

async function withOccurrenceLock<T>(
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
