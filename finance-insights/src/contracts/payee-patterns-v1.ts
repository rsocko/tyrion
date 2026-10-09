import { z } from 'zod';
import {
  calendarDateSchema,
  normalizedMerchantNameSchema,
  parseContractV1,
  sourceReferenceSchema,
  utcTimestampSchema,
} from './primitives.js';

export const PAYEE_PATTERN_CONTRACT_VERSION_V1 = '1' as const;
export const MAX_PAYEE_PATTERNS_V1 = 10_000;

export const payeeRefSchema = z
  .string()
  .regex(/^payee-v1_[A-Za-z0-9_-]{43}$/);

export const payeeFinancialClassificationSchema = z.enum([
  'recurring-fixed',
  'recurring-variable',
  'regular',
  'infrequent',
  'single-observation',
  'unknown',
]);

export const payeePatternBasisSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/);

export const payeePatternSchema = z.strictObject({
  payeeRef: payeeRefSchema,
  displayName: normalizedMerchantNameSchema,
  activity: z.enum(['active', 'inactive', 'unknown']),
  classification: payeeFinancialClassificationSchema,
  observationCount: z.number().int().safe().positive().max(50_000),
  observationWindow: z.strictObject({
    firstObservedOn: calendarDateSchema,
    lastObservedOn: calendarDateSchema,
  }),
  intervalEvidence: z
    .strictObject({
      sampleCount: z.number().int().safe().positive().max(49_999),
      medianDays: z.number().int().safe().positive().max(36_600),
      minimumDays: z.number().int().safe().positive().max(36_600),
      maximumDays: z.number().int().safe().positive().max(36_600),
    })
    .nullable(),
  confidence: z.number().finite().min(0).max(1),
  basis: z.array(payeePatternBasisSchema).min(1).max(20),
  provenance: z.strictObject({
    transactionHistory: z.literal(true),
    monarchRecurring: z.boolean(),
  }),
  monarchConfirmedRecurring: z
    .strictObject({
      active: z.boolean().nullable(),
      cadence: z.enum([
        'weekly',
        'biweekly',
        'monthly',
        'quarterly',
        'semiannual',
        'annual',
        'unknown',
      ]),
    })
    .nullable(),
});

export const payeePatternProjectionSchema = z
  .strictObject({
    contractVersion: z.literal(PAYEE_PATTERN_CONTRACT_VERSION_V1),
    connectorRef: sourceReferenceSchema,
    sourceGeneration: sourceReferenceSchema,
    sourceAsOf: utcTimestampSchema,
    completeness: z.enum(['complete', 'partial']),
    payees: z.array(payeePatternSchema).max(MAX_PAYEE_PATTERNS_V1),
  })
  .superRefine((value, context) => {
    value.payees.forEach((payee, index) => {
      if (payee.observationWindow.firstObservedOn > payee.observationWindow.lastObservedOn) {
        context.addIssue({
          code: 'custom',
          path: ['payees', index, 'observationWindow'],
          message: 'must be chronologically ordered',
        });
      }
      if (new Set(payee.basis).size !== payee.basis.length) {
        context.addIssue({
          code: 'custom',
          path: ['payees', index, 'basis'],
          message: 'must contain unique reason codes',
        });
      }
      if (
        payee.provenance.monarchRecurring !==
        (payee.monarchConfirmedRecurring !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['payees', index, 'provenance', 'monarchRecurring'],
          message: 'must match recurring evidence availability',
        });
      }
      if (
        index > 0 &&
        value.payees[index - 1]!.payeeRef >= payee.payeeRef
      ) {
        context.addIssue({
          code: 'custom',
          path: ['payees', index, 'payeeRef'],
          message: 'must be in ascending deterministic order',
        });
      }
    });
  });

export type PayeeFinancialClassificationV1 = z.infer<
  typeof payeeFinancialClassificationSchema
>;
export type PayeePatternV1 = z.infer<typeof payeePatternSchema>;
export type PayeePatternProjectionV1 = z.infer<
  typeof payeePatternProjectionSchema
>;

export function parsePayeePatternProjectionV1(
  value: unknown
): PayeePatternProjectionV1 {
  return parseContractV1(
    payeePatternProjectionSchema,
    value,
    'payee pattern projection'
  );
}
