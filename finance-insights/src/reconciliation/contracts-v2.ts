import { z } from 'zod';
import {
  calendarDateSchema,
  currencySchema,
  normalizedDisplayNameSchema,
  normalizedMerchantNameSchema,
  parseContractV1,
  sourceReferenceSchema,
  utcTimestampSchema,
} from '../contracts/primitives.js';
import {
  BILL_MATCH_DEFAULT_CANDIDATE_LIMIT_V1,
  BILL_MATCH_DEFAULT_DATE_WINDOW_DAYS_V1,
  BILL_MATCH_MAX_CANDIDATE_LIMIT_V1,
  BILL_MATCH_MAX_DATE_WINDOW_DAYS_V1,
  billMatchSignalSchemaV1,
} from './contracts-v1.js';

export const BILL_MATCH_CONTRACT_VERSION_V2 = '2.0' as const;
export const BILL_MATCH_MAX_DERIVED_AMOUNT_TOLERANCE_MINOR_V2 = 2_000_000_000;

export const billMatchReceiptEvidenceSchemaV2 = z.strictObject({
  transactionRef: sourceReferenceSchema,
  observedAt: utcTimestampSchema,
});

export const billMatchRequestSchemaV2 = z
  .strictObject({
    contractVersion: z.literal(BILL_MATCH_CONTRACT_VERSION_V2),
    requestRef: sourceReferenceSchema,
    billRef: sourceReferenceSchema,
    payee: normalizedMerchantNameSchema,
    expectedAmountMinor: z
      .number()
      .int()
      .safe()
      .positive()
      .max(100_000_000_000),
    currency: currencySchema,
    dueDate: calendarDateSchema.optional(),
    billDate: calendarDateSchema.optional(),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(
        /^[^\u0000-\u001f\u007f-\u009f]+$/,
        'contains control characters'
      )
      .optional(),
    accountScope: z.literal('configuredEligible'),
    dateWindowDays: z
      .number()
      .int()
      .min(0)
      .max(BILL_MATCH_MAX_DATE_WINDOW_DAYS_V1)
      .default(BILL_MATCH_DEFAULT_DATE_WINDOW_DAYS_V1),
    amountToleranceMinor: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(1_000_000)
      .optional(),
    candidateLimit: z
      .number()
      .int()
      .min(1)
      .max(BILL_MATCH_MAX_CANDIDATE_LIMIT_V1)
      .default(BILL_MATCH_DEFAULT_CANDIDATE_LIMIT_V1),
    receiptEvidence: billMatchReceiptEvidenceSchemaV2.optional(),
  })
  .superRefine((value, context) => {
    if (value.dueDate === undefined && value.billDate === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'dueDate or billDate is required',
      });
    }
  });

export const billMatchReceiptAssociationSchemaV2 = z.strictObject({
  status: z.enum(['linked', 'differentTransaction']),
  observedAt: utcTimestampSchema,
});

export const billMatchCandidateSchemaV2 = z.strictObject({
  rank: z.number().int().min(1).max(BILL_MATCH_MAX_CANDIDATE_LIMIT_V1),
  transactionRef: sourceReferenceSchema,
  transactionDate: calendarDateSchema,
  transactionState: z.enum(['posted', 'pending']),
  payee: normalizedMerchantNameSchema,
  amountMinor: z.number().int().safe().min(-100_000_000_000).max(100_000_000_000),
  currency: currencySchema,
  accountDisplayName: normalizedDisplayNameSchema,
  accountLastFour: z.string().regex(/^[0-9]{4}$/).nullable(),
  scoreBasisPoints: z.number().int().min(0).max(10_000),
  confidence: z.enum(['high', 'medium', 'low']),
  scoreGapBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  signals: z.array(billMatchSignalSchemaV1).length(4),
  receiptAssociation: billMatchReceiptAssociationSchemaV2.optional(),
});

export const billMatchSearchContextSchemaV2 = z.strictObject({
  anchorDate: calendarDateSchema,
  windowStart: calendarDateSchema,
  windowEnd: calendarDateSchema,
  dateWindowDays: z.number().int().min(0).max(BILL_MATCH_MAX_DATE_WINDOW_DAYS_V1),
  amountToleranceMinor: z
    .number()
    .int()
    .safe()
    .min(0)
    .max(BILL_MATCH_MAX_DERIVED_AMOUNT_TOLERANCE_MINOR_V2),
  sourceAsOf: utcTimestampSchema,
  searchedAt: utcTimestampSchema,
  eligibleAccountCount: z.number().int().min(0).max(1_000),
  candidatePoolSize: z.number().int().min(0).max(100_000),
});

export const billMatchResponseSchemaV2 = z
  .strictObject({
    contractVersion: z.literal(BILL_MATCH_CONTRACT_VERSION_V2),
    requestRef: sourceReferenceSchema,
    billRef: sourceReferenceSchema,
    matchStatus: z.enum(['matched', 'noMatch', 'ambiguous']),
    paymentStatus: z.enum(['paid', 'pending', 'unmatched', 'ambiguous']),
    selectedTransactionRef: sourceReferenceSchema.nullable(),
    candidates: z
      .array(billMatchCandidateSchemaV2)
      .max(BILL_MATCH_MAX_CANDIDATE_LIMIT_V1),
    searchContext: billMatchSearchContextSchemaV2,
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

export type BillMatchRequestV2 = z.infer<typeof billMatchRequestSchemaV2>;
export type BillMatchCandidateV2 = z.infer<typeof billMatchCandidateSchemaV2>;
export type BillMatchSearchContextV2 = z.infer<
  typeof billMatchSearchContextSchemaV2
>;
export type BillMatchResponseV2 = z.infer<typeof billMatchResponseSchemaV2>;

export function parseBillMatchRequestV2(value: unknown): BillMatchRequestV2 {
  return parseContractV1(billMatchRequestSchemaV2, value, 'bill match request v2');
}

export function parseBillMatchResponseV2(value: unknown): BillMatchResponseV2 {
  return parseContractV1(
    billMatchResponseSchemaV2,
    value,
    'bill match response v2'
  );
}
