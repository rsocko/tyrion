import { z } from 'zod';
import type { InsightOccurrenceSummaryV1 } from '../contracts/occurrence-v1.js';
import {
  amountMinorSchema,
  contractVersionSchema,
  currencySchema,
  merchantKeySchema,
  nonNegativeAmountMinorSchema,
  nonNegativeBasisPointsSchema,
  parseContractV1,
  positiveSequenceSchema,
  sourceReferenceSchema,
  timezoneSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
} from '../contracts/primitives.js';

export const FINANCE_INSIGHT_POLICY_MODEL_VERSION_V1 = 'finance-policy-v1' as const;
export const FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1 = 'detectors-v1' as const;

const uniqueSourceRefsSchema = z
  .array(sourceReferenceSchema)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'must contain unique values');

const uniqueMerchantKeysSchema = z
  .array(merchantKeySchema)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'must contain unique values');

const largeTransactionScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('transaction'),
    sourceRef: sourceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('merchant'),
    sourceRef: merchantKeySchema,
  }),
  z.strictObject({
    kind: z.literal('category'),
    sourceRef: sourceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('account'),
    sourceRef: sourceReferenceSchema,
  }),
]);

const uniqueLargeTransactionScopesSchema = z
  .array(largeTransactionScopeSchema)
  .max(500)
  .refine(
    (values) =>
      new Set(values.map((value) => `${value.kind}:${value.sourceRef}`)).size ===
      values.length,
    'must contain unique scopes'
  );

export const financeInsightPolicySnapshotSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  policyModelVersion: z.literal(FINANCE_INSIGHT_POLICY_MODEL_VERSION_V1),
  detectorSetVersion: z.literal(FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1),
  policyVersion: positiveSequenceSchema,
  effectiveAt: utcTimestampSchema,
  currency: currencySchema,
  timezone: timezoneSchema,
  featureGates: z.strictObject({
    recurringAmountAnalysis: z.boolean(),
    recurringAmountNotifications: z.boolean(),
    largeTransactionAnalysis: z.boolean(),
    varianceAnalysis: z.boolean(),
    immediateLargeTransactionNotifications: z.boolean(),
    monthlyMoverDigestNotifications: z.boolean(),
    confirmedActions: z.boolean(),
  }),
  sourceClassification: z.strictObject({
    classifierVersion: versionIdentifierSchema,
    transferCategoryRefs: uniqueSourceRefsSchema,
    transferTagRefs: uniqueSourceRefsSchema,
    incomeCategoryRefs: uniqueSourceRefsSchema,
    incomeTagRefs: uniqueSourceRefsSchema,
    refundCategoryRefs: uniqueSourceRefsSchema,
    refundTagRefs: uniqueSourceRefsSchema,
    excludedCategoryRefs: uniqueSourceRefsSchema,
    excludedTagRefs: uniqueSourceRefsSchema,
  }),
  recurringAmount: z.strictObject({
    absoluteGateMinor: nonNegativeAmountMinorSchema,
    relativeGateBasisPoints: nonNegativeBasisPointsSchema,
    alertDirection: z.literal('increaseOnly'),
    adjacentMonthWindow: z.literal(1),
    historyMonths: z.literal(37),
    minimumSeasonalYears: z.literal(2),
    scaledMadMultiplierMilli: z.number().int().positive().max(20_000),
    minimumSpreadMinor: nonNegativeAmountMinorSchema,
  }),
  largeTransaction: z.strictObject({
    explicitRuleMinor: nonNegativeAmountMinorSchema,
    adaptiveMeaningfulDollarFloorMinor: nonNegativeAmountMinorSchema,
    adaptiveMinimumAgreement: z.literal(2),
    eligibleDimensions: z
      .tuple([
        z.literal('merchant'),
        z.literal('category'),
        z.literal('account'),
        z.literal('household'),
      ]),
    historyWindowDays: z.number().int().positive().max(3_660),
    minimumBaselineSampleCount: z.number().int().positive().max(1_000),
    robustDeviationMultiplierMilli: z.number().int().positive().max(20_000),
    minimumSpreadMinor: nonNegativeAmountMinorSchema,
    empiricalPercentileGateBasisPoints: z.number().int().min(0).max(10_000),
    ratioGateBasisPoints: nonNegativeBasisPointsSchema,
    highSeverityAmountMinor: nonNegativeAmountMinorSchema,
    publicationLimit: z.number().int().positive().max(100),
    lifecycleTransitionLimit: z.number().int().positive().max(1_000),
    approvedMerchantKeys: uniqueMerchantKeysSchema,
    expectedScopes: uniqueLargeTransactionScopesSchema,
    suppressedScopes: uniqueLargeTransactionScopesSchema,
  }),
  variance: z.strictObject({
    absoluteGateMinor: nonNegativeAmountMinorSchema,
    relativeGateBasisPoints: nonNegativeBasisPointsSchema,
    robustDeviationMilli: z.number().int().positive().max(20_000),
    historyMonths: z.number().int().min(3).max(24),
    minimumActiveMonths: z.number().int().min(1).max(24),
    sufficientActiveMonths: z.number().int().min(1).max(24),
    minimumBaselineTransactions: z.number().int().min(1).max(10_000),
    minimumCurrentTransactions: z.number().int().min(1).max(1_000),
    minimumSpreadMinor: amountMinorSchema.positive(),
    persistentOccurrenceLimit: z.literal(10),
    digestMemberLimit: z.literal(10),
    contributorLimit: z.literal(10),
    notifyingMinimumConfidence: z.literal('high'),
  }).superRefine((value, context) => {
    if (value.minimumActiveMonths > value.sufficientActiveMonths) {
      context.addIssue({
        code: 'custom',
        path: ['minimumActiveMonths'],
        message: 'must not exceed sufficientActiveMonths',
      });
    }
    if (value.sufficientActiveMonths > value.historyMonths) {
      context.addIssue({
        code: 'custom',
        path: ['sufficientActiveMonths'],
        message: 'must not exceed historyMonths',
      });
    }
  }),
  freshness: z.strictObject({
    newAlertMaxAgeHours: z.literal(48),
  }),
  delivery: z.strictObject({
    largeTransaction: z.literal('immediate'),
    monthlyDigestDay: z.literal(2),
    monthlyDigestLocalHour: z.literal(9),
    monthlyDigestLocalMinute: z.literal(0),
    mediumConfidenceMoversNotify: z.literal(false),
  }),
  suppression: z.strictObject({
    operator: z.literal('fixedLocalOperator'),
    allowedDurationsDays: z.tuple([
      z.literal(30),
      z.literal(90),
      z.literal(180),
    ]),
    permanentAllowed: z.literal(false),
    undoRequired: z.literal(true),
  }),
  materialChange: z.strictObject({
    amountBoundaryMinor: amountMinorSchema.positive(),
    classificationChangeIsMaterial: z.literal(true),
    correctionCreatesSuccessor: z.literal(true),
  }),
});

export type FinanceInsightPolicySnapshotV1 = Readonly<
  z.infer<typeof financeInsightPolicySnapshotSchema>
>;

export interface CandidatePolicyOptionsV1 {
  policyVersion: number;
  effectiveAt: string;
  currency: string;
  timezone: string;
}

export function createCandidatePolicySnapshotV1(
  options: CandidatePolicyOptionsV1
): FinanceInsightPolicySnapshotV1 {
  return parseFinanceInsightPolicySnapshotV1({
    contractVersion: '1.0',
    policyModelVersion: FINANCE_INSIGHT_POLICY_MODEL_VERSION_V1,
    detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
    policyVersion: options.policyVersion,
    effectiveAt: options.effectiveAt,
    currency: options.currency,
    timezone: options.timezone,
    featureGates: {
      recurringAmountAnalysis: false,
      recurringAmountNotifications: false,
      largeTransactionAnalysis: false,
      varianceAnalysis: false,
      immediateLargeTransactionNotifications: false,
      monthlyMoverDigestNotifications: false,
      confirmedActions: false,
    },
    sourceClassification: {
      classifierVersion: 'classifier-v1',
      transferCategoryRefs: [],
      transferTagRefs: [],
      incomeCategoryRefs: [],
      incomeTagRefs: [],
      refundCategoryRefs: [],
      refundTagRefs: [],
      excludedCategoryRefs: [],
      excludedTagRefs: [],
    },
    recurringAmount: {
      absoluteGateMinor: 7_000,
      relativeGateBasisPoints: 2_500,
      alertDirection: 'increaseOnly',
      adjacentMonthWindow: 1,
      historyMonths: 37,
      minimumSeasonalYears: 2,
      scaledMadMultiplierMilli: 3_000,
      minimumSpreadMinor: 1_000,
    },
    largeTransaction: {
      explicitRuleMinor: 100_000,
      adaptiveMeaningfulDollarFloorMinor: 15_000,
      adaptiveMinimumAgreement: 2,
      eligibleDimensions: ['merchant', 'category', 'account', 'household'],
      historyWindowDays: 365,
      minimumBaselineSampleCount: 5,
      robustDeviationMultiplierMilli: 3_000,
      minimumSpreadMinor: 1_000,
      empiricalPercentileGateBasisPoints: 9_000,
      ratioGateBasisPoints: 20_000,
      highSeverityAmountMinor: 250_000,
      publicationLimit: 50,
      lifecycleTransitionLimit: 100,
      approvedMerchantKeys: [],
      expectedScopes: [],
      suppressedScopes: [],
    },
    variance: {
      absoluteGateMinor: 15_000,
      relativeGateBasisPoints: 3_000,
      robustDeviationMilli: 3_000,
      historyMonths: 6,
      minimumActiveMonths: 3,
      sufficientActiveMonths: 6,
      minimumBaselineTransactions: 3,
      minimumCurrentTransactions: 1,
      minimumSpreadMinor: 5_000,
      persistentOccurrenceLimit: 10,
      digestMemberLimit: 10,
      contributorLimit: 10,
      notifyingMinimumConfidence: 'high',
    },
    freshness: {
      newAlertMaxAgeHours: 48,
    },
    delivery: {
      largeTransaction: 'immediate',
      monthlyDigestDay: 2,
      monthlyDigestLocalHour: 9,
      monthlyDigestLocalMinute: 0,
      mediumConfidenceMoversNotify: false,
    },
    suppression: {
      operator: 'fixedLocalOperator',
      allowedDurationsDays: [30, 90, 180],
      permanentAllowed: false,
      undoRequired: true,
    },
    materialChange: {
      amountBoundaryMinor: 1_000,
      classificationChangeIsMaterial: true,
      correctionCreatesSuccessor: true,
    },
  });
}

export function parseFinanceInsightPolicySnapshotV1(
  value: unknown
): FinanceInsightPolicySnapshotV1 {
  const parsed = parseContractV1(
    financeInsightPolicySnapshotSchema,
    value,
    'finance insight policy snapshot'
  );
  return deepFreeze(parsed);
}

export function createNextPolicySnapshotV1(
  previous: FinanceInsightPolicySnapshotV1,
  candidate: unknown
): FinanceInsightPolicySnapshotV1 {
  const current = parseFinanceInsightPolicySnapshotV1(previous);
  const next = parseFinanceInsightPolicySnapshotV1(candidate);
  if (next.policyVersion !== current.policyVersion + 1) {
    throw new RangeError('policyVersion must increase by exactly one');
  }
  if (Date.parse(next.effectiveAt) <= Date.parse(current.effectiveAt)) {
    throw new RangeError('effectiveAt must increase with policyVersion');
  }
  return next;
}

export function notificationEligibilityV1(
  occurrence: InsightOccurrenceSummaryV1,
  policy: FinanceInsightPolicySnapshotV1
): boolean {
  if (
    occurrence.analysisState !== 'qualified' ||
    occurrence.sourceLifecycle !== 'open' ||
    occurrence.freshness.state !== 'fresh' ||
    occurrence.provenance.completeness !== 'complete' ||
    Date.parse(occurrence.provenance.evaluationCompletedAt) -
      Date.parse(occurrence.provenance.sourceAsOf) >
      policy.freshness.newAlertMaxAgeHours * 60 * 60 * 1_000 ||
    Date.parse(occurrence.provenance.sourceAsOf) >
      Date.parse(occurrence.provenance.evaluationCompletedAt)
  ) {
    return false;
  }
  if (occurrence.kind === 'largeTransaction') {
    return (
      policy.featureGates.immediateLargeTransactionNotifications &&
      (occurrence.baselineSufficiency !== 'insufficient' ||
        occurrence.reasonCodes.includes('explicit_amount_rule_exceeded'))
    );
  }
  if (occurrence.kind === 'recurringAmountChange') {
    return (
      policy.featureGates.recurringAmountNotifications &&
      occurrence.baselineSufficiency !== 'insufficient' &&
      !occurrence.reasonCodes.includes('recurring_decrease_analysis_only')
    );
  }
  if (
    occurrence.kind === 'categoryVariance' ||
    occurrence.kind === 'merchantVariance'
  ) {
    return (
      policy.featureGates.monthlyMoverDigestNotifications &&
      occurrence.baselineSufficiency !== 'insufficient' &&
      occurrence.confidence === policy.variance.notifyingMinimumConfidence
    );
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
