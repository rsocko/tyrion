import Database from 'better-sqlite3';
import type {
  ReceiptIntakeResultV1,
  ReceiptNativeEvidenceV1,
  ReceiptReplicaLifecycleV1,
} from './contracts-v1.js';

export interface ReceiptOrchestrationRecordV1 {
  sourceOccurrenceId: string;
  blobSha256: string;
  intake: ReceiptIntakeResultV1;
  replicaRef: string | null;
  rawReceiptId: string | null;
  replicaLifecycle: ReceiptReplicaLifecycleV1;
  revision: number;
  nativeEvidence: ReceiptNativeEvidenceV1 | null;
  reasonCodes: string[];
  createdAt: string;
  updatedAt: string;
}

export class ReceiptOrchestrationConflictV1 extends Error {
  constructor(readonly code: 'occurrence_hash_conflict' | 'revision_conflict') {
    super(code);
    this.name = 'ReceiptOrchestrationConflictV1';
  }
}

export class ReceiptOrchestrationSqliteStoreV1 {
  private readonly database: Database.Database;

  constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS receipt_evidence_orchestrations (
        source_occurrence_id TEXT PRIMARY KEY,
        blob_sha256 TEXT NOT NULL,
        intake_ref TEXT NOT NULL UNIQUE,
        intake_json TEXT NOT NULL,
        replica_ref TEXT UNIQUE,
        raw_receipt_id TEXT UNIQUE,
        replica_lifecycle TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        native_evidence_json TEXT,
        reason_codes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS receipt_evidence_blob_sha256_idx
        ON receipt_evidence_orchestrations(blob_sha256);
    `);
    const columns = this.database
      .prepare('PRAGMA table_info(receipt_evidence_orchestrations)')
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === 'reason_codes_json')) {
      this.database.exec(
        `ALTER TABLE receipt_evidence_orchestrations
         ADD COLUMN reason_codes_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
  }

  close(): void {
    this.database.close();
  }

  getByOccurrence(sourceOccurrenceId: string): ReceiptOrchestrationRecordV1 | null {
    return this.read(
      this.database
        .prepare(
          `SELECT * FROM receipt_evidence_orchestrations
           WHERE source_occurrence_id = ?`
        )
        .get(sourceOccurrenceId)
    );
  }

  getByIntakeRef(intakeRef: string): ReceiptOrchestrationRecordV1 | null {
    return this.read(
      this.database
        .prepare(
          `SELECT * FROM receipt_evidence_orchestrations WHERE intake_ref = ?`
        )
        .get(intakeRef)
    );
  }

  recordIntake(
    sourceOccurrenceId: string,
    blobSha256: string,
    intake: ReceiptIntakeResultV1,
    now: string,
    expectedRevision?: number
  ): ReceiptOrchestrationRecordV1 {
    const existing = this.getByOccurrence(sourceOccurrenceId);
    if (existing) {
      if (existing.blobSha256 !== blobSha256) {
        throw new ReceiptOrchestrationConflictV1('occurrence_hash_conflict');
      }
      const serialized = JSON.stringify(intake);
      if (JSON.stringify(existing.intake) === serialized) return existing;
      const revision = expectedRevision ?? existing.revision;
      if (revision !== existing.revision) {
        throw new ReceiptOrchestrationConflictV1('revision_conflict');
      }
      const result = this.database
        .prepare(
          `UPDATE receipt_evidence_orchestrations
           SET intake_ref = ?, intake_json = ?, revision = revision + 1,
               updated_at = ?
           WHERE source_occurrence_id = ? AND revision = ?`
        )
        .run(
          intake.intake_ref,
          serialized,
          now,
          sourceOccurrenceId,
          revision
        );
      if (result.changes !== 1) {
        throw new ReceiptOrchestrationConflictV1('revision_conflict');
      }
      return this.getByOccurrence(sourceOccurrenceId)!;
    }
    this.database
      .prepare(
        `INSERT INTO receipt_evidence_orchestrations (
          source_occurrence_id, blob_sha256, intake_ref, intake_json,
          replica_ref, raw_receipt_id, replica_lifecycle, revision,
          native_evidence_json, reason_codes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, 'not_submitted', 0, NULL, '[]', ?, ?)`
      )
      .run(
        sourceOccurrenceId,
        blobSha256,
        intake.intake_ref,
        JSON.stringify(intake),
        now,
        now
      );
    return this.getByOccurrence(sourceOccurrenceId)!;
  }

  updateReplica(
    sourceOccurrenceId: string,
    expectedRevision: number,
    update: {
      replicaRef?: string | null;
      rawReceiptId?: string | null;
      lifecycle: ReceiptReplicaLifecycleV1;
      nativeEvidence?: ReceiptNativeEvidenceV1 | null;
      reasonCodes?: readonly string[];
    },
    now: string
  ): ReceiptOrchestrationRecordV1 {
    const existing = this.getByOccurrence(sourceOccurrenceId);
    if (!existing || existing.revision !== expectedRevision) {
      throw new ReceiptOrchestrationConflictV1('revision_conflict');
    }
    const revision = expectedRevision + 1;
    const result = this.database
      .prepare(
        `UPDATE receipt_evidence_orchestrations
         SET replica_ref = ?, raw_receipt_id = ?, replica_lifecycle = ?,
             revision = ?, native_evidence_json = ?, reason_codes_json = ?,
             updated_at = ?
         WHERE source_occurrence_id = ? AND revision = ?`
      )
      .run(
        update.replicaRef === undefined
          ? existing.replicaRef
          : update.replicaRef,
        update.rawReceiptId === undefined
          ? existing.rawReceiptId
          : update.rawReceiptId,
        update.lifecycle,
        revision,
        JSON.stringify(
          update.nativeEvidence === undefined
            ? existing.nativeEvidence
            : update.nativeEvidence
        ),
        JSON.stringify(
          update.reasonCodes === undefined
            ? existing.reasonCodes
            : [...new Set(update.reasonCodes)].slice(0, 12)
        ),
        now,
        sourceOccurrenceId,
        expectedRevision
      );
    if (result.changes !== 1) {
      throw new ReceiptOrchestrationConflictV1('revision_conflict');
    }
    return this.getByOccurrence(sourceOccurrenceId)!;
  }

  private read(value: unknown): ReceiptOrchestrationRecordV1 | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    return {
      sourceOccurrenceId: String(row.source_occurrence_id),
      blobSha256: String(row.blob_sha256),
      intake: JSON.parse(String(row.intake_json)) as ReceiptIntakeResultV1,
      replicaRef:
        row.replica_ref === null ? null : String(row.replica_ref),
      rawReceiptId:
        row.raw_receipt_id === null ? null : String(row.raw_receipt_id),
      replicaLifecycle:
        String(row.replica_lifecycle) as ReceiptReplicaLifecycleV1,
      revision: Number(row.revision),
      nativeEvidence:
        row.native_evidence_json === null
          ? null
          : (JSON.parse(
              String(row.native_evidence_json)
            ) as ReceiptNativeEvidenceV1),
      reasonCodes: JSON.parse(String(row.reason_codes_json)) as string[],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
