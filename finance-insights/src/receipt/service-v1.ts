import {
  parseReceiptEvidenceResponseV1,
  type ReceiptEvidenceResponseV1,
} from './contracts-v1.js';
import type { ReceiptOrchestrationRecordV1 } from './store-v1.js';

export function receiptEvidenceResponseV1(
  record: ReceiptOrchestrationRecordV1,
  additionalReasons: readonly string[] = []
): ReceiptEvidenceResponseV1 {
  const reviewRequired =
    record.intake.attempt_state === 'unknown' ||
    record.intake.attempt_state === 'review_required' ||
    [
      'upload_outcome_unknown',
      'normalized_content_review',
      'semantic_review_candidate',
      'paperless_duplicate',
    ].includes(record.intake.outcome) ||
    ['ambiguous', 'failed', 'review'].includes(record.replicaLifecycle);
  return parseReceiptEvidenceResponseV1({
    receiptContractVersion: '1.0',
    intake: record.intake,
    replicaRef: record.replicaRef,
    replicaLifecycle: record.replicaLifecycle,
    revision: record.revision,
    nativeEvidence: record.nativeEvidence,
    reviewRequired,
    reasonCodes: [
      ...new Set([
        ...record.intake.reason_codes,
        ...record.reasonCodes,
        ...additionalReasons,
      ]),
    ].slice(0, 12),
  });
}
