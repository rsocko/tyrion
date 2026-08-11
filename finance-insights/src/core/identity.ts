import { createHmac } from 'node:crypto';
import {
  canonicalizeV1,
  normalizeIdentityTextV1,
  type CanonicalJsonValue,
} from './canonical.js';
import {
  amountMinorSchema,
  insightIdSchema,
  normalizedMerchantNameSchema,
  occurrenceIdSchema,
  parseContractV1,
  sourceReferenceSchema,
  sourceRevisionRefSchema,
} from '../contracts/primitives.js';
import { z } from 'zod';

export type IdentityInsightKindV1 =
  | 'recurringAmountChange'
  | 'largeTransaction'
  | 'categoryVariance'
  | 'merchantVariance';
export type IdentityEntityKindV1 =
  | 'recurring'
  | 'transaction'
  | 'category'
  | 'merchant';

export interface InsightIdentityInputV1 {
  householdScope: string;
  kind: IdentityInsightKindV1;
  entityKind: IdentityEntityKindV1;
  entitySourceRef: string;
}

export type OccurrenceDiscriminatorV1 =
  | {
      kind: 'recurringAmountChange';
      billingPeriod: string;
      sourceRevisionRef: string;
    }
  | {
      kind: 'largeTransaction';
      transactionSourceRef: string;
      sourceRevisionRef: string;
    }
  | {
      kind: 'categoryVariance' | 'merchantVariance';
      comparisonPeriod: string;
      direction: 'increase' | 'decrease';
      classificationLineage: string;
    };

export interface SourceRevisionInputV1 {
  sourceKind: 'transaction' | 'recurring' | 'category' | 'merchant';
  sourceRef: string;
  materialFact: CanonicalJsonValue;
  predecessorRevisionRef: string | null;
}

export interface MaterialChangeInputV1 {
  previousAmountMinor: number;
  nextAmountMinor: number;
  previousClassification: string;
  nextClassification: string;
  amountBoundaryMinor: number;
  changeKind: 'reevaluation' | 'evidence' | 'correction';
}

export interface MaterialChangeDecisionV1 {
  lineage: 'unchanged' | 'materialRevision' | 'correction';
  incrementDeliveryRevision: boolean;
  createSuccessorOccurrence: boolean;
  resurfaceEligible: boolean;
}

const insightIdentityInputSchema = z.strictObject({
  householdScope: sourceReferenceSchema,
  kind: z.enum([
    'recurringAmountChange',
    'largeTransaction',
    'categoryVariance',
    'merchantVariance',
  ]),
  entityKind: z.enum(['recurring', 'transaction', 'category', 'merchant']),
  entitySourceRef: sourceReferenceSchema,
}).superRefine((value, context) => {
  const expectedEntityKind: Record<IdentityInsightKindV1, IdentityEntityKindV1> = {
    recurringAmountChange: 'recurring',
    largeTransaction: 'transaction',
    categoryVariance: 'category',
    merchantVariance: 'merchant',
  };
  if (value.entityKind !== expectedEntityKind[value.kind]) {
    context.addIssue({
      code: 'custom',
      path: ['entityKind'],
      message: `must be ${expectedEntityKind[value.kind]} for ${value.kind}`,
    });
  }
});

const occurrenceDiscriminatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('recurringAmountChange'),
    billingPeriod: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
    sourceRevisionRef: sourceRevisionRefSchema,
  }),
  z.strictObject({
    kind: z.literal('largeTransaction'),
    transactionSourceRef: sourceReferenceSchema,
    sourceRevisionRef: sourceRevisionRefSchema,
  }),
  z.strictObject({
    kind: z.enum(['categoryVariance', 'merchantVariance']),
    comparisonPeriod: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
    direction: z.enum(['increase', 'decrease']),
    classificationLineage: sourceReferenceSchema,
  }),
]);

const sourceRevisionInputSchema = z.strictObject({
  sourceKind: z.enum(['transaction', 'recurring', 'category', 'merchant']),
  sourceRef: sourceReferenceSchema,
  materialFact: z.json(),
  predecessorRevisionRef: sourceRevisionRefSchema.nullable(),
});

export function deriveInsightIdV1(
  key: Uint8Array,
  input: InsightIdentityInputV1
): string {
  const parsed = parseContractV1(
    insightIdentityInputSchema,
    input,
    'insight identity input'
  );
  return deriveKeyedId('insight', key, {
    namespace: 'finance-insight-series-v1',
    householdScope: parsed.householdScope,
    kind: parsed.kind,
    entityKind: parsed.entityKind,
    entitySourceRef: parsed.entitySourceRef,
  });
}

export function deriveOccurrenceIdV1(
  key: Uint8Array,
  insightId: string,
  discriminator: OccurrenceDiscriminatorV1
): string {
  const parsedInsightId = parseContractV1(insightIdSchema, insightId, 'insight id');
  const parsedDiscriminator = parseContractV1(
    occurrenceDiscriminatorSchema,
    discriminator,
    'occurrence discriminator'
  );
  return deriveKeyedId('occurrence', key, {
    namespace: 'finance-insight-occurrence-v1',
    insightId: parsedInsightId,
    discriminator: parsedDiscriminator,
  });
}

export function deriveSourceRevisionRefV1(
  key: Uint8Array,
  input: SourceRevisionInputV1
): string {
  const parsed = parseContractV1(
    sourceRevisionInputSchema,
    input,
    'source revision input'
  );
  return deriveKeyedId('revision', key, {
    namespace: 'finance-insight-source-revision-v1',
    sourceKind: parsed.sourceKind,
    sourceRef: parsed.sourceRef,
    predecessorRevisionRef: parsed.predecessorRevisionRef,
    materialFact: parsed.materialFact as CanonicalJsonValue,
  });
}

export function deriveMerchantKeyV1(
  key: Uint8Array,
  normalizedName: string
): string {
  const parsedName = parseContractV1(
    normalizedMerchantNameSchema,
    normalizedName,
    'merchant display name'
  );
  return deriveKeyedId('merchant', key, {
    namespace: 'finance-insight-merchant-v1',
    normalizedName: normalizeIdentityTextV1(parsedName),
  });
}

export function evaluateMaterialChangeV1(
  input: MaterialChangeInputV1
): MaterialChangeDecisionV1 {
  parseContractV1(
    amountMinorSchema,
    input.previousAmountMinor,
    'previous material amount'
  );
  parseContractV1(
    amountMinorSchema,
    input.nextAmountMinor,
    'next material amount'
  );
  if (!Number.isSafeInteger(input.amountBoundaryMinor) || input.amountBoundaryMinor < 1) {
    throw new RangeError('amountBoundaryMinor must be a positive safe integer');
  }
  if (input.changeKind === 'correction') {
    return {
      lineage: 'correction',
      incrementDeliveryRevision: false,
      createSuccessorOccurrence: true,
      resurfaceEligible: true,
    };
  }
  const classificationChanged =
    input.previousClassification !== input.nextClassification;
  const amountChangedMaterially =
    Math.abs(input.nextAmountMinor - input.previousAmountMinor) >=
    input.amountBoundaryMinor;
  if (classificationChanged || amountChangedMaterially) {
    return {
      lineage: 'materialRevision',
      incrementDeliveryRevision: true,
      createSuccessorOccurrence: false,
      resurfaceEligible: true,
    };
  }
  return {
    lineage: 'unchanged',
    incrementDeliveryRevision: false,
    createSuccessorOccurrence: false,
    resurfaceEligible: false,
  };
}

export function nextDeliveryRevisionV1(
  currentRevision: number,
  decision: MaterialChangeDecisionV1
): number {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) {
    throw new RangeError('currentRevision must be a positive safe integer');
  }
  return decision.incrementDeliveryRevision
    ? safeIncrement(currentRevision)
    : currentRevision;
}

export function sourceNotificationIdV1(
  connectorRef: string,
  occurrenceId: string
): string {
  const parsedConnector = parseContractV1(
    sourceReferenceSchema,
    connectorRef,
    'connector reference'
  );
  const parsedOccurrence = parseContractV1(
    occurrenceIdSchema,
    occurrenceId,
    'occurrence id'
  );
  return `finance-insight:${parsedConnector}:${parsedOccurrence}`;
}

export function sourceActivityKeyV1(
  occurrenceId: string,
  deliveryRevision: number
): string {
  const parsedOccurrence = parseContractV1(
    occurrenceIdSchema,
    occurrenceId,
    'occurrence id'
  );
  if (!Number.isSafeInteger(deliveryRevision) || deliveryRevision < 1) {
    throw new RangeError('deliveryRevision must be a positive safe integer');
  }
  return `${parsedOccurrence}:${deliveryRevision}`;
}

function safeIncrement(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('deliveryRevision cannot exceed the safe integer limit');
  }
  return value + 1;
}

function deriveKeyedId(
  prefix: 'insight' | 'occurrence' | 'revision' | 'merchant',
  key: Uint8Array,
  value: CanonicalJsonValue
): string {
  if (key.byteLength < 32) {
    throw new RangeError('Identity keys must contain at least 32 bytes');
  }
  const digest = createHmac('sha256', key)
    .update(canonicalizeV1(value))
    .digest('base64url');
  return `${prefix}-v1_${digest}`;
}
