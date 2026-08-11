import { z } from 'zod';
import {
  calendarDateSchema,
  currencySchema,
  normalizedDisplayNameSchema,
  sourceReferenceSchema,
  utcTimestampSchema,
} from '../contracts/primitives.js';

export const FINANCE_INQUIRY_MAX_AGE_HOURS = 48;
export const FINANCE_INQUIRY_MAX_OUTPUT_BYTES = 64 * 1024;
export const FINANCE_INQUIRY_MAX_ANALYSIS_ROWS = 5_000;

export const financeToolNameSchema = z.enum([
  'finance_get_status',
  'finance_search_transactions',
  'finance_get_transaction',
  'finance_analyze_spending',
  'finance_get_recurring_obligations',
  'finance_get_budget_status',
  'finance_get_pending_exceptions',
]);

const sourceRefSchema = sourceReferenceSchema;
const displayTextSchema = normalizedDisplayNameSchema;
const calendarMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const optionalDateRangeShape = {
  startDate: calendarDateSchema.optional(),
  endDate: calendarDateSchema.optional(),
};

function boundedDateRange<T extends z.ZodRawShape>(shape: T, maxDays: number) {
  return z.strictObject(shape).superRefine((value, context) => {
    const dateRange = value as { startDate?: string; endDate?: string };
    const startDate = dateRange.startDate;
    const endDate = dateRange.endDate;
    if (startDate !== undefined && endDate !== undefined) {
      const days =
        (Date.parse(`${endDate}T00:00:00.000Z`) -
          Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000;
      if (days < 0) {
        context.addIssue({
          code: 'custom',
          path: ['endDate'],
          message: 'must be on or after startDate',
        });
      } else if (days > maxDays) {
        context.addIssue({
          code: 'custom',
          path: ['endDate'],
          message: `date range cannot exceed ${maxDays} days`,
        });
      }
    }
  });
}

export const financeGetStatusInputSchema = z.strictObject({});

export const financeSearchTransactionsInputSchema = boundedDateRange(
  {
    ...optionalDateRangeShape,
    merchant: z.string().trim().min(1).max(80).optional(),
    categoryRef: sourceRefSchema.optional(),
    accountRef: sourceRefSchema.optional(),
    kidRef: sourceRefSchema.optional(),
    amountMinorMin: z.number().int().min(-100_000_000_000).optional(),
    amountMinorMax: z.number().int().max(100_000_000_000).optional(),
    pending: z.boolean().optional(),
    recurring: z.boolean().optional(),
    reviewState: z.enum(['none', 'pending', 'resolved']).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  },
  366
).superRefine((value, context) => {
  if (
    value.amountMinorMin !== undefined &&
    value.amountMinorMax !== undefined &&
    value.amountMinorMax < value.amountMinorMin
  ) {
    context.addIssue({
      code: 'custom',
      path: ['amountMinorMax'],
      message: 'must be greater than or equal to amountMinorMin',
    });
  }
});

export const financeGetTransactionInputSchema = z.strictObject({
  transactionRef: sourceRefSchema,
  requireFresh: z.boolean().default(false),
});

export const financeAnalyzeSpendingInputSchema = boundedDateRange(
  {
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    compareStartDate: calendarDateSchema.optional(),
    compareEndDate: calendarDateSchema.optional(),
    groupBy: z.enum(['merchant', 'category', 'account', 'kid']),
    categoryRef: sourceRefSchema.optional(),
    accountRef: sourceRefSchema.optional(),
    kidRef: sourceRefSchema.optional(),
    includePending: z.boolean().default(false),
    contributorLimit: z.number().int().min(1).max(20).default(5),
  },
  366
).superRefine((value, context) => {
  const hasCompareStart = value.compareStartDate !== undefined;
  const hasCompareEnd = value.compareEndDate !== undefined;
  if (hasCompareStart !== hasCompareEnd) {
    context.addIssue({
      code: 'custom',
      path: [hasCompareStart ? 'compareEndDate' : 'compareStartDate'],
      message: 'comparison dates must be supplied together',
    });
    return;
  }
  if (value.compareStartDate !== undefined && value.compareEndDate !== undefined) {
    const days =
      (Date.parse(`${value.compareEndDate}T00:00:00.000Z`) -
        Date.parse(`${value.compareStartDate}T00:00:00.000Z`)) /
      86_400_000;
    if (days < 0 || days > 366) {
      context.addIssue({
        code: 'custom',
        path: ['compareEndDate'],
        message: 'comparison date range must be ordered and cannot exceed 366 days',
      });
    }
  }
});

export const financeGetRecurringInputSchema = z.strictObject({
  activeOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(50),
});

export const financeGetBudgetStatusInputSchema = z.strictObject({
  period: calendarMonthSchema.optional(),
  warningsOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
});

export const financeGetPendingExceptionsInputSchema = z.strictObject({
  kinds: z
    .array(
      z.enum([
        'attribution',
        'anomaly',
        'reconciliation',
        'writeBack',
        'policy',
      ])
    )
    .max(5)
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const financeToolInputSchemas = Object.freeze({
  finance_get_status: financeGetStatusInputSchema,
  finance_search_transactions: financeSearchTransactionsInputSchema,
  finance_get_transaction: financeGetTransactionInputSchema,
  finance_analyze_spending: financeAnalyzeSpendingInputSchema,
  finance_get_recurring_obligations: financeGetRecurringInputSchema,
  finance_get_budget_status: financeGetBudgetStatusInputSchema,
  finance_get_pending_exceptions: financeGetPendingExceptionsInputSchema,
});

export const datasetSnapshotSchema = z
  .strictObject({
    sourceAsOf: utcTimestampSchema.nullable(),
    coverageStart: calendarDateSchema.nullable(),
    coverageEnd: calendarDateSchema.nullable(),
    completeness: z.enum(['complete', 'partial', 'unavailable']),
  })
  .superRefine((value, context) => {
    if (
      value.coverageStart !== null &&
      value.coverageEnd !== null &&
      value.coverageEnd < value.coverageStart
    ) {
      context.addIssue({
        code: 'custom',
        path: ['coverageEnd'],
        message: 'must be on or after coverageStart',
      });
    }
    if (value.completeness === 'unavailable' && value.sourceAsOf !== null) {
      context.addIssue({
        code: 'custom',
        path: ['sourceAsOf'],
        message: 'must be null when unavailable',
      });
    }
  });

export const transactionInquiryRecordSchema = z.strictObject({
  transactionRef: sourceRefSchema,
  occurredOn: calendarDateSchema,
  amountMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  currency: currencySchema,
  merchantName: displayTextSchema,
  categoryRef: sourceRefSchema.nullable(),
  categoryName: displayTextSchema.nullable(),
  accountRef: sourceRefSchema.nullable(),
  accountName: displayTextSchema.nullable(),
  pending: z.boolean(),
  recurring: z.boolean(),
  classification: z.enum([
    'postedSpend',
    'pending',
    'transfer',
    'income',
    'refund',
    'unclassifiedCredit',
    'knownRecurring',
    'policyExcluded',
  ]),
  reviewState: z.enum(['none', 'pending', 'resolved']),
  kidRef: sourceRefSchema.nullable(),
  kidName: displayTextSchema.nullable(),
  attributionExplanation: z.string().trim().min(1).max(240).nullable(),
});

export const recurringInquiryRecordSchema = z.strictObject({
  recurringRef: sourceRefSchema,
  displayName: displayTextSchema,
  amountMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000).nullable(),
  currency: currencySchema,
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
  active: z.boolean(),
  materialChange: z.string().trim().min(1).max(240).nullable(),
});

export const budgetInquiryRecordSchema = z.strictObject({
  budgetRef: sourceRefSchema,
  period: calendarMonthSchema,
  categoryName: displayTextSchema,
  budgetedMinor: z.number().int().min(0).max(100_000_000_000),
  spentMinor: z.number().int().min(0).max(100_000_000_000),
  remainingMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  currency: currencySchema,
  status: z.enum(['onTrack', 'warning', 'over']),
});

export const exceptionInquiryRecordSchema = z.strictObject({
  exceptionRef: sourceRefSchema,
  kind: z.enum([
    'attribution',
    'anomaly',
    'reconciliation',
    'writeBack',
    'policy',
  ]),
  title: displayTextSchema,
  summary: z.string().trim().min(1).max(320),
  occurredAt: utcTimestampSchema,
  severity: z.enum(['info', 'medium', 'high']),
  actionable: z.boolean(),
});

export type FinanceToolName = z.infer<typeof financeToolNameSchema>;
export type FinanceSearchTransactionsInput = z.infer<
  typeof financeSearchTransactionsInputSchema
>;
export type FinanceAnalyzeSpendingInput = z.infer<
  typeof financeAnalyzeSpendingInputSchema
>;
export type DatasetSnapshot = z.infer<typeof datasetSnapshotSchema>;
export type TransactionInquiryRecord = z.infer<
  typeof transactionInquiryRecordSchema
>;
export type RecurringInquiryRecord = z.infer<typeof recurringInquiryRecordSchema>;
export type BudgetInquiryRecord = z.infer<typeof budgetInquiryRecordSchema>;
export type ExceptionInquiryRecord = z.infer<typeof exceptionInquiryRecordSchema>;

export type FinanceFactDerivation =
  | 'viaMonarch'
  | 'derivedByTyrion'
  | 'calculatedByMissionControl';
export type FinanceFreshnessState =
  | 'fresh'
  | 'stale'
  | 'partial'
  | 'unavailable';

export interface FinanceInquiryMetadata {
  source: 'missionControlProjection';
  derivation: FinanceFactDerivation;
  asOf: string | null;
  coverage: {
    start: string | null;
    end: string | null;
  };
  freshness: FinanceFreshnessState;
  warnings: readonly string[];
}

export interface FinanceInquiryResult<T> {
  tool: FinanceToolName;
  metadata: FinanceInquiryMetadata;
  data: T;
}
