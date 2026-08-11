import { z } from 'zod';
import {
  contractVersionSchema,
  deliveryRevisionSchema,
  idempotencyKeySchema,
  occurrenceIdSchema,
  parseContractV1,
  positiveSequenceSchema,
  sourceReferenceSchema,
  utcTimestampSchema,
} from './primitives.js';

const actionIdentityShape = {
  contractVersion: contractVersionSchema,
  occurrenceId: occurrenceIdSchema,
  expectedDeliveryRevision: deliveryRevisionSchema,
  expectedPolicyVersion: positiveSequenceSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const expectedActionRequestSchema = z.strictObject({
  ...actionIdentityShape,
  action: z.literal('expected'),
  reason: z.enum([
    'knownHouseholdExpense',
    'expectedSeasonalChange',
    'expectedOneTimePurchase',
  ]),
});

export const notUsefulActionRequestSchema = z.strictObject({
  ...actionIdentityShape,
  action: z.literal('notUseful'),
  reason: z.enum([
    'notActionable',
    'comparisonNotRepresentative',
    'duplicateContext',
  ]),
});

export const suppressActionRequestSchema = z.strictObject({
  ...actionIdentityShape,
  action: z.literal('suppress'),
  confirm: z.literal(true),
  scope: z.enum(['occurrence', 'entity', 'category']),
  durationDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
  reason: z.enum([
    'expectedRecurringPattern',
    'approvedMerchant',
    'temporaryHouseholdChange',
  ]),
});

export const undoSuppressionActionRequestSchema = z.strictObject({
  ...actionIdentityShape,
  action: z.literal('undoSuppression'),
  suppressionId: sourceReferenceSchema,
  confirm: z.literal(true),
});

export const occurrenceActionRequestSchema = z.discriminatedUnion('action', [
  expectedActionRequestSchema,
  notUsefulActionRequestSchema,
  suppressActionRequestSchema,
  undoSuppressionActionRequestSchema,
]);

const occurrenceActionResultShape = {
  contractVersion: contractVersionSchema,
  occurrenceId: occurrenceIdSchema,
  deliveryRevision: deliveryRevisionSchema,
  policyVersion: positiveSequenceSchema,
  actionRef: sourceReferenceSchema,
  appliedAt: utcTimestampSchema,
} as const;

export const occurrenceActionResultSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...occurrenceActionResultShape,
    action: z.enum(['expected', 'notUseful']),
    suppressionId: z.null(),
  }),
  z.strictObject({
    ...occurrenceActionResultShape,
    action: z.enum(['suppress', 'undoSuppression']),
    suppressionId: sourceReferenceSchema,
  }),
]);

export type OccurrenceActionRequestV1 = z.infer<
  typeof occurrenceActionRequestSchema
>;
export type OccurrenceActionResultV1 = z.infer<
  typeof occurrenceActionResultSchema
>;

export function parseOccurrenceActionRequestV1(
  value: unknown
): OccurrenceActionRequestV1 {
  return parseContractV1(
    occurrenceActionRequestSchema,
    value,
    'occurrence action request'
  );
}

export function parseOccurrenceActionResultV1(
  value: unknown
): OccurrenceActionResultV1 {
  return parseContractV1(
    occurrenceActionResultSchema,
    value,
    'occurrence action result'
  );
}
