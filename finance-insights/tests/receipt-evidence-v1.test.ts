import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseReceiptIntakeResultV1,
  parseReceiptBrokerResponseV1,
  createReceiptBrokerOpenApiV1,
  createReceiptEvidenceOpenApiV1,
  receiptEvidenceResponseV1,
  receiptOpaqueReferenceV1,
  ReceiptOrchestrationConflictV1,
  ReceiptOrchestrationSqliteStoreV1,
} from '../src/receipt/index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('receipt evidence v1', () => {
  it('accepts the exact OWL v1 result and rejects unknown fields', () => {
    const result = owlResult();
    expect(parseReceiptIntakeResultV1(result)).toEqual(result);
    expect(() =>
      parseReceiptIntakeResultV1({ ...result, document_bytes: 'forbidden' })
    ).toThrow();
  });

  it('derives stable opaque refs without exposing the raw upstream id', () => {
    const first = receiptOpaqueReferenceV1(
      'receipt',
      Buffer.from('invented-namespace'),
      'raw-private-receipt'
    );
    expect(first).toBe(
      receiptOpaqueReferenceV1(
        'receipt',
        Buffer.from('invented-namespace'),
        'raw-private-receipt'
      )
    );
    expect(first).not.toContain('raw-private-receipt');
  });

  it('validates the bounded broker response and rejects extra data', () => {
    const response = {
      brokerContractVersion: '1.0',
      idempotencyKey: 'owl-delivery-invented-0001',
      outcome: 'processing',
      acknowledged: true,
      retrySafe: false,
      reconcileRequired: true,
      replicaRef: 'receipt-v1_example',
      replicaLifecycle: 'processing',
      revision: 3,
      nativeEvidence: {
        receiptSource: 'upload',
        receiptState: 'processing',
        transactionRef: null,
        attachmentCount: 1,
        sourceAsOf: '2026-10-10T18:00:00Z',
        observedAt: '2026-10-10T18:00:01Z',
      },
      reasonCodes: [],
    };
    expect(parseReceiptBrokerResponseV1(response)).toEqual(response);
    expect(() =>
      parseReceiptBrokerResponseV1({
        ...response,
        rawMonarchReceiptId: 'forbidden',
      })
    ).toThrow();
  });

  it('persists idempotent occurrence state and rejects hash drift', () => {
    const { store } = createStore();
    const first = store.recordIntake(
      'a'.repeat(64),
      'b'.repeat(64),
      owlResult(),
      '2026-10-10T18:00:00.000Z'
    );
    expect(first.replicaLifecycle).toBe('not_submitted');
    expect(first.revision).toBe(0);
    expect(
      store.recordIntake(
        'a'.repeat(64),
        'b'.repeat(64),
        owlResult(),
        '2026-10-10T18:00:01.000Z'
      ).intake.intake_ref
    ).toBe('intake_example');
    expect(() =>
      store.recordIntake(
        'a'.repeat(64),
        'c'.repeat(64),
        owlResult(),
        '2026-10-10T18:00:02.000Z'
      )
    ).toThrowError(ReceiptOrchestrationConflictV1);
    store.close();
  });

  it('uses optimistic replica revisions and review-gates unknown outcomes', () => {
    const { store, path } = createStore();
    let record = store.recordIntake(
      'a'.repeat(64),
      'b'.repeat(64),
      owlResult(),
      '2026-10-10T18:00:00.000Z'
    );
    record = store.updateReplica(
      record.sourceOccurrenceId,
      0,
      {
        replicaRef: 'receipt-v1_example',
        rawReceiptId: 'private-example',
        lifecycle: 'submitted',
      },
      '2026-10-10T18:00:01.000Z'
    );
    expect(record.revision).toBe(1);
    record = store.updateReplica(
      record.sourceOccurrenceId,
      1,
      {
        lifecycle: 'review',
        reasonCodes: ['monarch_upload_outcome_unknown'],
      },
      '2026-10-10T18:00:02.000Z'
    );
    expect(receiptEvidenceResponseV1(record).reviewRequired).toBe(true);
    expect(() =>
      store.updateReplica(
        record.sourceOccurrenceId,
        1,
        { lifecycle: 'processing' },
        '2026-10-10T18:00:03.000Z'
      )
    ).toThrowError(ReceiptOrchestrationConflictV1);
    store.close();
    const reopened = new ReceiptOrchestrationSqliteStoreV1(path);
    expect(
      reopened.getByOccurrence(record.sourceOccurrenceId)?.replicaLifecycle
    ).toBe('review');
    expect(
      reopened.getByOccurrence(record.sourceOccurrenceId)?.rawReceiptId
    ).toBe('private-example');
    reopened.close();
  });

  it('increments intake revisions and rejects stale reconciliation updates', () => {
    const { store } = createStore();
    const initial = store.recordIntake(
      'a'.repeat(64),
      'b'.repeat(64),
      owlResult({ attempt_state: 'unknown' }),
      '2026-10-10T18:00:00.000Z'
    );
    const reconciled = store.recordIntake(
      initial.sourceOccurrenceId,
      initial.blobSha256,
      owlResult({ outcome: 'exact_hash_reused' }),
      '2026-10-10T18:00:01.000Z',
      initial.revision
    );
    expect(reconciled.revision).toBe(1);
    expect(reconciled.intake.outcome).toBe('exact_hash_reused');
    expect(() =>
      store.recordIntake(
        initial.sourceOccurrenceId,
        initial.blobSha256,
        owlResult({ outcome: 'source_occurrence_reused' }),
        '2026-10-10T18:00:02.000Z',
        initial.revision
      )
    ).toThrowError(ReceiptOrchestrationConflictV1);
    store.close();
  });

  it('persists mutation reservations that prevent blind retries', () => {
    const { store } = createStore();
    const initial = store.recordIntake(
      'a'.repeat(64),
      'b'.repeat(64),
      owlResult(),
      '2026-10-10T18:00:00.000Z'
    );
    const reserved = store.updateReplica(
      initial.sourceOccurrenceId,
      initial.revision,
      {
        lifecycle: 'review',
        reasonCodes: ['monarch_create_reserved'],
      },
      '2026-10-10T18:00:01.000Z'
    );
    expect(reserved.replicaLifecycle).toBe('review');
    expect(reserved.replicaRef).toBeNull();
    expect(receiptEvidenceResponseV1(reserved).reviewRequired).toBe(true);
    const uploadReserved = store.updateReplica(
      initial.sourceOccurrenceId,
      reserved.revision,
      {
        replicaRef: 'receipt-v1_example',
        rawReceiptId: 'private-example',
        lifecycle: 'review',
        reasonCodes: ['monarch_upload_reserved'],
      },
      '2026-10-10T18:00:02.000Z'
    );
    expect(uploadReserved.replicaLifecycle).toBe('review');
    expect(uploadReserved.rawReceiptId).toBe('private-example');
    expect(receiptEvidenceResponseV1(uploadReserved).reviewRequired).toBe(true);
    store.close();
  });

  it('atomically claims one broker create and resumes pre-reservation state', () => {
    const { store, path } = createStore();
    const intake = owlResult({
      intake_ref: 'owl-delivery-invented-0001',
      canonical_document_ref: 'paperless-document-invented',
      review_ref: 'owl-source-invented',
      reason_codes: [],
      source_channel: 'provider_api',
      retry_safe: false,
    });
    const first = store.reserveBrokerCreate(
      'a'.repeat(64),
      'b'.repeat(64),
      intake,
      '2026-10-10T18:00:00.000Z'
    );
    expect(first.claimed).toBe(true);
    expect(first.record.replicaLifecycle).toBe('review');
    expect(first.record.reasonCodes).toEqual(['monarch_create_reserved']);

    const secondStore = new ReceiptOrchestrationSqliteStoreV1(path);
    const duplicate = secondStore.reserveBrokerCreate(
      'a'.repeat(64),
      'b'.repeat(64),
      intake,
      '2026-10-10T18:00:01.000Z',
      first.record.revision
    );
    expect(duplicate.claimed).toBe(false);
    secondStore.close();
    store.close();

    const legacy = createStore().store;
    const unreserved = legacy.recordIntake(
      'c'.repeat(64),
      'd'.repeat(64),
      intake,
      '2026-10-10T18:00:02.000Z'
    );
    const resumed = legacy.reserveBrokerCreate(
      unreserved.sourceOccurrenceId,
      unreserved.blobSha256,
      intake,
      '2026-10-10T18:00:03.000Z',
      unreserved.revision
    );
    expect(resumed.claimed).toBe(true);
    expect(resumed.record.reasonCodes).toEqual(['monarch_create_reserved']);
    legacy.close();
  });

  it('review-gates semantic candidates without changing intake outcome', () => {
    const { store } = createStore();
    const intake = owlResult({
      outcome: 'semantic_review_candidate',
      attempt_state: 'accepted',
      review_ref: 'review_example',
    });
    const record = store.recordIntake(
      'a'.repeat(64),
      'b'.repeat(64),
      intake,
      '2026-10-10T18:00:00.000Z'
    );
    const response = receiptEvidenceResponseV1(record);
    expect(response.reviewRequired).toBe(true);
    expect(response.intake.external_replica_eligible).toBe(true);
    store.close();
  });

  it('review-gates unresolved canonical intake outcomes', () => {
    const { store } = createStore();
    const intake = owlResult({
      outcome: 'upload_outcome_unknown',
      attempt_state: 'unknown',
      canonical_document_ref: null,
    });
    const record = store.recordIntake(
      'a'.repeat(64),
      'b'.repeat(64),
      intake,
      '2026-10-10T18:00:00.000Z'
    );
    expect(receiptEvidenceResponseV1(record).reviewRequired).toBe(true);
    store.close();
  });

  it('publishes only the fixed internal receipt route family', () => {
    const document = createReceiptEvidenceOpenApiV1();
    expect(Object.keys(document.paths as Record<string, unknown>)).toEqual([
      '/api/internal/v1/finance/receipt-evidence/occurrences',
      '/api/internal/v1/finance/receipt-evidence/occurrences/{intakeRef}',
      '/api/internal/v1/finance/receipt-evidence/occurrences/{intakeRef}/reconcile',
    ]);
    expect(JSON.stringify(document)).not.toContain('/api/connector/v1');
  });

  it('publishes the broker-only route without canonical intake operations', () => {
    const document = createReceiptBrokerOpenApiV1();
    expect(Object.keys(document.paths as Record<string, unknown>)).toEqual([
      '/api/internal/v1/finance/receipt-broker/replicas',
      '/api/internal/v1/finance/receipt-broker/replicas/{idempotencyKey}/reconcile',
    ]);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('receipt-intake');
    expect(serialized).not.toContain('X-OWL-Source-Channel');
  });
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'receipt-evidence-test-'));
  directories.push(directory);
  const path = join(directory, 'state.sqlite');
  return { store: new ReceiptOrchestrationSqliteStoreV1(path), path };
}

function owlResult(
  overrides: Record<string, unknown> = {}
): ReturnType<typeof parseReceiptIntakeResultV1> {
  return parseReceiptIntakeResultV1({
    schema_version: '1.0',
    intake_ref: 'intake_example',
    outcome: 'new_canonical',
    attempt_state: 'accepted',
    canonical_document_ref: 'document_example',
    review_ref: null,
    reason_codes: ['paperless_acknowledged'],
    source_channel: 'manual_upload',
    source_occurrence_version: '1',
    source_as_of: '2026-10-10T18:00:00Z',
    retry_safe: true,
    external_replica_eligible: true,
    ...overrides,
  });
}
