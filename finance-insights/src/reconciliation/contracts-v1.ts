import { z } from 'zod';
import {
  calendarDateSchema,
  contractVersionSchema,
  currencySchema,
  normalizedMerchantNameSchema,
  parseContractV1,
  sourceReferenceSchema,
} from '../contracts/primitives.js';

export const BILL_MATCH_DEFAULT_DATE_WINDOW_DAYS_V1 = 7;
export const BILL_MATCH_MAX_DATE_WINDOW_DAYS_V1 = 30;
export const BILL_MATCH_DEFAULT_CANDIDATE_LIMIT_V1 = 5;
export const BILL_MATCH_MAX_CANDIDATE_LIMIT_V1 = 10;

export const billMatchRequestSchemaV1 = z.strictObject({
  contractVersion: contractVersionSchema,
  billRef: sourceReferenceSchema,
  amountMinor: z.number().int().safe().positive().max(100_000_000_000),
  currency: currencySchema,
  dueDate: calendarDateSchema,
  payeeName: normalizedMerchantNameSchema,
  accountRef: sourceReferenceSchema.optional(),
  dateWindowDays: z
    .number()
    .int()
    .min(0)
    .max(BILL_MATCH_MAX_DATE_WINDOW_DAYS_V1)
    .default(BILL_MATCH_DEFAULT_DATE_WINDOW_DAYS_V1),
  amountToleranceMinor: z.number().int().safe().min(0).max(1_000_000).optional(),
  candidateLimit: z
    .number()
    .int()
    .min(1)
    .max(BILL_MATCH_MAX_CANDIDATE_LIMIT_V1)
    .default(BILL_MATCH_DEFAULT_CANDIDATE_LIMIT_V1),
});

export const billMatchSignalSchemaV1 = z.strictObject({
  kind: z.enum(['amount', 'date', 'payee', 'account']),
  strength: z.enum(['exact', 'strong', 'partial', 'none', 'notProvided']),
  contributionBasisPoints: z.number().int().min(0).max(5_500),
});

export const billMatchCandidateSchemaV1 = z.strictObject({
  transactionRef: sourceReferenceSchema,
  transactionDate: calendarDateSchema,
  transactionState: z.enum(['posted', 'pending']),
  scoreBasisPoints: z.number().int().min(0).max(10_000),
  confidence: z.enum(['high', 'medium', 'low']),
  signals: z.array(billMatchSignalSchemaV1).length(4),
});

export const billMatchResponseSchemaV1 = z
  .strictObject({
    contractVersion: contractVersionSchema,
    billRef: sourceReferenceSchema,
    matchStatus: z.enum(['matched', 'noMatch', 'ambiguous']),
    paymentStatus: z.enum(['paid', 'pending', 'unmatched', 'ambiguous']),
    selectedTransactionRef: sourceReferenceSchema.nullable(),
    candidates: z
      .array(billMatchCandidateSchemaV1)
      .max(BILL_MATCH_MAX_CANDIDATE_LIMIT_V1),
  })
  .superRefine((value, context) => {
    const matched = value.matchStatus === 'matched';
    if (matched !== (value.selectedTransactionRef !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['selectedTransactionRef'],
        message: 'must be present exactly when matchStatus is matched',
      });
    }
    if (
      (value.matchStatus === 'noMatch' && value.paymentStatus !== 'unmatched') ||
      (value.matchStatus === 'ambiguous' &&
        value.paymentStatus !== 'ambiguous') ||
      (matched && !['paid', 'pending'].includes(value.paymentStatus))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['paymentStatus'],
        message: 'must agree with matchStatus',
      });
    }
    if (
      value.selectedTransactionRef !== null &&
      value.candidates[0]?.transactionRef !== value.selectedTransactionRef
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selectedTransactionRef'],
        message: 'must identify the first ranked candidate',
      });
    }
  });

export type BillMatchRequestV1 = z.infer<typeof billMatchRequestSchemaV1>;
export type BillMatchSignalV1 = z.infer<typeof billMatchSignalSchemaV1>;
export type BillMatchCandidateV1 = z.infer<typeof billMatchCandidateSchemaV1>;
export type BillMatchResponseV1 = z.infer<typeof billMatchResponseSchemaV1>;

export function parseBillMatchRequestV1(value: unknown): BillMatchRequestV1 {
  return parseContractV1(billMatchRequestSchemaV1, value, 'bill match request v1');
}

export function parseBillMatchResponseV1(value: unknown): BillMatchResponseV1 {
  return parseContractV1(
    billMatchResponseSchemaV1,
    value,
    'bill match response v1'
  );
}
