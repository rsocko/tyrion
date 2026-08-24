import { z } from 'zod';
import {
  normalizedDisplayNameSchema,
  parseContractV1,
  sourceReferenceSchema,
  utcTimestampSchema,
} from './primitives.js';
import {
  accountLastFourSchema,
  accountTypeSchema,
} from './source-v1.js';

export const DOCUMENT_EXPECTATION_CONTRACT_VERSION_V1 = '1' as const;
export const MAX_DOCUMENT_EXPECTATION_SIGNALS_V1 = 6_000;

export const documentExpectationSeriesRefSchema = z
  .string()
  .regex(/^expectation-v1_[A-Za-z0-9_-]{43}$/);

export const documentExpectationBasisSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/);

const documentExpectationSignalBaseShape = {
  seriesRef: documentExpectationSeriesRefSchema,
  active: z.boolean(),
  displayHint: normalizedDisplayNameSchema,
  cadence: z.null(),
  nextExpectedDate: z.null(),
  confidence: z.number().finite().min(0).max(1),
  basis: z.array(documentExpectationBasisSchema).min(1).max(20),
} as const;

export const documentExpectationSignalSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...documentExpectationSignalBaseShape,
      kind: z.literal('accountStatementCandidate'),
      accountName: normalizedDisplayNameSchema.optional(),
      institutionName: normalizedDisplayNameSchema.optional(),
      accountType: accountTypeSchema.optional(),
      accountLastFour: accountLastFourSchema.optional(),
    }),
    z.strictObject({
      ...documentExpectationSignalBaseShape,
      kind: z.literal('recurringDocumentCandidate'),
    }),
  ])
  .superRefine((value, context) => {
    const expectedBasis =
      value.kind === 'accountStatementCandidate'
        ? value.active
          ? 'active_non_cash_account'
          : 'inactive_non_cash_account'
        : value.active
          ? 'active_recurring_obligation'
          : 'inactive_recurring_obligation';
    if (!value.basis.includes(expectedBasis)) {
      context.addIssue({
        code: 'custom',
        path: ['basis'],
        message: `must include ${expectedBasis}`,
      });
    }
    if (new Set(value.basis).size !== value.basis.length) {
      context.addIssue({
        code: 'custom',
        path: ['basis'],
        message: 'must contain unique reason codes',
      });
    }
  });

export const documentExpectationSignalsSchema = z
  .strictObject({
    contractVersion: z.literal(DOCUMENT_EXPECTATION_CONTRACT_VERSION_V1),
    connectorRef: sourceReferenceSchema,
    sourceGeneration: sourceReferenceSchema,
    sourceAsOf: utcTimestampSchema,
    completeness: z.enum(['complete', 'partial']),
    signals: z
      .array(documentExpectationSignalSchema)
      .max(MAX_DOCUMENT_EXPECTATION_SIGNALS_V1),
  })
  .superRefine((value, context) => {
    const refs = new Set<string>();
    value.signals.forEach((signal, index) => {
      if (refs.has(signal.seriesRef)) {
        context.addIssue({
          code: 'custom',
          path: ['signals', index, 'seriesRef'],
          message: 'must be unique within the projection',
        });
      }
      refs.add(signal.seriesRef);
      if (
        index > 0 &&
        value.signals[index - 1]!.seriesRef >= signal.seriesRef
      ) {
        context.addIssue({
          code: 'custom',
          path: ['signals', index, 'seriesRef'],
          message: 'must be in ascending deterministic order',
        });
      }
    });
  });

export type DocumentExpectationBasisV1 = z.infer<
  typeof documentExpectationBasisSchema
>;
export type DocumentExpectationSignalV1 = z.infer<
  typeof documentExpectationSignalSchema
>;
export type DocumentExpectationSignalsV1 = z.infer<
  typeof documentExpectationSignalsSchema
>;

export function parseDocumentExpectationSignalsV1(
  value: unknown
): DocumentExpectationSignalsV1 {
  return parseContractV1(
    documentExpectationSignalsSchema,
    value,
    'document expectation signals'
  );
}
