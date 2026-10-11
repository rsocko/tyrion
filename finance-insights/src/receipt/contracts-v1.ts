import { z } from 'zod';
import {
  idempotencyKeySchema,
  sourceReferenceSchema,
  utcTimestampSchema,
} from '../contracts/primitives.js';

export const RECEIPT_EVIDENCE_CONTRACT_VERSION_V1 = '1.0' as const;
export const RECEIPT_ARTIFACT_MAX_BYTES_V1 = 25 * 1024 * 1024;

export const receiptSourceChannelSchemaV1 = z.enum([
  'email_attachment',
  'email_body',
  'scanner_job',
  'phone_upload',
  'manual_upload',
  'provider_api',
  'monarch_recovery',
]);

export const receiptIntakeOutcomeSchemaV1 = z.enum([
  'new_canonical',
  'source_occurrence_reused',
  'exact_hash_reused',
  'normalized_content_review',
  'semantic_review_candidate',
  'paperless_duplicate',
  'upload_outcome_unknown',
  'upload_retryable',
  'upload_failed',
]);

export const receiptIntakeAttemptStateSchemaV1 = z.enum([
  'pending',
  'accepted',
  'unknown',
  'retryable',
  'failed',
  'review_required',
]);

export const receiptIntakeResultSchemaV1 = z.strictObject({
  schema_version: z.literal('1.0'),
  intake_ref: sourceReferenceSchema,
  outcome: receiptIntakeOutcomeSchemaV1,
  attempt_state: receiptIntakeAttemptStateSchemaV1,
  canonical_document_ref: sourceReferenceSchema.nullable(),
  review_ref: sourceReferenceSchema.nullable(),
  reason_codes: z
    .array(
      z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9._-]*$/)
    )
    .max(8),
  source_channel: receiptSourceChannelSchemaV1,
  source_occurrence_version: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  source_as_of: z.string().datetime({ offset: true }).nullable(),
  retry_safe: z.boolean(),
  external_replica_eligible: z.boolean(),
});

export const receiptReplicaLifecycleSchemaV1 = z.enum([
  'not_submitted',
  'submitted',
  'processing',
  'matched',
  'awaiting_transaction',
  'ambiguous',
  'failed',
  'retryable',
  'review',
  'not_applicable',
  'verified',
  'settled',
  'deleted',
  'delete_unknown',
]);

export const receiptNativeEvidenceSchemaV1 = z.strictObject({
  receiptSource: z.enum(['upload', 'email']),
  receiptState: z.enum([
    'processing',
    'awaiting_match',
    'matched',
    'failed',
  ]),
  transactionRef: sourceReferenceSchema.nullable(),
  attachmentCount: z.number().int().min(0).max(8),
  sourceAsOf: utcTimestampSchema.nullable(),
  observedAt: utcTimestampSchema,
});

export const receiptEvidenceResponseSchemaV1 = z.strictObject({
  receiptContractVersion: z.literal(RECEIPT_EVIDENCE_CONTRACT_VERSION_V1),
  intake: receiptIntakeResultSchemaV1,
  replicaRef: sourceReferenceSchema.nullable(),
  replicaLifecycle: receiptReplicaLifecycleSchemaV1,
  revision: z.number().int().nonnegative(),
  nativeEvidence: receiptNativeEvidenceSchemaV1.nullable(),
  reviewRequired: z.boolean(),
  reasonCodes: z
    .array(
      z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9._-]*$/)
    )
    .max(12),
});

export const receiptSourceOccurrenceSchemaV1 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);

export const receiptBlobSha256SchemaV1 = receiptSourceOccurrenceSchemaV1;

export const receiptBrokerOutcomeSchemaV1 = z.enum([
  'acknowledged',
  'processing',
  'duplicate',
  'retryable',
  'unknown',
]);

export const receiptBrokerResponseSchemaV1 = z.strictObject({
  brokerContractVersion: z.literal('1.0'),
  idempotencyKey: idempotencyKeySchema,
  outcome: receiptBrokerOutcomeSchemaV1,
  acknowledged: z.boolean(),
  retrySafe: z.boolean(),
  reconcileRequired: z.boolean(),
  replicaRef: sourceReferenceSchema.nullable(),
  replicaLifecycle: receiptReplicaLifecycleSchemaV1,
  revision: z.number().int().nonnegative(),
  nativeEvidence: receiptNativeEvidenceSchemaV1.nullable(),
  reasonCodes: z
    .array(
      z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9._-]*$/)
    )
    .max(12),
});

export type ReceiptSourceChannelV1 = z.infer<
  typeof receiptSourceChannelSchemaV1
>;
export type ReceiptIntakeResultV1 = z.infer<
  typeof receiptIntakeResultSchemaV1
>;
export type ReceiptReplicaLifecycleV1 = z.infer<
  typeof receiptReplicaLifecycleSchemaV1
>;
export type ReceiptNativeEvidenceV1 = z.infer<
  typeof receiptNativeEvidenceSchemaV1
>;
export type ReceiptEvidenceResponseV1 = z.infer<
  typeof receiptEvidenceResponseSchemaV1
>;
export type ReceiptBrokerOutcomeV1 = z.infer<
  typeof receiptBrokerOutcomeSchemaV1
>;
export type ReceiptBrokerResponseV1 = z.infer<
  typeof receiptBrokerResponseSchemaV1
>;

export function parseReceiptIntakeResultV1(
  value: unknown
): ReceiptIntakeResultV1 {
  return receiptIntakeResultSchemaV1.parse(value);
}

export function parseReceiptEvidenceResponseV1(
  value: unknown
): ReceiptEvidenceResponseV1 {
  return receiptEvidenceResponseSchemaV1.parse(value);
}

export function parseReceiptBrokerResponseV1(
  value: unknown
): ReceiptBrokerResponseV1 {
  return receiptBrokerResponseSchemaV1.parse(value);
}
