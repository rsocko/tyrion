import { z } from 'zod';
import {
  normalizedDisplayNameSchema,
  parseContractV1,
  sourceReferenceSchema,
  utcTimestampSchema,
} from './primitives.js';

export const DOCUMENT_EXPECTATION_CONTRACT_VERSION_V1 = '1' as const;
export const MAX_DOCUMENT_EXPECTATION_SIGNALS_V1 = 6_000;

export const documentExpectationSeriesRefSchema = z
  .string()
  .regex(/^expectation-v1_[A-Za-z0-9_-]{43}$/);

export const documentExpectationBasisSchema = z.enum([
  'active_non_cash_account',
  'inactive_non_cash_account',
  'active_recurring_obligation',
  'inactive_recurring_obligation',
]);

export const documentExpectationSignalSchema = z
  .strictObject({
    seriesRef: documentExpectationSeriesRefSchema,
    kind: z.enum([
      'accountStatementCandidate',
      'recurringDocumentCandidate',
    ]),
    active: z.boolean(),
    displayHint: normalizedDisplayNameSchema,
    cadence: z.null(),
    nextExpectedDate: z.null(),
    confidence: z.number().finite().min(0).max(1),
    basis: z.array(documentExpectationBasisSchema).length(1),
  })
  .superRefine((value, context) => {
    const expectedBasis =
      value.kind === 'accountStatementCandidate'
        ? value.active
          ? 'active_non_cash_account'
          : 'inactive_non_cash_account'
        : value.active
          ? 'active_recurring_obligation'
          : 'inactive_recurring_obligation';
    if (value.basis[0] !== expectedBasis) {
      context.addIssue({
        code: 'custom',
        path: ['basis'],
        message: `must contain ${expectedBasis}`,
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
