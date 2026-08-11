import type {
  BaselineSufficiencyV1,
  ConfidenceV1,
  InsightOccurrenceDetailV1,
  ReasonCodeV1,
} from '../contracts/occurrence-v1.js';
import {
  parseInsightOccurrenceDetailV1,
  parseInsightOccurrenceSummaryV1,
} from '../contracts/occurrence-v1.js';
import type { PeriodV1 } from '../contracts/primitives.js';
import {
  MAX_AMOUNT_MINOR_V1,
  parseContractV1,
  sourceReferenceSchema,
} from '../contracts/primitives.js';
import type { TransactionSourceFactV1 } from '../contracts/source-v1.js';
import {
  canonicalDigestV1,
  normalizeIdentityTextV1,
  type CanonicalJsonValue,
} from '../core/canonical.js';
import {
  deriveInsightIdV1,
  deriveMerchantKeyV1,
  deriveOccurrenceIdV1,
  evaluateMaterialChangeV1,
  nextDeliveryRevisionV1,
} from '../core/identity.js';
import type {
  EvaluationPublicationV1,
  OccurrencePublicationV1,
  SourceProjectionV1,
} from '../persistence/sqlite-store.js';
import {
  parseFinanceInsightPolicySnapshotV1,
  type FinanceInsightPolicySnapshotV1,
} from '../policy/v1.js';
import type {
  TransactionClassificationResultV1,
  TransactionClassificationV1,
} from '../projection/classification.js';
import {
  VARIANCE_EXPLANATION_TEMPLATE_VERSION_V1,
  varianceExplanationV1,
  varianceHeadlineV1,
} from './variance-explanations.js';

export const VARIANCE_DETECTOR_VERSION_V1 = 'variance-detector-v1' as const;
export const VARIANCE_METHOD_VERSION_V1 =
  'equivalent-period-median-mad-v1' as const;
export const VARIANCE_SCALED_MAD_NUMERATOR_V1 = 7_413n;
export const VARIANCE_SCALED_MAD_DENOMINATOR_V1 = 5_000n;

const MILLI = 1_000n;
const BASIS_POINTS = 10_000n;
const ZERO_EXCLUSIONS: ExclusionCounts = Object.freeze({
  pending: 0,
  transfer: 0,
  income: 0,
  refund: 0,
  unclassifiedCredit: 0,
  knownRecurring: 0,
  policyExcluded: 0,
});

export interface ClassifiedVarianceTransactionV1
  extends TransactionClassificationResultV1 {
  sourceRef: string;
  policyVersion: number;
}

export interface VarianceMerchantAliasV1 {
  normalizedMerchantKey: string;
  canonicalMerchantKey: string;
  displayName: string;
  aliasVersion: string;
}

export interface VarianceSourceContextV1 {
  connectorRef: string;
  sourceGeneration: string;
  sourceAsOf: string;
  coverageStart: string;
  coverageEnd: string;
  bridgeContractVersion: string;
  completeness: 'complete' | 'partial' | 'unavailable';
}

export interface VarianceEntityClassificationLineageV1 {
  entityKind: 'category' | 'merchant';
  entitySourceRef: string;
  lineage: string;
}

export interface VarianceDigestStateV1 {
  periodStart: string;
  memberSetDigest: string;
  revision: number;
}

export interface VarianceEvaluationInputV1 {
  identityKey: Uint8Array;
  householdScope: string;
  projection: SourceProjectionV1;
  classifications: readonly ClassifiedVarianceTransactionV1[];
  classificationLineages: readonly VarianceEntityClassificationLineageV1[];
  policy: FinanceInsightPolicySnapshotV1;
  source: VarianceSourceContextV1;
  evaluationStartedAt: string;
  evaluationCompletedAt: string;
  observationMonth?: string;
  merchantAliases?: readonly VarianceMerchantAliasV1[];
  previousOccurrences?: readonly OccurrencePublicationV1[];
  previousDigest?: VarianceDigestStateV1 | null;
}

export interface VarianceDigestMemberV1 {
  occurrenceId: string;
  deliveryRevision: number;
  kind: 'categoryVariance' | 'merchantVariance';
  direction: 'increase' | 'decrease';
  absoluteImpactMinor: number;
}

export interface VarianceDigestV1 {
  digestId: string;
  sourceActivityKey: string;
  periodStart: string;
  revision: number;
  memberSetDigest: string;
  scheduledAt: string;
  timezone: string;
  members: readonly VarianceDigestMemberV1[];
  omittedCount: number;
}

export interface VarianceEvaluationResultV1 {
  publication: EvaluationPublicationV1;
  series: readonly InsightOccurrenceDetailV1[];
  digest: VarianceDigestV1 | null;
  observationPeriod: PeriodV1 | null;
  comparisonPeriods: readonly PeriodV1[];
  omittedQualifiedCount: number;
  exclusionSummary: Readonly<Record<TransactionClassificationV1, number>>;
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface MonthPeriod {
  key: string;
  period: PeriodV1;
}

interface ExclusionCounts {
  pending: number;
  transfer: number;
  income: number;
  refund: number;
  unclassifiedCredit: number;
  knownRecurring: number;
  policyExcluded: number;
}

interface EntityBucket {
  key: string;
  kind: 'category' | 'merchant';
  sourceRef: string;
  displayName: string;
  identityQuality: 'stableSource' | 'configuredAlias' | 'normalizedName';
  transactions: Map<string, TransactionSourceFactV1[]>;
  exclusions: ExclusionCounts;
  ambiguousClassificationCount: number;
}

interface Candidate {
  detail: InsightOccurrenceDetailV1;
  qualified: boolean;
  direction: 'increase' | 'decrease';
  absoluteImpactMinor: number;
  robustDeviationMilli: number;
  baselineSufficiency: BaselineSufficiencyV1;
  confidence: ConfidenceV1;
}

export function evaluateVarianceProjectionV1(
  input: VarianceEvaluationInputV1
): VarianceEvaluationResultV1 {
  const policy = parseFinanceInsightPolicySnapshotV1(input.policy);
  validateEvaluationInput(input, policy);
  const periods = evaluationPeriods(
    input.evaluationCompletedAt,
    policy.timezone,
    input.observationMonth,
    policy.variance.historyMonths
  );
  const exclusionSummary = classifyExclusionSummary(
    input,
    periods.observation === null
      ? periods.comparisons
      : [periods.observation, ...periods.comparisons]
  );
  if (
    !policy.featureGates.varianceAnalysis ||
    periods.observation === null ||
    input.source.completeness !== 'complete' ||
    !periodCovered(
      periods.observation.period,
      input.source.coverageStart,
      input.source.coverageEnd
    ) ||
    !sourceIsFresh(input.source.sourceAsOf, input.evaluationCompletedAt, policy)
  ) {
    return emptyResult(periods, exclusionSummary);
  }

  const eligibleComparisons = periods.comparisons.filter((period) =>
    periodCovered(
      period.period,
      input.source.coverageStart,
      input.source.coverageEnd
    )
  );
  const buckets = aggregateEntities(
    input,
    [periods.observation, ...eligibleComparisons]
  );
  const classificationLineages = classificationLineageMap(
    input.classificationLineages
  );
  const previous = validatedPreviousOccurrences(
    input.previousOccurrences ?? []
  ).filter(
    (item) =>
      item.detail.provenance.connectorRef === input.source.connectorRef
  );
  const candidates = [...buckets.values()]
    .map((bucket) =>
      buildCandidate(
        input,
        policy,
        periods.observation!,
        eligibleComparisons,
        bucket,
        classificationLineages,
        previous
      )
    )
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort(compareCandidates);
  const allQualified = candidates.filter((candidate) => candidate.qualified);
  const selected = candidates.slice(0, policy.variance.persistentOccurrenceLimit);
  const selectedQualified = selected.filter((candidate) => candidate.qualified);
  const publicationOccurrences = selected.map((candidate) => ({
    detail: candidate.detail,
    sourceRevisionRef: null,
  }));
  const transitions = buildTransitions(
    previous,
    allQualified,
    selectedQualified,
    periods.observation.period,
    input.evaluationCompletedAt
  );
  const publication: EvaluationPublicationV1 = {
    occurrences: publicationOccurrences,
    transitions,
    exclusionSummary,
  };
  const digest = buildDigest(
    input,
    policy,
    periods.observation.period,
    selectedQualified,
    allQualified.filter((candidate) => candidate.confidence === 'high').length
  );
  return {
    publication,
    series: publicationOccurrences.map((item) => item.detail),
    digest,
    observationPeriod: periods.observation.period,
    comparisonPeriods: eligibleComparisons.map((item) => item.period),
    omittedQualifiedCount: Math.max(0, allQualified.length - selectedQualified.length),
    exclusionSummary,
  };
}

function validateEvaluationInput(
  input: VarianceEvaluationInputV1,
  policy: FinanceInsightPolicySnapshotV1
): void {
  if (input.identityKey.byteLength < 32) {
    throw new RangeError('Variance identity keys must contain at least 32 bytes');
  }
  classificationLineageMap(input.classificationLineages);
  if (input.source.completeness === 'complete' && policy.currency.length !== 3) {
    throw new RangeError('Variance policy currency is invalid');
  }
  const started = Date.parse(input.evaluationStartedAt);
  const completed = Date.parse(input.evaluationCompletedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new RangeError('Variance evaluation timestamps are invalid');
  }
  if (input.source.coverageEnd < input.source.coverageStart) {
    throw new RangeError('Variance source coverage is invalid');
  }
  const transactions = new Set(input.projection.transactions.map((item) => item.sourceRef));
  if (transactions.size !== input.projection.transactions.length) {
    throw new RangeError('Variance projection contains duplicate transaction references');
  }
  const classifications = new Set<string>();
  for (const item of input.classifications) {
    if (
      item.policyVersion !== policy.policyVersion ||
      item.classifierVersion !== policy.sourceClassification.classifierVersion
    ) {
      throw new RangeError('Variance classification version does not match policy');
    }
    if (classifications.has(item.sourceRef) || !transactions.has(item.sourceRef)) {
      throw new RangeError('Variance classifications do not match the projection');
    }
    classifications.add(item.sourceRef);
  }
  if (classifications.size !== transactions.size) {
    throw new RangeError('Variance projection must be classified before evaluation');
  }
}

function aggregateEntities(
  input: VarianceEvaluationInputV1,
  periods: readonly MonthPeriod[]
): Map<string, EntityBucket> {
  const classifications = new Map(
    input.classifications.map((item) => [item.sourceRef, item])
  );
  const categories = new Map(
    input.projection.categories.map((item) => [item.sourceRef, item])
  );
  const aliases = new Map(
    (input.merchantAliases ?? []).map((item) => [
      item.normalizedMerchantKey,
      item,
    ])
  );
  if (aliases.size !== (input.merchantAliases ?? []).length) {
    throw new RangeError('Variance merchant aliases must be unique');
  }
  const buckets = new Map<string, EntityBucket>();
  const orderedTransactions = [...input.projection.transactions].sort((left, right) =>
    left.sourceRef.localeCompare(right.sourceRef)
  );
  for (const transaction of orderedTransactions) {
    const period = periods.find(
      (item) =>
        transaction.occurredOn >= item.period.start &&
        transaction.occurredOn <= item.period.end
    );
    if (!period) continue;
    const classification = classifications.get(transaction.sourceRef)!;
    const category =
      transaction.categoryRef === null
        ? undefined
        : categories.get(transaction.categoryRef);
    if (category) {
      addToBucket(
        buckets,
        {
          key: `category:${category.sourceRef}`,
          kind: 'category',
          sourceRef: category.sourceRef,
          displayName: category.displayName,
          identityQuality: 'stableSource',
        },
        period.key,
        transaction,
        classification.classification,
        false
      );
    }

    const normalizedMerchantName = normalizeIdentityTextV1(transaction.merchantName);
    const normalizedMerchantKey = deriveMerchantKeyV1(
      input.identityKey,
      normalizedMerchantName
    );
    const alias = aliases.get(normalizedMerchantKey);
    addToBucket(
      buckets,
      {
        key: `merchant:${alias?.canonicalMerchantKey ?? normalizedMerchantKey}`,
        kind: 'merchant',
        sourceRef: alias?.canonicalMerchantKey ?? normalizedMerchantKey,
        displayName: boundedDisplayName(alias?.displayName ?? transaction.merchantName),
        identityQuality: alias ? 'configuredAlias' : 'normalizedName',
      },
      period.key,
      transaction,
      classification.classification,
      classification.classification === 'postedSpend' && category === undefined
    );
  }
  return buckets;
}

function addToBucket(
  buckets: Map<string, EntityBucket>,
  identity: Pick<
    EntityBucket,
    'key' | 'kind' | 'sourceRef' | 'displayName' | 'identityQuality'
  >,
  periodKey: string,
  transaction: TransactionSourceFactV1,
  classification: TransactionClassificationV1,
  ambiguous: boolean
): void {
  let bucket = buckets.get(identity.key);
  if (!bucket) {
    bucket = {
      ...identity,
      transactions: new Map(),
      exclusions: { ...ZERO_EXCLUSIONS },
      ambiguousClassificationCount: 0,
    };
    buckets.set(identity.key, bucket);
  }
  if (classification === 'postedSpend') {
    const transactions = bucket.transactions.get(periodKey) ?? [];
    transactions.push(transaction);
    bucket.transactions.set(periodKey, transactions);
    if (ambiguous) bucket.ambiguousClassificationCount += 1;
  } else {
    bucket.exclusions[classification] += 1;
  }
}

function buildCandidate(
  input: VarianceEvaluationInputV1,
  policy: FinanceInsightPolicySnapshotV1,
  observation: MonthPeriod,
  comparisons: readonly MonthPeriod[],
  bucket: EntityBucket,
  classificationLineages: ReadonlyMap<string, string>,
  previous: readonly OccurrencePublicationV1[]
): Candidate | null {
  if (comparisons.length === 0) return null;
  const currentTransactions = bucket.transactions.get(observation.key) ?? [];
  const currentTotal = transactionTotal(currentTransactions);
  const baselineTransactions = comparisons.map(
    (period) => bucket.transactions.get(period.key) ?? []
  );
  const baselineTotals = baselineTransactions.map(transactionTotal);
  const center = medianIntegers(baselineTotals);
  const centerRounded = roundRational(center);
  const delta = subtractRational(integerRational(currentTotal), center);
  if (delta.numerator === 0n) return null;
  const absoluteDelta = absoluteRational(delta);
  const absoluteDeltaMinor = roundRational(absoluteDelta);
  const direction = delta.numerator > 0n ? 'increase' : 'decrease';
  const zeroBaseline = center.numerator === 0n;
  const zeroBaselineAbsence = baselineTotals.every((value) => value === 0);
  const medianAbsoluteDeviation = medianRationals(
    baselineTotals.map((value) =>
      absoluteRational(subtractRational(integerRational(value), center))
    )
  );
  const scaledMad = multiplyRational(medianAbsoluteDeviation, {
    numerator: VARIANCE_SCALED_MAD_NUMERATOR_V1,
    denominator: VARIANCE_SCALED_MAD_DENOMINATOR_V1,
  });
  const dispersion = maxRational(
    scaledMad,
    integerRational(policy.variance.minimumSpreadMinor)
  );
  const dispersionMinor = Math.min(
    MAX_AMOUNT_MINOR_V1,
    roundRational(dispersion)
  );
  const robustDeviationMilli = ratioRoundedBounded(
    absoluteDelta,
    dispersion,
    MILLI,
    1_000_000
  );
  const percentageDeltaBasisPoints = zeroBaseline
    ? null
    : ratioRoundedBounded(delta, center, BASIS_POINTS, 1_000_000);
  const activePeriods = baselineTotals.filter((value) => value > 0).length;
  const baselineTransactionCount = baselineTransactions.reduce(
    (total, items) => total + items.length,
    0
  );
  const baselineSufficiency = sufficiency(
    policy,
    comparisons.length,
    activePeriods,
    baselineTransactionCount,
    currentTransactions.length,
    zeroBaselineAbsence,
    bucket.kind,
    bucket.identityQuality
  );
  const confidence = confidenceFor(
    baselineSufficiency,
    bucket.identityQuality,
    bucket.ambiguousClassificationCount
  );
  const absoluteGate =
    compareRational(
      absoluteDelta,
      integerRational(policy.variance.absoluteGateMinor)
    ) >= 0;
  const relativeGate =
    zeroBaseline ||
    compareRational(
      multiplyRational(absoluteDelta, {
        numerator: BASIS_POINTS,
        denominator: 1n,
      }),
      multiplyRational(absoluteRational(center), {
        numerator: BigInt(policy.variance.relativeGateBasisPoints),
        denominator: 1n,
      })
    ) >= 0;
  const robustGate =
    compareRational(
      multiplyRational(absoluteDelta, {
        numerator: MILLI,
        denominator: 1n,
      }),
      multiplyRational(dispersion, {
        numerator: BigInt(policy.variance.robustDeviationMilli),
        denominator: 1n,
      })
    ) >= 0;
  const currentSampleGate =
    direction === 'decrease' ||
    currentTransactions.length >= policy.variance.minimumCurrentTransactions;
  const qualified =
    baselineSufficiency !== 'insufficient' &&
    absoluteGate &&
    relativeGate &&
    robustGate &&
    currentSampleGate;
  const insufficientAnalysis =
    baselineSufficiency === 'insufficient' &&
    absoluteGate &&
    currentSampleGate &&
    (currentTotal > 0 || baselineTransactionCount > 0);
  if (!qualified && !insufficientAnalysis) return null;

  const insightKind =
    bucket.kind === 'category' ? 'categoryVariance' : 'merchantVariance';
  const insightId = deriveInsightIdV1(input.identityKey, {
    householdScope: input.householdScope,
    kind: insightKind,
    entityKind: bucket.kind,
    entitySourceRef: bucket.sourceRef,
  });
  const occurrenceId = deriveReentrySafeOccurrenceId(
    input.identityKey,
    insightId,
    insightKind,
    observation.key,
    direction,
    requiredClassificationLineage(classificationLineages, bucket),
    previous
  );
  const previousSameOccurrence = previous.find(
    (item) => item.detail.occurrenceId === occurrenceId
  );
  const analysisState = qualified ? 'qualified' : 'insufficientBaseline';
  const deliveryRevision = deliveryRevisionFor(
    previousSameOccurrence?.detail,
    currentTotal,
    analysisState,
    policy
  );
  const createdAt =
    previousSameOccurrence?.detail.createdAt ?? input.evaluationCompletedAt;
  const reasonCodes = reasonCodesFor({
    qualified,
    absoluteGate,
    relativeGate,
    robustGate,
    zeroBaseline,
    confidence,
    minimumSpreadApplied:
      compareRational(
        scaledMad,
        integerRational(policy.variance.minimumSpreadMinor)
      ) < 0,
    normalizedMerchant: bucket.identityQuality === 'normalizedName',
    ambiguousClassification: bucket.ambiguousClassificationCount > 0,
  });
  const expectedRange = expectedRangeFor(center, dispersion, policy);
  const explanationInput = {
    displayName: bucket.displayName,
    entityKind: bucket.kind,
    direction,
    currency: policy.currency,
    observedMinor: currentTotal,
    baselineMinor: centerRounded,
    absoluteDeltaMinor:
      direction === 'increase' ? absoluteDeltaMinor : -absoluteDeltaMinor,
    percentageDeltaBasisPoints,
    baselinePeriods: comparisons.length,
    baselineSufficiency,
    confidence,
    isZeroBaseline: zeroBaseline,
  } as const;
  if (
    !qualified &&
    previousSameOccurrence?.detail.analysisState === 'qualified' &&
    previousSameOccurrence.detail.sourceLifecycle === 'open'
  ) {
    return null;
  }
  const lifecycleHistory = lifecycleFor(
    previousSameOccurrence?.detail,
    analysisState,
    input.evaluationCompletedAt
  );
  const detail = parseInsightOccurrenceDetailV1({
    contractVersion: '1.0',
    insightId,
    occurrenceId,
    deliveryRevision,
    kind: insightKind,
    entity: {
      kind: bucket.kind,
      sourceRef: bucket.sourceRef,
      displayName: bucket.displayName,
      identityQuality: bucket.identityQuality,
    },
    analysisState,
    sourceLifecycle: qualified ? 'open' : null,
    resolutionReason: null,
    supersededByOccurrenceId: null,
    severity:
      qualified &&
      absoluteDeltaMinor >= policy.variance.absoluteGateMinor * 2 &&
      robustDeviationMilli >= policy.variance.robustDeviationMilli * 2
        ? 'high'
        : qualified
          ? 'medium'
          : 'info',
    confidence,
    baselineSufficiency,
    reasonCodes,
    headline: varianceHeadlineV1(explanationInput),
    explanation: varianceExplanationV1(explanationInput),
    observationPeriod: observation.period,
    baselinePeriod: {
      start: comparisons[0]!.period.start,
      end: comparisons.at(-1)!.period.end,
    },
    observedValue: { currency: policy.currency, amountMinor: currentTotal },
    expectedRange: {
      currency: policy.currency,
      lowerMinor: expectedRange.lower,
      upperMinor: expectedRange.upper,
    },
    absoluteDelta: {
      currency: policy.currency,
      amountMinor:
        direction === 'increase' ? absoluteDeltaMinor : -absoluteDeltaMinor,
    },
    percentageDeltaBasisPoints,
    currency: policy.currency,
    freshness: {
      state: 'fresh',
      sourceAsOf: input.source.sourceAsOf,
      maxAgeHours: 48,
      warningReason: null,
    },
    provenance: {
      connectorRef: input.source.connectorRef,
      sourceGeneration: input.source.sourceGeneration,
      bridgeContractVersion: input.source.bridgeContractVersion,
      providerClass: 'monarchBridgeNormalized',
      sourceAsOf: input.source.sourceAsOf,
      coverageStart: input.source.coverageStart,
      coverageEnd: input.source.coverageEnd,
      completeness: 'complete',
      detectorSetVersion: policy.detectorSetVersion,
      detectorVersion: VARIANCE_DETECTOR_VERSION_V1,
      methodVersion: VARIANCE_METHOD_VERSION_V1,
      explanationTemplateVersion: VARIANCE_EXPLANATION_TEMPLATE_VERSION_V1,
      policyVersion: policy.policyVersion,
      evaluationStartedAt: input.evaluationStartedAt,
      evaluationCompletedAt: input.evaluationCompletedAt,
    },
    targets: [
      {
        system: 'monarch',
        targetKind: 'reportFilter',
        reportKind: 'spending',
        period: observation.period,
        categorySourceRef: bucket.kind === 'category' ? bucket.sourceRef : null,
        merchantKey: bucket.kind === 'merchant' ? bucket.sourceRef : null,
      },
      { system: 'monarch', targetKind: 'safeRoot', root: 'reports' },
    ],
    createdAt,
    updatedAt: input.evaluationCompletedAt,
    resolvedAt: null,
    ruleResults: [
      {
        ruleCode: 'variance_absolute_gate',
        outcome: absoluteGate ? 'triggered' : 'notEligible',
        observedMinor: absoluteDeltaMinor,
        thresholdMinor: policy.variance.absoluteGateMinor,
        observedBasisPoints: null,
        thresholdBasisPoints: null,
        reasonCodes: absoluteGate ? ['variance_absolute_gate_exceeded'] : [],
      },
      {
        ruleCode: 'variance_relative_gate',
        outcome: relativeGate ? (zeroBaseline ? 'reinforced' : 'triggered') : 'notEligible',
        observedMinor: null,
        thresholdMinor: null,
        observedBasisPoints: percentageDeltaBasisPoints,
        thresholdBasisPoints: policy.variance.relativeGateBasisPoints,
        reasonCodes: zeroBaseline
          ? ['new_spend_zero_baseline']
          : relativeGate
            ? ['variance_relative_gate_exceeded']
            : [],
      },
      {
        ruleCode: 'variance_robust_deviation_gate',
        outcome: robustGate ? 'triggered' : 'notEligible',
        observedMinor: null,
        thresholdMinor: null,
        observedBasisPoints: robustDeviationMilli,
        thresholdBasisPoints: policy.variance.robustDeviationMilli,
        reasonCodes: robustGate ? ['robust_deviation_exceeded'] : [],
      },
    ],
    baseline: {
      method: 'equivalentPeriodMedianMad',
      windowStart: comparisons[0]!.period.start,
      windowEnd: comparisons.at(-1)!.period.end,
      sampleCount: baselineTransactionCount,
      activePeriodCount: activePeriods,
      robustCenterMinor: centerRounded,
      dispersionMinor,
      expectedRange: {
        currency: policy.currency,
        lowerMinor: expectedRange.lower,
        upperMinor: expectedRange.upper,
      },
      exclusionCounts: bucket.exclusions,
    },
    comparisons: comparisons.map((period, index) => ({
      period: period.period,
      value: { currency: policy.currency, amountMinor: baselineTotals[index]! },
      eligible: true,
      contribution: 'informational',
      sampleCount: baselineTransactions[index]!.length,
      medianMinor: centerRounded,
      dispersionMinor,
      empiricalPercentileBasisPoints: empiricalPercentile(
        baselineTotals[index]!,
        baselineTotals
      ),
      ratioBasisPoints:
        center.numerator === 0n
          ? null
          : ratioRoundedBounded(
              integerRational(baselineTotals[index]!),
              center,
              BASIS_POINTS,
              1_000_000
            ),
    })),
    contributors: contributorsFor(
      direction,
      currentTransactions,
      baselineTransactions,
      baselineTotals,
      center,
      policy
    ),
    exclusions: exclusionsFor(bucket),
    evidence:
      bucket.kind === 'category'
        ? [
            {
              source: 'monarchBridge',
              evidenceType: 'categoryProjection',
              observedAt: input.source.sourceAsOf,
              documentRef: null,
              normalizedValueMinor: null,
              normalizedUnit: null,
            },
          ]
        : [],
    lifecycleHistory,
    suppression: {
      state: 'none',
      suppressionId: null,
      scope: null,
      durationDays: null,
      operator: null,
      createdAt: null,
      expiresAt: null,
      undoneAt: null,
    },
    availableActions:
      qualified && policy.featureGates.confirmedActions
        ? [
            'expected',
            'notUseful',
            'suppress30Days',
            'suppress90Days',
            'suppress180Days',
          ]
        : [],
  });
  return {
    detail,
    qualified,
    direction,
    absoluteImpactMinor: absoluteDeltaMinor,
    robustDeviationMilli,
    baselineSufficiency,
    confidence,
  };
}

function sufficiency(
  policy: FinanceInsightPolicySnapshotV1,
  comparisonCount: number,
  activePeriods: number,
  baselineTransactions: number,
  currentTransactions: number,
  zeroBaseline: boolean,
  entityKind: 'category' | 'merchant',
  identityQuality: EntityBucket['identityQuality']
): BaselineSufficiencyV1 {
  if (zeroBaseline) {
    if (
      comparisonCount < policy.variance.sufficientActiveMonths ||
      currentTransactions < policy.variance.minimumCurrentTransactions
    ) {
      return 'insufficient';
    }
    return entityKind === 'category' || identityQuality === 'configuredAlias'
      ? 'sufficient'
      : 'limited';
  }
  if (
    activePeriods < policy.variance.minimumActiveMonths ||
    baselineTransactions < policy.variance.minimumBaselineTransactions
  ) {
    return 'insufficient';
  }
  if (
    activePeriods >= policy.variance.sufficientActiveMonths &&
    baselineTransactions >= policy.variance.minimumBaselineTransactions * 2
  ) {
    return 'sufficient';
  }
  return 'limited';
}

function confidenceFor(
  sufficiencyValue: BaselineSufficiencyV1,
  identityQuality: EntityBucket['identityQuality'],
  ambiguousClassificationCount: number
): ConfidenceV1 {
  if (sufficiencyValue === 'insufficient') return 'low';
  if (
    sufficiencyValue === 'limited' ||
    identityQuality === 'normalizedName' ||
    ambiguousClassificationCount > 0
  ) {
    return 'medium';
  }
  return 'high';
}

function reasonCodesFor(input: {
  qualified: boolean;
  absoluteGate: boolean;
  relativeGate: boolean;
  robustGate: boolean;
  zeroBaseline: boolean;
  confidence: ConfidenceV1;
  minimumSpreadApplied: boolean;
  normalizedMerchant: boolean;
  ambiguousClassification: boolean;
}): ReasonCodeV1[] {
  const codes: ReasonCodeV1[] = [];
  if (!input.qualified) codes.push('adaptive_baseline_insufficient');
  if (input.absoluteGate) codes.push('variance_absolute_gate_exceeded');
  if (input.zeroBaseline) {
    codes.push('new_spend_zero_baseline');
  } else if (input.relativeGate) {
    codes.push('variance_relative_gate_exceeded');
  }
  if (input.robustGate) codes.push('robust_deviation_exceeded');
  if (input.minimumSpreadApplied) codes.push('zero_mad_minimum_spread');
  if (input.normalizedMerchant) codes.push('normalized_name_identity');
  if (input.ambiguousClassification) codes.push('classification_ambiguous');
  if (input.qualified && input.confidence === 'medium') {
    codes.push('medium_confidence_no_notify');
  }
  return codes;
}

function exclusionsFor(bucket: EntityBucket): ReasonCodeV1[] {
  const result: ReasonCodeV1[] = [];
  const mapping: readonly [
    keyof ExclusionCounts,
    ReasonCodeV1,
  ][] = [
    ['pending', 'pending_excluded'],
    ['transfer', 'transfer_excluded'],
    ['income', 'income_excluded'],
    ['refund', 'refund_excluded'],
    ['unclassifiedCredit', 'unclassified_credit_excluded'],
    ['knownRecurring', 'known_recurring_excluded'],
    ['policyExcluded', 'policy_excluded'],
  ];
  for (const [key, code] of mapping) {
    if (bucket.exclusions[key] > 0) result.push(code);
  }
  if (bucket.ambiguousClassificationCount > 0) {
    result.push('classification_ambiguous');
  }
  return result;
}

function contributorsFor(
  direction: 'increase' | 'decrease',
  current: readonly TransactionSourceFactV1[],
  baseline: readonly (readonly TransactionSourceFactV1[])[],
  baselineTotals: readonly number[],
  center: Rational,
  policy: FinanceInsightPolicySnapshotV1
) {
  let transactions: readonly TransactionSourceFactV1[];
  if (direction === 'increase') {
    transactions = current;
  } else {
    const closest = baselineTotals
      .map((total, index) => ({
        index,
        distance: absoluteRational(
          subtractRational(integerRational(total), center)
        ),
      }))
      .sort((left, right) => {
        const distance = compareRational(left.distance, right.distance);
        return distance !== 0 ? distance : left.index - right.index;
      })[0];
    transactions = closest ? baseline[closest.index]! : [];
  }
  return [...transactions]
    .sort((left, right) => {
      const leftImpact = -left.amountMinor;
      const rightImpact = -right.amountMinor;
      if (leftImpact !== rightImpact) {
        return leftImpact < rightImpact ? 1 : -1;
      }
      const date = right.occurredOn.localeCompare(left.occurredOn);
      return date !== 0 ? date : left.sourceRef.localeCompare(right.sourceRef);
    })
    .slice(0, policy.variance.contributorLimit)
    .map((item, index) => ({
      rank: index + 1,
      sourceRef: item.sourceRef,
      occurredOn: item.occurredOn,
      displayName: boundedDisplayName(item.merchantName),
      amount: { currency: policy.currency, amountMinor: -item.amountMinor },
      contributionMinor:
        direction === 'increase' ? -item.amountMinor : item.amountMinor,
    }));
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.qualified !== right.qualified) return left.qualified ? -1 : 1;
  const severityOrder = { high: 0, medium: 1, info: 2 } as const;
  const severity =
    severityOrder[left.detail.severity] - severityOrder[right.detail.severity];
  if (severity !== 0) return severity;
  if (left.absoluteImpactMinor !== right.absoluteImpactMinor) {
    return left.absoluteImpactMinor < right.absoluteImpactMinor ? 1 : -1;
  }
  const confidenceOrder = { high: 0, medium: 1, low: 2 } as const;
  const confidence =
    confidenceOrder[left.confidence] - confidenceOrder[right.confidence];
  if (confidence !== 0) return confidence;
  if (left.detail.kind !== right.detail.kind) {
    return left.detail.kind === 'categoryVariance' ? -1 : 1;
  }
  return left.detail.entity.sourceRef.localeCompare(
    right.detail.entity.sourceRef
  );
}

function buildTransitions(
  previous: readonly OccurrencePublicationV1[],
  allQualified: readonly Candidate[],
  selectedQualified: readonly Candidate[],
  observationPeriod: PeriodV1,
  occurredAt: string
): EvaluationPublicationV1['transitions'] {
  const allByInsight = new Map(
    allQualified.map((candidate) => [candidate.detail.insightId, candidate])
  );
  const selectedIds = new Set(
    selectedQualified.map((candidate) => candidate.detail.occurrenceId)
  );
  const transitions: EvaluationPublicationV1['transitions'][number][] = [];
  for (const item of previous) {
    const detail = item.detail;
    if (
      detail.sourceLifecycle !== 'open' ||
      (detail.kind !== 'categoryVariance' &&
        detail.kind !== 'merchantVariance')
    ) {
      continue;
    }
    if (detail.observationPeriod.start < observationPeriod.start) {
      transitions.push({
        occurrenceId: detail.occurrenceId,
        state: 'resolved',
        reasonCode: 'variance_period_closed',
        replacementOccurrenceId: null,
        occurredAt,
      });
      continue;
    }
    if (detail.observationPeriod.start !== observationPeriod.start) continue;
    const replacement = allByInsight.get(detail.insightId);
    if (
      replacement?.detail.occurrenceId === detail.occurrenceId &&
      selectedIds.has(detail.occurrenceId)
    ) {
      continue;
    }
    if (replacement && selectedIds.has(replacement.detail.occurrenceId)) {
      transitions.push({
        occurrenceId: detail.occurrenceId,
        state: 'superseded',
        reasonCode: 'correction_superseded',
        replacementOccurrenceId: replacement.detail.occurrenceId,
        occurredAt,
      });
    } else if (replacement) {
      transitions.push({
        occurrenceId: detail.occurrenceId,
        state: 'resolved',
        reasonCode: 'variance_rank_omitted',
        replacementOccurrenceId: null,
        occurredAt,
      });
    } else {
      transitions.push({
        occurrenceId: detail.occurrenceId,
        state: 'resolved',
        reasonCode: 'correction_resolved',
        replacementOccurrenceId: null,
        occurredAt,
      });
    }
  }
  return transitions.sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId)
  );
}

function buildDigest(
  input: VarianceEvaluationInputV1,
  policy: FinanceInsightPolicySnapshotV1,
  period: PeriodV1,
  selectedQualified: readonly Candidate[],
  totalQualified: number
): VarianceDigestV1 | null {
  if (!policy.featureGates.monthlyMoverDigestNotifications) return null;
  const notifying = selectedQualified
    .filter((candidate) => candidate.confidence === 'high')
    .slice(0, policy.variance.digestMemberLimit);
  if (notifying.length === 0) return null;
  const members = notifying.map((candidate) => ({
    occurrenceId: candidate.detail.occurrenceId,
    deliveryRevision: candidate.detail.deliveryRevision,
    kind: candidate.detail.kind as 'categoryVariance' | 'merchantVariance',
    direction: candidate.direction,
    absoluteImpactMinor: candidate.absoluteImpactMinor,
  }));
  const memberSetDigest = canonicalDigestV1(
    members.map((member) => ({
      occurrenceId: member.occurrenceId,
      deliveryRevision: member.deliveryRevision,
    })) as CanonicalJsonValue
  );
  const previous = input.previousDigest;
  const revision =
    previous?.periodStart === period.start
      ? previous.memberSetDigest === memberSetDigest
        ? previous.revision
        : safeIncrement(previous.revision)
      : 1;
  const scheduleMonth = addMonths(period.start.slice(0, 7), 1);
  const scheduledAt = localDateTimeToUtc(
    `${scheduleMonth}-${String(policy.delivery.monthlyDigestDay).padStart(2, '0')}`,
    policy.delivery.monthlyDigestLocalHour,
    policy.delivery.monthlyDigestLocalMinute,
    policy.timezone
  );
  return {
    digestId: `finance-insight-digest:${input.source.connectorRef}:${period.start}`,
    sourceActivityKey: `${period.start}:${revision}`,
    periodStart: period.start,
    revision,
    memberSetDigest,
    scheduledAt,
    timezone: policy.timezone,
    members,
    omittedCount: Math.max(0, totalQualified - members.length),
  };
}

function lifecycleFor(
  previous: InsightOccurrenceDetailV1 | undefined,
  analysisState: 'qualified' | 'insufficientBaseline',
  at: string
) {
  if (previous) {
    if (
      previous.analysisState === 'qualified' &&
      analysisState === 'qualified' &&
      previous.sourceLifecycle === 'open'
    ) {
      return previous.lifecycleHistory;
    }
    if (
      previous.analysisState === 'insufficientBaseline' &&
      analysisState === 'insufficientBaseline'
    ) {
      return previous.lifecycleHistory;
    }
    const next = previous.lifecycleHistory.at(-1)!.sequence + 1;
    return [
      ...previous.lifecycleHistory,
      {
        sequence: next,
        state: 'analyzing' as const,
        reasonCode: null,
        occurredAt: at,
        replacementOccurrenceId: null,
      },
      {
        sequence: next + 1,
        state: analysisState === 'qualified' ? ('open' as const) : analysisState,
        reasonCode: null,
        occurredAt: at,
        replacementOccurrenceId: null,
      },
    ];
  }
  return [
    {
      sequence: 1,
      state: 'analyzing' as const,
      reasonCode: null,
      occurredAt: at,
      replacementOccurrenceId: null,
    },
    {
      sequence: 2,
      state: analysisState === 'qualified' ? ('open' as const) : analysisState,
      reasonCode: null,
      occurredAt: at,
      replacementOccurrenceId: null,
    },
  ];
}

function deliveryRevisionFor(
  previous: InsightOccurrenceDetailV1 | undefined,
  currentTotal: number,
  nextClassification: 'qualified' | 'insufficientBaseline',
  policy: FinanceInsightPolicySnapshotV1
): number {
  if (!previous) return 1;
  if (previous.observedValue === null) return previous.deliveryRevision;
  const decision = evaluateMaterialChangeV1({
    previousAmountMinor: previous.observedValue.amountMinor,
    nextAmountMinor: currentTotal,
    previousClassification: previous.analysisState,
    nextClassification,
    amountBoundaryMinor: policy.materialChange.amountBoundaryMinor,
    changeKind: 'reevaluation',
  });
  return nextDeliveryRevisionV1(previous.deliveryRevision, decision);
}

function validatedPreviousOccurrences(
  previous: readonly OccurrencePublicationV1[]
): OccurrencePublicationV1[] {
  return previous.map((item) => ({
    detail: parseInsightOccurrenceDetailV1(item.detail),
    sourceRevisionRef: item.sourceRevisionRef,
  }));
}

function classificationLineageMap(
  lineages: readonly VarianceEntityClassificationLineageV1[]
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const item of lineages) {
    parseContractV1(
      sourceReferenceSchema,
      item.entitySourceRef,
      'variance lineage entity reference'
    );
    const lineage = parseContractV1(
      sourceReferenceSchema,
      item.lineage,
      'variance classification lineage'
    );
    const key = `${item.entityKind}:${item.entitySourceRef}`;
    if (result.has(key)) {
      throw new RangeError('Variance classification lineages must be unique');
    }
    result.set(key, lineage);
  }
  return result;
}

function requiredClassificationLineage(
  lineages: ReadonlyMap<string, string>,
  bucket: EntityBucket
): string {
  const lineage = lineages.get(bucket.key);
  if (!lineage) {
    throw new RangeError(
      'Variance classification lineage is required for every evaluated entity'
    );
  }
  return lineage;
}

function deriveReentrySafeOccurrenceId(
  identityKey: Uint8Array,
  insightId: string,
  kind: 'categoryVariance' | 'merchantVariance',
  comparisonPeriod: string,
  direction: 'increase' | 'decrease',
  baseLineage: string,
  previous: readonly OccurrencePublicationV1[]
): string {
  let lineage = baseLineage;
  for (let attempt = 0; attempt <= previous.length; attempt += 1) {
    const occurrenceId = deriveOccurrenceIdV1(identityKey, insightId, {
      kind,
      comparisonPeriod,
      direction,
      classificationLineage: lineage,
    });
    const prior = previous.find(
      (item) => item.detail.occurrenceId === occurrenceId
    )?.detail;
    if (
      prior?.sourceLifecycle !== 'resolved' &&
      prior?.sourceLifecycle !== 'superseded'
    ) {
      return occurrenceId;
    }
    lineage = canonicalDigestV1({
      namespace: 'variance-occurrence-reentry-v1',
      baseLineage,
      predecessorOccurrenceId: occurrenceId,
      predecessorLifecycle: prior.sourceLifecycle,
      predecessorReason: prior.resolutionReason,
    });
  }
  throw new RangeError('Variance occurrence re-entry lineage is cyclic');
}

function evaluationPeriods(
  completedAt: string,
  timezone: string,
  requestedMonth: string | undefined,
  historyMonths: number
): {
  observation: MonthPeriod | null;
  comparisons: MonthPeriod[];
} {
  const localDate = localCalendarDate(completedAt, timezone);
  const currentMonth = localDate.slice(0, 7);
  const month = requestedMonth ?? currentMonth;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || month > currentMonth) {
    throw new RangeError('Variance observationMonth is invalid');
  }
  const complete = month < currentMonth;
  const elapsedDays = complete
    ? daysInMonth(month)
    : Number(localDate.slice(8, 10)) - 1;
  if (elapsedDays < 1) return { observation: null, comparisons: [] };
  const observation = monthPeriod(month, elapsedDays, complete);
  const comparisons = Array.from({ length: historyMonths }, (_, index) => {
    const priorMonth = addMonths(month, -(historyMonths - index));
    return monthPeriod(priorMonth, elapsedDays, complete);
  });
  return { observation, comparisons };
}

function monthPeriod(
  month: string,
  elapsedDays: number,
  complete: boolean
): MonthPeriod {
  const endDay = complete ? daysInMonth(month) : Math.min(elapsedDays, daysInMonth(month));
  return {
    key: month,
    period: {
      start: `${month}-01`,
      end: `${month}-${String(endDay).padStart(2, '0')}`,
    },
  };
}

function addMonths(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const absolute = year * 12 + monthNumber - 1 + offset;
  const nextYear = Math.floor(absolute / 12);
  const nextMonth = ((absolute % 12) + 12) % 12;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth + 1).padStart(2, '0')}`;
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function localCalendarDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function localDateTimeToUtc(
  date: string,
  hour: number,
  minute: number,
  timezone: string
): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(candidate));
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(value.year),
      Number(value.month) - 1,
      Number(value.day),
      Number(value.hour),
      Number(value.minute),
      Number(value.second)
    );
    candidate += target - represented;
  }
  return new Date(candidate).toISOString();
}

function periodCovered(
  period: PeriodV1,
  coverageStart: string,
  coverageEnd: string
): boolean {
  return period.start >= coverageStart && period.end <= coverageEnd;
}

function sourceIsFresh(
  sourceAsOf: string,
  completedAt: string,
  policy: FinanceInsightPolicySnapshotV1
): boolean {
  const sourceTime = Date.parse(sourceAsOf);
  const completedTime = Date.parse(completedAt);
  return (
    Number.isFinite(sourceTime) &&
    sourceTime <= completedTime &&
    completedTime - sourceTime <=
      policy.freshness.newAlertMaxAgeHours * 60 * 60 * 1_000
  );
}

function classifyExclusionSummary(
  input: VarianceEvaluationInputV1,
  periods: readonly MonthPeriod[]
): Readonly<Record<TransactionClassificationV1, number>> {
  const counts: Record<TransactionClassificationV1, number> = {
    postedSpend: 0,
    pending: 0,
    transfer: 0,
    income: 0,
    refund: 0,
    unclassifiedCredit: 0,
    knownRecurring: 0,
    policyExcluded: 0,
  };
  const classificationByRef = new Map(
    input.classifications.map((item) => [item.sourceRef, item.classification])
  );
  for (const transaction of input.projection.transactions) {
    if (
      periods.some(
        (period) =>
          transaction.occurredOn >= period.period.start &&
          transaction.occurredOn <= period.period.end
      )
    ) {
      counts[classificationByRef.get(transaction.sourceRef)!] += 1;
    }
  }
  return counts;
}

function emptyResult(
  periods: ReturnType<typeof evaluationPeriods>,
  exclusionSummary: Readonly<Record<TransactionClassificationV1, number>>
): VarianceEvaluationResultV1 {
  return {
    publication: {
      occurrences: [],
      transitions: [],
      exclusionSummary,
    },
    series: [],
    digest: null,
    observationPeriod: periods.observation?.period ?? null,
    comparisonPeriods: periods.comparisons.map((item) => item.period),
    omittedQualifiedCount: 0,
    exclusionSummary,
  };
}

function transactionTotal(
  transactions: readonly TransactionSourceFactV1[]
): number {
  let total = 0;
  for (const transaction of transactions) {
    const spend = -transaction.amountMinor;
    if (!Number.isSafeInteger(spend) || spend < 0) {
      throw new RangeError('Posted spending must be a negative minor-unit amount');
    }
    total += spend;
    if (!Number.isSafeInteger(total) || total > MAX_AMOUNT_MINOR_V1) {
      throw new RangeError('Variance aggregate exceeds the contract amount range');
    }
  }
  return total;
}

function medianIntegers(values: readonly number[]): Rational {
  if (values.length === 0) throw new RangeError('Median requires at least one value');
  const sorted = [...values].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1
  );
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? integerRational(sorted[middle]!)
    : rational(
        BigInt(sorted[middle - 1]!) + BigInt(sorted[middle]!),
        2n
      );
}

function medianRationals(values: readonly Rational[]): Rational {
  if (values.length === 0) throw new RangeError('Median requires at least one value');
  const sorted = [...values].sort(compareRational);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : divideRational(
        addRational(sorted[middle - 1]!, sorted[middle]!),
        integerRational(2)
      );
}

function integerRational(value: number): Rational {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Exact variance arithmetic requires safe integers');
  }
  return { numerator: BigInt(value), denominator: 1n };
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RangeError('Rational denominator cannot be zero');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(
    numerator < 0n ? -numerator : numerator,
    denominator < 0n ? -denominator : denominator
  );
  return {
    numerator: (numerator * sign) / divisor,
    denominator: (denominator * sign) / divisor,
  };
}

function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function subtractRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator
  );
}

function divideRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator,
    left.denominator * right.numerator
  );
}

function absoluteRational(value: Rational): Rational {
  return {
    numerator: value.numerator < 0n ? -value.numerator : value.numerator,
    denominator: value.denominator,
  };
}

function maxRational(left: Rational, right: Rational): Rational {
  return compareRational(left, right) >= 0 ? left : right;
}

function compareRational(left: Rational, right: Rational): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function roundRational(value: Rational): number {
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const rounded =
    (numerator * 2n + value.denominator) / (value.denominator * 2n);
  const signed = negative ? -rounded : rounded;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Variance result exceeds safe integer range');
  }
  return result;
}

function floorRational(value: Rational): number {
  let quotient = value.numerator / value.denominator;
  if (value.numerator < 0n && value.numerator % value.denominator !== 0n) {
    quotient -= 1n;
  }
  return Number(quotient);
}

function ceilRational(value: Rational): number {
  let quotient = value.numerator / value.denominator;
  if (value.numerator > 0n && value.numerator % value.denominator !== 0n) {
    quotient += 1n;
  }
  return Number(quotient);
}

function ratioRoundedBounded(
  numerator: Rational,
  denominator: Rational,
  scale: bigint,
  absoluteLimit: number
): number {
  if (denominator.numerator === 0n) {
    throw new RangeError('Variance ratio denominator cannot be zero');
  }
  const scaled = multiplyRational(divideRational(numerator, denominator), {
    numerator: scale,
    denominator: 1n,
  });
  const limit = integerRational(absoluteLimit);
  if (compareRational(scaled, limit) > 0) return absoluteLimit;
  if (
    compareRational(scaled, {
      numerator: -limit.numerator,
      denominator: limit.denominator,
    }) < 0
  ) {
    return -absoluteLimit;
  }
  return roundRational(scaled);
}

function expectedRangeFor(
  center: Rational,
  dispersion: Rational,
  policy: FinanceInsightPolicySnapshotV1
): { lower: number; upper: number } {
  const radius = multiplyRational(dispersion, {
    numerator: BigInt(policy.variance.robustDeviationMilli),
    denominator: MILLI,
  });
  return {
    lower: Math.max(0, floorRational(subtractRational(center, radius))),
    upper: Math.min(
      MAX_AMOUNT_MINOR_V1,
      ceilRational(addRational(center, radius))
    ),
  };
}

function empiricalPercentile(
  value: number,
  population: readonly number[]
): number {
  const atOrBelow = population.filter((item) => item <= value).length;
  return Number(
    (BigInt(atOrBelow) * BASIS_POINTS * 2n + BigInt(population.length)) /
      (BigInt(population.length) * 2n)
  );
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

function boundedDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= 120 ? normalized : normalized.slice(0, 120).trimEnd();
}

function safeIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Variance digest revision cannot be incremented');
  }
  return value + 1;
}
