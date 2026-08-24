import { z } from 'zod';
import {
  amountMinorSchema,
  calendarDateSchema,
  canonicalDigestSchema,
  contractVersionSchema,
  currencySchema,
  idempotencyKeySchema,
  nonNegativeIntegerSchema,
  normalizedDisplayNameSchema,
  normalizedMerchantNameSchema,
  parseContractV1,
  positiveSequenceSchema,
  sourceReferenceSchema,
  sourceSequenceSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
} from './primitives.js';

export const SOURCE_GENERATION_ITEM_LIMITS_V1 = Object.freeze({
  transaction: 50_000,
  recurring: 5_000,
  category: 2_000,
  account: 1_000,
  tag: 1_000,
});

export const sourceFactKindSchema = z.enum([
  'transaction',
  'recurring',
  'category',
  'account',
  'tag',
]);

export const publicationConstituentSchema = z.strictObject({
  kind: sourceFactKindSchema,
  generationRef: sourceReferenceSchema,
  sourceAsOf: utcTimestampSchema,
  itemCount: nonNegativeIntegerSchema,
  digest: canonicalDigestSchema,
});

export const sourceManifestEntrySchema = z.strictObject({
  kind: sourceFactKindSchema,
  batchCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  digest: canonicalDigestSchema,
});

const sourceGenerationCreateRequestBaseSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  sourceSequence: sourceSequenceSchema,
  sourceAsOf: utcTimestampSchema,
  coverageStart: calendarDateSchema,
  coverageEnd: calendarDateSchema,
  currency: currencySchema,
  bridgeContractVersion: versionIdentifierSchema,
  capturedConstituents: z.array(publicationConstituentSchema).length(5),
  manifest: z.array(sourceManifestEntrySchema).length(5),
  idempotencyKey: idempotencyKeySchema,
});

export const sourceGenerationCreateRequestSchema =
  sourceGenerationCreateRequestBaseSchema.superRefine((value, context) => {
    if (value.coverageEnd < value.coverageStart) {
      context.addIssue({
        code: 'custom',
        path: ['coverageEnd'],
        message: 'must be on or after coverageStart',
      });
    }
    requireEveryFactKind(
      value.capturedConstituents.map((item) => item.kind),
      ['capturedConstituents'],
      context
    );
    const conservativeSourceAsOf = value.capturedConstituents
      .map((item) => item.sourceAsOf)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    if (
      conservativeSourceAsOf === undefined ||
      Date.parse(value.sourceAsOf) !== Date.parse(conservativeSourceAsOf)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceAsOf'],
        message: 'must equal the earliest captured constituent sourceAsOf',
      });
    }
    requireEveryFactKind(
      value.manifest.map((item) => item.kind),
      ['manifest'],
      context
    );
    const constituentCounts = new Map(
      value.capturedConstituents.map((item) => [item.kind, item.itemCount])
    );
    value.manifest.forEach((entry, index) => {
      if (constituentCounts.get(entry.kind) !== entry.itemCount) {
        context.addIssue({
          code: 'custom',
          path: ['manifest', index, 'itemCount'],
          message: 'must match the captured constituent item count',
        });
      }
      if (
        (entry.itemCount === 0 && entry.batchCount !== 0) ||
        (entry.itemCount > 0 && entry.batchCount < 1)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['manifest', index, 'batchCount'],
          message: 'is inconsistent with itemCount',
        });
      }
      if (entry.itemCount > SOURCE_GENERATION_ITEM_LIMITS_V1[entry.kind]) {
        context.addIssue({
          code: 'custom',
          path: ['manifest', index, 'itemCount'],
          message: `exceeds the ${entry.kind} generation limit`,
        });
      }
      if (entry.batchCount > entry.itemCount) {
        context.addIssue({
          code: 'custom',
          path: ['manifest', index, 'batchCount'],
          message: 'cannot exceed itemCount',
        });
      }
      if (entry.batchCount < Math.ceil(entry.itemCount / 250)) {
        context.addIssue({
          code: 'custom',
          path: ['manifest', index, 'batchCount'],
          message: 'cannot hold itemCount within 250-item batches',
        });
      }
    });
  });

const nullableSourceRefSchema = sourceReferenceSchema.nullable();

export const transactionSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  occurredOn: calendarDateSchema,
  amountMinor: amountMinorSchema,
  merchantName: normalizedMerchantNameSchema,
  categoryRef: nullableSourceRefSchema,
  accountRef: nullableSourceRefSchema,
  isPending: z.boolean(),
  recurringRef: nullableSourceRefSchema,
  tagRefs: z
    .array(sourceReferenceSchema)
    .max(50)
    .refine(uniqueStrings, 'must contain unique values'),
});

export const recurringSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  amountMinor: amountMinorSchema.nullable(),
  cadence: z.enum([
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'semiannual',
    'annual',
    'unknown',
  ]),
  nextDate: calendarDateSchema.nullable(),
  categoryRef: nullableSourceRefSchema,
  accountRef: nullableSourceRefSchema,
  active: z.boolean(),
});

export const categorySourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  groupRef: nullableSourceRefSchema,
  active: z.boolean(),
});

export const accountTypeSchema = z.enum([
  'checking',
  'savings',
  'credit',
  'cash',
  'loan',
  'investment',
  'other',
]);

export const accountLastFourSchema = z
  .string()
  .length(4)
  .regex(/^[0-9]{4}$/, 'must contain exactly four digits');

export const accountSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema.optional(),
  institutionName: normalizedDisplayNameSchema.optional(),
  accountType: accountTypeSchema,
  accountLastFour: accountLastFourSchema.optional(),
  active: z.boolean(),
});

export const tagSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  active: z.boolean(),
});

function batchSchema<
  K extends 'transaction' | 'recurring' | 'category' | 'account' | 'tag',
  T extends z.ZodType
>(kind: K, fact: T) {
  return z
    .strictObject({
      contractVersion: contractVersionSchema,
      sourceGeneration: sourceReferenceSchema,
      kind: z.literal(kind),
      batchIndex: nonNegativeIntegerSchema,
      facts: z.array(fact).min(1).max(250),
      digest: canonicalDigestSchema,
      idempotencyKey: idempotencyKeySchema,
    })
    .superRefine((value, context) => {
      const refs = value.facts.map((item) => (item as { sourceRef: string }).sourceRef);
      if (!uniqueStrings(refs)) {
        context.addIssue({
          code: 'custom',
          path: ['facts'],
          message: 'must contain unique source references',
        });
      }
    });
}

export const sourceFactBatchSchema = z.discriminatedUnion('kind', [
  batchSchema('transaction', transactionSourceFactSchema),
  batchSchema('recurring', recurringSourceFactSchema),
  batchSchema('category', categorySourceFactSchema),
  batchSchema('account', accountSourceFactSchema),
  batchSchema('tag', tagSourceFactSchema),
]);

export const sourceGenerationCommitRequestSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  sourceGeneration: sourceReferenceSchema,
  expectedSourceSequence: positiveSequenceSchema,
  manifestDigest: canonicalDigestSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const evaluationRequestSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  detectorSetVersion: versionIdentifierSchema,
  expectedPolicyVersion: positiveSequenceSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const evaluationIdentitySchema = z.strictObject({
  householdScope: sourceReferenceSchema,
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  detectorSetVersion: versionIdentifierSchema,
  policyVersion: positiveSequenceSchema,
});

export const assignedEvaluationSchema = z.strictObject({
  identity: evaluationIdentitySchema,
  sourceSequence: sourceSequenceSchema,
  evaluationSequence: positiveSequenceSchema,
  acceptedAt: utcTimestampSchema,
});

const sourceGenerationResultIdentityShape = {
  contractVersion: contractVersionSchema,
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  sourceSequence: sourceSequenceSchema,
} as const;

export const sourceGenerationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...sourceGenerationResultIdentityShape,
    state: z.literal('staging'),
    detectorSetVersion: z.null(),
    policyVersion: z.null(),
  }),
  z.strictObject({
    ...sourceGenerationResultIdentityShape,
    state: z.enum(['promoted', 'historical']),
    detectorSetVersion: versionIdentifierSchema,
    policyVersion: positiveSequenceSchema,
  }),
]);

export const sourceBatchReceiptSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  sourceGeneration: sourceReferenceSchema,
  kind: sourceFactKindSchema,
  batchIndex: nonNegativeIntegerSchema,
  digest: canonicalDigestSchema,
  state: z.literal('accepted'),
});

const evaluationResultIdentityShape = {
  contractVersion: contractVersionSchema,
  identity: evaluationIdentitySchema,
  sourceSequence: sourceSequenceSchema,
  evaluationSequence: positiveSequenceSchema,
  acceptedAt: utcTimestampSchema,
} as const;

export const evaluationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...evaluationResultIdentityShape,
    state: z.enum(['queued', 'evaluating']),
    completedAt: z.null(),
  }),
  z
    .strictObject({
      ...evaluationResultIdentityShape,
      state: z.enum(['completed', 'unavailable', 'failed']),
      completedAt: utcTimestampSchema,
    })
    .superRefine((value, context) => {
      if (Date.parse(value.completedAt) < Date.parse(value.acceptedAt)) {
        context.addIssue({
          code: 'custom',
          path: ['completedAt'],
          message: 'must be on or after acceptedAt',
        });
      }
    }),
]);

export type SourceFactKindV1 = z.infer<typeof sourceFactKindSchema>;
export type PublicationConstituentV1 = z.infer<
  typeof publicationConstituentSchema
>;
export type SourceManifestEntryV1 = z.infer<typeof sourceManifestEntrySchema>;
export type SourceGenerationCreateRequestV1 = z.infer<
  typeof sourceGenerationCreateRequestSchema
>;
export type SourceFactBatchV1 = z.infer<typeof sourceFactBatchSchema>;
export type TransactionSourceFactV1 = z.infer<
  typeof transactionSourceFactSchema
>;
export type RecurringSourceFactV1 = z.infer<typeof recurringSourceFactSchema>;
export type CategorySourceFactV1 = z.infer<typeof categorySourceFactSchema>;
export type AccountSourceFactV1 = z.infer<typeof accountSourceFactSchema>;
export type TagSourceFactV1 = z.infer<typeof tagSourceFactSchema>;
export type SourceGenerationCommitRequestV1 = z.infer<
  typeof sourceGenerationCommitRequestSchema
>;
export type EvaluationRequestV1 = z.infer<typeof evaluationRequestSchema>;
export type EvaluationIdentityV1 = z.infer<typeof evaluationIdentitySchema>;
export type AssignedEvaluationV1 = z.infer<typeof assignedEvaluationSchema>;
export type SourceGenerationResultV1 = z.infer<
  typeof sourceGenerationResultSchema
>;
export type SourceBatchReceiptV1 = z.infer<typeof sourceBatchReceiptSchema>;
export type EvaluationResultV1 = z.infer<typeof evaluationResultSchema>;

export function parseSourceGenerationCreateRequestV1(
  value: unknown
): SourceGenerationCreateRequestV1 {
  return parseContractV1(
    sourceGenerationCreateRequestSchema,
    value,
    'source generation create request'
  );
}

export function parseSourceFactBatchV1(value: unknown): SourceFactBatchV1 {
  return parseContractV1(sourceFactBatchSchema, value, 'source fact batch');
}

export function parseSourceGenerationCommitRequestV1(
  value: unknown
): SourceGenerationCommitRequestV1 {
  return parseContractV1(
    sourceGenerationCommitRequestSchema,
    value,
    'source generation commit request'
  );
}

export function parseEvaluationRequestV1(value: unknown): EvaluationRequestV1 {
  return parseContractV1(evaluationRequestSchema, value, 'evaluation request');
}

export function parseSourceGenerationResultV1(
  value: unknown
): SourceGenerationResultV1 {
  return parseContractV1(
    sourceGenerationResultSchema,
    value,
    'source generation result'
  );
}

export function parseSourceBatchReceiptV1(
  value: unknown
): SourceBatchReceiptV1 {
  return parseContractV1(sourceBatchReceiptSchema, value, 'source batch receipt');
}

export function parseEvaluationResultV1(value: unknown): EvaluationResultV1 {
  return parseContractV1(evaluationResultSchema, value, 'evaluation result');
}

export function evaluationKeyV1(identity: EvaluationIdentityV1): string {
  const parsed = parseContractV1(
    evaluationIdentitySchema,
    identity,
    'evaluation identity'
  );
  return JSON.stringify([
    parsed.householdScope,
    parsed.connectorRef,
    parsed.sourceGeneration,
    parsed.detectorSetVersion,
    parsed.policyVersion,
  ]);
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function requireEveryFactKind(
  values: readonly SourceFactKindV1[],
  path: (string | number)[],
  context: z.RefinementCtx
): void {
  const expected: SourceFactKindV1[] = [
    'transaction',
    'recurring',
    'category',
    'account',
    'tag',
  ];
  if (
    new Set(values).size !== expected.length ||
    expected.some((kind) => !values.includes(kind))
  ) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'must contain exactly one entry for every source fact kind',
    });
  }
}
