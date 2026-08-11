import type {
  AssignedEvaluationV1,
  SourceGenerationCreateRequestV1,
  TransactionSourceFactV1,
} from '../contracts/source-v1.js';
import {
  parseInsightOccurrenceDetailV1,
  parseInsightOccurrenceSummaryV1,
  type BaselineSufficiencyV1,
  type ConfidenceV1,
  type InsightOccurrenceDetailV1,
  type InsightOccurrenceSummaryV1,
  type ReasonCodeV1,
} from '../contracts/occurrence-v1.js';
import { parseSourceGenerationCreateRequestV1 } from '../contracts/source-v1.js';
import { MAX_AMOUNT_MINOR_V1 } from '../contracts/primitives.js';
import {
  deriveInsightIdV1,
  deriveMerchantKeyV1,
  deriveOccurrenceIdV1,
  deriveSourceRevisionRefV1,
  evaluateMaterialChangeV1,
} from '../core/identity.js';
import type {
  EvaluationPublicationV1,
  OccurrenceTransitionV1,
  SourceProjectionV1,
} from '../persistence/sqlite-store.js';
import {
  parseFinanceInsightPolicySnapshotV1,
  type FinanceInsightPolicySnapshotV1,
} from '../policy/v1.js';
import {
  classifyTransactionV1,
  type TransactionClassificationV1,
} from '../projection/classification.js';
import {
  explainLargeTransactionV1,
  LARGE_TRANSACTION_EXPLANATION_TEMPLATE_VERSION_V1,
} from './large-transaction-explanations-v1.js';
import {
  compareRobustlyV1,
  ROBUST_STATISTICS_METHOD_VERSION_V1,
  type RobustComparisonV1,
} from './robust-statistics-v1.js';

export const LARGE_TRANSACTION_DETECTOR_VERSION_V1 =
  'large-transaction-detector-v1' as const;

export const LARGE_TRANSACTION_CLASSIFICATION_VERSION_V1 =
  'large-transaction-scope-v1' as const;

export type LargeTransactionSourceCompletenessV1 =
  | 'complete'
  | 'partial'
  | 'unavailable';

export type LargeTransactionLineageClassificationV1 =
  | TransactionClassificationV1
  | 'approvedMerchant'
  | 'expectedScope'
  | 'suppressedScope';

export interface PreviousLargeTransactionOccurrenceV1 {
  readonly transactionSourceRef: string;
  readonly sourceRevisionRef: string;
  readonly amountMinor: number;
  readonly classification: LargeTransactionLineageClassificationV1;
  readonly detail: InsightOccurrenceDetailV1;
  readonly changeKind?: 'reevaluation' | 'evidence' | 'correction';
}

export interface LargeTransactionEvaluationInputV1 {
  readonly projection: Readonly<SourceProjectionV1>;
  readonly source: SourceGenerationCreateRequestV1;
  readonly assignment: AssignedEvaluationV1;
  readonly policy: FinanceInsightPolicySnapshotV1;
  readonly identityKey: Uint8Array;
  readonly sourceCompleteness: LargeTransactionSourceCompletenessV1;
  readonly completedAt: string;
  readonly previousOccurrences?: readonly PreviousLargeTransactionOccurrenceV1[];
}

export interface LargeTransactionEvaluationResultV1 {
  readonly state: 'completed' | 'disabled' | 'stale' | 'partial' | 'unavailable';
  readonly reasonCodes: readonly ReasonCodeV1[];
  readonly summaries: readonly InsightOccurrenceSummaryV1[];
  readonly publication: EvaluationPublicationV1;
  readonly omittedQualifiedCount: number;
}

type AdaptiveDimensionV1 =
  FinanceInsightPolicySnapshotV1['largeTransaction']['eligibleDimensions'][number];

interface ClassifiedTransactionV1 {
  readonly fact: TransactionSourceFactV1;
  readonly amountMinor: number;
  readonly merchantKey: string;
  readonly classification: LargeTransactionLineageClassificationV1;
  readonly exclusionCode: ReasonCodeV1 | null;
}

interface DimensionEvaluationV1 {
  readonly dimension: AdaptiveDimensionV1;
  readonly eligible: boolean;
  readonly comparison: RobustComparisonV1 | null;
  readonly sampleCount: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly activePeriodCount: number;
}

interface EvaluatedCandidateV1 {
  readonly transaction: ClassifiedTransactionV1;
  readonly qualified: boolean;
  readonly explicitTriggered: boolean;
  readonly adaptiveTriggered: boolean;
  readonly eligibleDimensionCount: number;
  readonly triggeredDimensionCount: number;
  readonly dimensions: readonly DimensionEvaluationV1[];
}

interface PublicationCandidateV1 {
  readonly sourceRef: string;
  readonly occurredOn: string;
  readonly amountMinor: number;
  readonly publication: EvaluationPublicationV1['occurrences'][number];
}

const DIMENSION_REASON_CODES: Readonly<Record<AdaptiveDimensionV1, ReasonCodeV1>> =
  Object.freeze({
    merchant: 'adaptive_merchant_baseline_triggered',
    category: 'adaptive_category_baseline_triggered',
    account: 'adaptive_account_baseline_triggered',
    household: 'adaptive_household_baseline_triggered',
  });

const EMPTY_SUPPRESSION = Object.freeze({
  state: 'none' as const,
  suppressionId: null,
  scope: null,
  durationDays: null,
  operator: null,
  createdAt: null,
  expiresAt: null,
  undoneAt: null,
});

const AVAILABLE_ACTIONS = Object.freeze([
  'expected' as const,
  'notUseful' as const,
  'suppress30Days' as const,
  'suppress90Days' as const,
  'suppress180Days' as const,
]);

export function evaluateLargeTransactionsV1(
  input: LargeTransactionEvaluationInputV1
): LargeTransactionEvaluationResultV1 {
  const source = parseSourceGenerationCreateRequestV1(input.source);
  const policy = parseFinanceInsightPolicySnapshotV1(input.policy);
  validateEvaluationFence(input.assignment, source, policy, input.completedAt);
  validatePromotedProjection(input.projection, source);
  const freshness = sourceFreshness(
    input.sourceCompleteness,
    source.sourceAsOf,
    input.completedAt,
    policy.freshness.newAlertMaxAgeHours
  );
  if (!policy.featureGates.largeTransactionAnalysis) {
    return emptyResult('disabled', []);
  }
  if (freshness !== 'fresh') {
    const reasonCode: ReasonCodeV1 =
      freshness === 'stale'
        ? 'source_stale'
        : freshness === 'partial'
          ? 'source_partial'
          : 'source_unavailable';
    return emptyResult(freshness, [reasonCode]);
  }

  const previous = parsePreviousOccurrences(input.previousOccurrences ?? []);
  const previousBySourceRef = new Map(
    previous.map((item) => [item.transactionSourceRef, item])
  );
  const exclusionCounts = new Map<string, number>();
  const classified = [...input.projection.transactions]
    .sort(compareTransactionFacts)
    .map((fact) =>
      classifyForLargeTransaction(
        fact,
        policy,
        input.identityKey,
        exclusionCounts
      )
    );
  const baselineTransactions = classified.filter(
    (item) => item.classification === 'postedSpend'
  );
  const evaluated = classified.map((transaction) =>
    evaluateCandidate(transaction, baselineTransactions, policy)
  );
  const publicationCandidates: PublicationCandidateV1[] = [];
  const evaluatedBySourceRef = new Map<string, EvaluatedCandidateV1>();

  for (const candidate of evaluated) {
    evaluatedBySourceRef.set(candidate.transaction.fact.sourceRef, candidate);
    if (!candidate.qualified) {
      if (candidate.transaction.exclusionCode === null) {
        increment(exclusionCounts, 'below_large_transaction_threshold');
      }
      continue;
    }
    const prior = previousBySourceRef.get(candidate.transaction.fact.sourceRef);
    publicationCandidates.push(
      buildPublicationCandidate(input, source, policy, candidate, prior)
    );
  }

  const orderedCandidates = publicationCandidates.sort(compareCandidates);
  const mandatoryCorrectionRefs = new Set(
    previous
      .filter((prior) => {
        const current = evaluatedBySourceRef.get(prior.transactionSourceRef);
        return (
          current?.qualified === true &&
          correctionTransitionRequired(prior, current)
        );
      })
      .map((prior) => prior.transactionSourceRef)
  );
  if (
    mandatoryCorrectionRefs.size > policy.largeTransaction.publicationLimit
  ) {
    throw new RangeError(
      'Corrected large-transaction successors exceed the publication limit'
    );
  }
  const optionalRefs = new Set(
    orderedCandidates
      .filter((candidate) => !mandatoryCorrectionRefs.has(candidate.sourceRef))
      .slice(
        0,
        policy.largeTransaction.publicationLimit - mandatoryCorrectionRefs.size
      )
      .map((candidate) => candidate.sourceRef)
  );
  const selected = orderedCandidates.filter(
    (candidate) =>
      mandatoryCorrectionRefs.has(candidate.sourceRef) ||
      optionalRefs.has(candidate.sourceRef)
  );
  const selectedBySourceRef = new Map(
    selected.map((candidate) => [candidate.sourceRef, candidate])
  );
  const transitions = buildCorrectionTransitions(
    previous,
    evaluatedBySourceRef,
    selectedBySourceRef,
    input.completedAt,
    policy.largeTransaction.lifecycleTransitionLimit
  );
  const occurrences = selected.map((candidate) => candidate.publication);
  const summaries = occurrences.map((item) => toSummary(item.detail));
  const omittedQualifiedCount = orderedCandidates.length - selected.length;
  if (omittedQualifiedCount > 0) {
    exclusionCounts.set('qualified_output_omitted', omittedQualifiedCount);
  }

  return {
    state: 'completed',
    reasonCodes: [],
    summaries,
    publication: {
      occurrences,
      transitions,
      exclusionSummary: orderedCounts(exclusionCounts),
    },
    omittedQualifiedCount,
  };
}

function evaluateCandidate(
  transaction: ClassifiedTransactionV1,
  baselineTransactions: readonly ClassifiedTransactionV1[],
  policy: FinanceInsightPolicySnapshotV1
): EvaluatedCandidateV1 {
  if (transaction.classification !== 'postedSpend') {
    return {
      transaction,
      qualified: false,
      explicitTriggered: false,
      adaptiveTriggered: false,
      eligibleDimensionCount: 0,
      triggeredDimensionCount: 0,
      dimensions: [],
    };
  }
  const explicitTriggered =
    transaction.amountMinor >= policy.largeTransaction.explicitRuleMinor;
  const dimensions = policy.largeTransaction.eligibleDimensions.map((dimension) =>
    evaluateDimension(transaction, dimension, baselineTransactions, policy)
  );
  const eligibleDimensionCount = dimensions.filter(
    (dimension) => dimension.eligible
  ).length;
  const triggeredDimensionCount = dimensions.filter(
    (dimension) => dimension.comparison?.triggered
  ).length;
  const adaptiveTriggered =
    transaction.amountMinor >=
      policy.largeTransaction.adaptiveMeaningfulDollarFloorMinor &&
    triggeredDimensionCount >= policy.largeTransaction.adaptiveMinimumAgreement;
  return {
    transaction,
    qualified: explicitTriggered || adaptiveTriggered,
    explicitTriggered,
    adaptiveTriggered,
    eligibleDimensionCount,
    triggeredDimensionCount,
    dimensions,
  };
}

function evaluateDimension(
  candidate: ClassifiedTransactionV1,
  dimension: AdaptiveDimensionV1,
  transactions: readonly ClassifiedTransactionV1[],
  policy: FinanceInsightPolicySnapshotV1
): DimensionEvaluationV1 {
  const windowStart = subtractCalendarDays(
    candidate.fact.occurredOn,
    policy.largeTransaction.historyWindowDays
  );
  const windowEnd = subtractCalendarDays(candidate.fact.occurredOn, 1);
  const hasIdentity =
    dimension === 'household' ||
    dimension === 'merchant' ||
    (dimension === 'category' && candidate.fact.categoryRef !== null) ||
    (dimension === 'account' && candidate.fact.accountRef !== null);
  const samples = hasIdentity
    ? transactions.filter(
        (historical) =>
          historical.fact.occurredOn >= windowStart &&
          historical.fact.occurredOn < candidate.fact.occurredOn &&
          matchesDimension(candidate, historical, dimension)
      )
    : [];
  const eligible =
    hasIdentity &&
    samples.length >= policy.largeTransaction.minimumBaselineSampleCount;
  return {
    dimension,
    eligible,
    comparison: eligible
      ? compareRobustlyV1(
          candidate.amountMinor,
          samples.map((sample) => sample.amountMinor),
          policy.largeTransaction
        )
      : null,
    sampleCount: samples.length,
    windowStart,
    windowEnd,
    activePeriodCount: new Set(samples.map((sample) => sample.fact.occurredOn)).size,
  };
}

function buildPublicationCandidate(
  input: LargeTransactionEvaluationInputV1,
  source: SourceGenerationCreateRequestV1,
  policy: FinanceInsightPolicySnapshotV1,
  candidate: EvaluatedCandidateV1,
  previous: PreviousLargeTransactionOccurrenceV1 | undefined
): PublicationCandidateV1 {
  const fact = candidate.transaction.fact;
  const insightId = deriveInsightIdV1(input.identityKey, {
    householdScope: input.assignment.identity.householdScope,
    kind: 'largeTransaction',
    entityKind: 'transaction',
    entitySourceRef: fact.sourceRef,
  });
  const defaultChangeKind =
    previous &&
    (previous.amountMinor !== candidate.transaction.amountMinor ||
      previous.classification !== candidate.transaction.classification)
      ? 'correction'
      : 'reevaluation';
  const changeKind = previous?.changeKind ?? defaultChangeKind;
  const correction = previous !== undefined && changeKind === 'correction';
  const materialDecision =
    previous === undefined
      ? null
      : evaluateMaterialChangeV1({
          previousAmountMinor: previous.amountMinor,
          nextAmountMinor: candidate.transaction.amountMinor,
          previousClassification: previous.classification,
          nextClassification: candidate.transaction.classification,
          amountBoundaryMinor: policy.materialChange.amountBoundaryMinor,
          changeKind,
        });
  const sourceRevisionRef =
    previous === undefined
      ? deriveRevision(input.identityKey, candidate.transaction, null)
      : correction
        ? deriveRevision(
            input.identityKey,
            candidate.transaction,
            previous.sourceRevisionRef
          )
        : previous.sourceRevisionRef;
  const occurrenceId =
    previous !== undefined && !correction
      ? previous.detail.occurrenceId
      : deriveOccurrenceIdV1(input.identityKey, insightId, {
          kind: 'largeTransaction',
          transactionSourceRef: fact.sourceRef,
          sourceRevisionRef,
        });
  const sameEvaluation =
    previous !== undefined &&
    previous.detail.provenance.sourceGeneration === source.sourceGeneration &&
    previous.detail.provenance.policyVersion === policy.policyVersion;
  if (sameEvaluation && !correction) {
    return {
      sourceRef: fact.sourceRef,
      occurredOn: fact.occurredOn,
      amountMinor: candidate.transaction.amountMinor,
      publication: {
        detail: previous.detail,
        sourceRevisionRef,
      },
    };
  }

  const primary =
    candidate.dimensions.find((dimension) => dimension.comparison?.triggered) ??
    candidate.dimensions.find((dimension) => dimension.eligible);
  const reasonCodes = buildReasonCodes(candidate, materialDecision?.lineage);
  const baselineSufficiency = baselineSufficiencyFor(candidate);
  const confidence = confidenceFor(candidate);
  const explanation = explainLargeTransactionV1({
    observedMinor: candidate.transaction.amountMinor,
    currency: source.currency,
    explicitRuleMinor: policy.largeTransaction.explicitRuleMinor,
    meaningfulFloorMinor:
      policy.largeTransaction.adaptiveMeaningfulDollarFloorMinor,
    explicitTriggered: candidate.explicitTriggered,
    eligibleDimensionCount: candidate.eligibleDimensionCount,
    triggeredDimensionCount: candidate.triggeredDimensionCount,
  });
  const initialOccurrence = previous === undefined || correction;
  const createdAt = initialOccurrence
    ? input.assignment.acceptedAt
    : previous.detail.createdAt;
  const lifecycleHistory = initialOccurrence
    ? [
        {
          sequence: 1,
          state: 'analyzing' as const,
          reasonCode: null,
          occurredAt: input.assignment.acceptedAt,
          replacementOccurrenceId: null,
        },
        {
          sequence: 2,
          state: 'open' as const,
          reasonCode: null,
          occurredAt: input.completedAt,
          replacementOccurrenceId: null,
        },
      ]
    : previous.detail.lifecycleHistory;
  const deliveryRevision =
    previous === undefined || correction
      ? 1
      : previous.detail.deliveryRevision +
        (materialDecision?.incrementDeliveryRevision ? 1 : 0);
  if (!Number.isSafeInteger(deliveryRevision)) {
    throw new RangeError('deliveryRevision exceeds the safe integer range');
  }
  const expectedRange = primary?.comparison
    ? {
        currency: source.currency,
        lowerMinor: boundedContractAmount(primary.comparison.expectedLowerMinor),
        upperMinor: boundedContractAmount(primary.comparison.expectedUpperMinor),
      }
    : null;
  const centerMinor = primary?.comparison?.medianMinor ?? null;
  const detail = parseInsightOccurrenceDetailV1({
    contractVersion: '1.0',
    insightId,
    occurrenceId,
    deliveryRevision,
    kind: 'largeTransaction',
    entity: {
      kind: 'transaction',
      sourceRef: fact.sourceRef,
      displayName: boundedDisplayName(fact.merchantName),
      identityQuality: 'stableSource',
    },
    analysisState: 'qualified',
    sourceLifecycle: 'open',
    resolutionReason: null,
    supersededByOccurrenceId: null,
    severity:
      candidate.transaction.amountMinor >=
      policy.largeTransaction.highSeverityAmountMinor
        ? 'high'
        : 'medium',
    confidence,
    baselineSufficiency,
    reasonCodes,
    headline: explanation.headline,
    explanation: explanation.explanation,
    observationPeriod: {
      start: fact.occurredOn,
      end: fact.occurredOn,
    },
    baselinePeriod: primary
      ? { start: primary.windowStart, end: primary.windowEnd }
      : null,
    observedValue: {
      currency: source.currency,
      amountMinor: candidate.transaction.amountMinor,
    },
    expectedRange,
    absoluteDelta:
      centerMinor === null
        ? null
        : {
            currency: source.currency,
            amountMinor: candidate.transaction.amountMinor - centerMinor,
          },
    percentageDeltaBasisPoints:
      centerMinor === null || centerMinor === 0
        ? null
        : boundedBasisPoints(
            candidate.transaction.amountMinor - centerMinor,
            centerMinor
          ),
    currency: source.currency,
    freshness: {
      state: 'fresh',
      sourceAsOf: source.sourceAsOf,
      maxAgeHours: 48,
      warningReason: null,
    },
    provenance: {
      connectorRef: source.connectorRef,
      sourceGeneration: source.sourceGeneration,
      bridgeContractVersion: source.bridgeContractVersion,
      providerClass: 'monarchBridgeNormalized',
      sourceAsOf: source.sourceAsOf,
      coverageStart: source.coverageStart,
      coverageEnd: source.coverageEnd,
      completeness: 'complete',
      detectorSetVersion: input.assignment.identity.detectorSetVersion,
      detectorVersion: LARGE_TRANSACTION_DETECTOR_VERSION_V1,
      methodVersion: ROBUST_STATISTICS_METHOD_VERSION_V1,
      explanationTemplateVersion:
        LARGE_TRANSACTION_EXPLANATION_TEMPLATE_VERSION_V1,
      policyVersion: policy.policyVersion,
      evaluationStartedAt: input.assignment.acceptedAt,
      evaluationCompletedAt: input.completedAt,
    },
    targets: [
      {
        system: 'monarch',
        targetKind: 'transaction',
        sourceRef: fact.sourceRef,
      },
    ],
    createdAt,
    updatedAt: input.completedAt,
    resolvedAt: null,
    ruleResults: buildRuleResults(candidate, policy),
    baseline: buildBaselineDetail(candidate, source, classifiedExclusionCounts(input)),
    comparisons: candidate.dimensions.map((dimension) =>
      comparisonRow(dimension, candidate.transaction.amountMinor, source.currency)
    ),
    contributors: [],
    exclusions: buildOccurrenceExclusions(input, policy),
    evidence: [
      {
        source: 'monarchBridge',
        evidenceType: 'transaction',
        observedAt: source.sourceAsOf,
        documentRef: null,
        normalizedValueMinor: candidate.transaction.amountMinor,
        normalizedUnit: 'currencyMinor',
      },
    ],
    lifecycleHistory,
    suppression: initialOccurrence
      ? EMPTY_SUPPRESSION
      : previous.detail.suppression,
    availableActions: initialOccurrence
      ? AVAILABLE_ACTIONS
      : previous.detail.availableActions,
  });
  return {
    sourceRef: fact.sourceRef,
    occurredOn: fact.occurredOn,
    amountMinor: candidate.transaction.amountMinor,
    publication: { detail, sourceRevisionRef },
  };
}

function classifyForLargeTransaction(
  fact: TransactionSourceFactV1,
  policy: FinanceInsightPolicySnapshotV1,
  identityKey: Uint8Array,
  exclusionCounts: Map<string, number>
): ClassifiedTransactionV1 {
  const base = classifyTransactionV1(fact, policy);
  const amountMinor = fact.amountMinor < 0 ? -fact.amountMinor : fact.amountMinor;
  const merchantKey = deriveMerchantKeyV1(identityKey, fact.merchantName);
  if (base.classification !== 'postedSpend') {
    if (base.reasonCode !== null) increment(exclusionCounts, base.reasonCode);
    return {
      fact,
      amountMinor,
      merchantKey,
      classification: base.classification,
      exclusionCode: base.reasonCode,
    };
  }
  if (policy.largeTransaction.approvedMerchantKeys.includes(merchantKey)) {
    increment(exclusionCounts, 'approved_merchant_excluded');
    return {
      fact,
      amountMinor,
      merchantKey,
      classification: 'approvedMerchant',
      exclusionCode: 'approved_merchant_excluded',
    };
  }
  if (matchesAnyScope(fact, merchantKey, policy.largeTransaction.expectedScopes)) {
    increment(exclusionCounts, 'expected_scope_excluded');
    return {
      fact,
      amountMinor,
      merchantKey,
      classification: 'expectedScope',
      exclusionCode: 'expected_scope_excluded',
    };
  }
  if (
    matchesAnyScope(fact, merchantKey, policy.largeTransaction.suppressedScopes)
  ) {
    increment(exclusionCounts, 'suppressed_scope_excluded');
    return {
      fact,
      amountMinor,
      merchantKey,
      classification: 'suppressedScope',
      exclusionCode: 'suppressed_scope_excluded',
    };
  }
  return {
    fact,
    amountMinor,
    merchantKey,
    classification: 'postedSpend',
    exclusionCode: null,
  };
}

function matchesAnyScope(
  fact: TransactionSourceFactV1,
  merchantKey: string,
  scopes: FinanceInsightPolicySnapshotV1['largeTransaction']['expectedScopes']
): boolean {
  return scopes.some((scope) => {
    if (scope.kind === 'transaction') return scope.sourceRef === fact.sourceRef;
    if (scope.kind === 'merchant') return scope.sourceRef === merchantKey;
    if (scope.kind === 'category') return scope.sourceRef === fact.categoryRef;
    return scope.sourceRef === fact.accountRef;
  });
}

function matchesDimension(
  candidate: ClassifiedTransactionV1,
  historical: ClassifiedTransactionV1,
  dimension: AdaptiveDimensionV1
): boolean {
  if (dimension === 'household') return true;
  if (dimension === 'merchant') {
    return historical.merchantKey === candidate.merchantKey;
  }
  if (dimension === 'category') {
    return historical.fact.categoryRef === candidate.fact.categoryRef;
  }
  return historical.fact.accountRef === candidate.fact.accountRef;
}

function deriveRevision(
  identityKey: Uint8Array,
  transaction: ClassifiedTransactionV1,
  predecessorRevisionRef: string | null
): string {
  return deriveSourceRevisionRefV1(identityKey, {
    sourceKind: 'transaction',
    sourceRef: transaction.fact.sourceRef,
    materialFact: {
      amountMinor: transaction.amountMinor,
      classification: transaction.classification,
      occurredOn: transaction.fact.occurredOn,
      merchantKey: transaction.merchantKey,
      categoryRef: transaction.fact.categoryRef,
      accountRef: transaction.fact.accountRef,
      classificationVersion: LARGE_TRANSACTION_CLASSIFICATION_VERSION_V1,
    },
    predecessorRevisionRef,
  });
}

function buildReasonCodes(
  candidate: EvaluatedCandidateV1,
  lineage: ReturnType<typeof evaluateMaterialChangeV1>['lineage'] | undefined
): ReasonCodeV1[] {
  const reasons: ReasonCodeV1[] = [];
  if (candidate.explicitTriggered) reasons.push('explicit_amount_rule_exceeded');
  if (candidate.adaptiveTriggered) reasons.push('adaptive_baseline_agreement');
  if (candidate.eligibleDimensionCount < 2) {
    reasons.push('adaptive_baseline_insufficient');
  } else if (!candidate.adaptiveTriggered) {
    reasons.push('adaptive_baseline_no_agreement');
  }
  for (const dimension of candidate.dimensions) {
    if (dimension.comparison?.triggered) {
      reasons.push(DIMENSION_REASON_CODES[dimension.dimension]);
    }
  }
  if (
    candidate.dimensions.some(
      (dimension) =>
        dimension.eligible && dimension.comparison?.scaledMad.numerator === 0n
    )
  ) {
    reasons.push('zero_mad_minimum_spread');
  }
  reasons.push('normalized_name_identity');
  if (lineage === 'materialRevision') reasons.push('material_source_change');
  return [...new Set(reasons)].slice(0, 12);
}

function buildRuleResults(
  candidate: EvaluatedCandidateV1,
  policy: FinanceInsightPolicySnapshotV1
) {
  const dimensionResults = candidate.dimensions.map((dimension) => ({
    ruleCode: `large_transaction_${dimension.dimension}_baseline`,
    outcome: !dimension.eligible
      ? ('notEligible' as const)
      : dimension.comparison!.triggered
        ? ('triggered' as const)
        : dimension.comparison!.reinforced
          ? ('reinforced' as const)
          : ('informational' as const),
    observedMinor: candidate.transaction.amountMinor,
    thresholdMinor:
      dimension.comparison === null
        ? null
        : boundedContractAmount(dimension.comparison.expectedUpperMinor),
    observedBasisPoints: dimension.comparison?.ratioBasisPoints ?? null,
    thresholdBasisPoints: policy.largeTransaction.ratioGateBasisPoints,
    reasonCodes: !dimension.eligible
      ? (['adaptive_baseline_insufficient'] as const)
      : dimension.comparison!.triggered
        ? ([DIMENSION_REASON_CODES[dimension.dimension]] as const)
        : [],
  }));
  return [
    {
      ruleCode: 'large_transaction_explicit_amount',
      outcome: candidate.explicitTriggered ? 'triggered' : 'informational',
      observedMinor: candidate.transaction.amountMinor,
      thresholdMinor: policy.largeTransaction.explicitRuleMinor,
      observedBasisPoints: null,
      thresholdBasisPoints: null,
      reasonCodes: candidate.explicitTriggered
        ? (['explicit_amount_rule_exceeded'] as const)
        : [],
    },
    {
      ruleCode: 'large_transaction_adaptive_floor',
      outcome:
        candidate.transaction.amountMinor >=
        policy.largeTransaction.adaptiveMeaningfulDollarFloorMinor
          ? 'triggered'
          : 'informational',
      observedMinor: candidate.transaction.amountMinor,
      thresholdMinor:
        policy.largeTransaction.adaptiveMeaningfulDollarFloorMinor,
      observedBasisPoints: null,
      thresholdBasisPoints: null,
      reasonCodes: [],
    },
    ...dimensionResults,
    {
      ruleCode: 'large_transaction_adaptive_agreement',
      outcome: candidate.adaptiveTriggered
        ? 'triggered'
        : candidate.eligibleDimensionCount <
            policy.largeTransaction.adaptiveMinimumAgreement
          ? 'notEligible'
          : 'informational',
      observedMinor: null,
      thresholdMinor: null,
      observedBasisPoints: null,
      thresholdBasisPoints: null,
      reasonCodes: candidate.adaptiveTriggered
        ? (['adaptive_baseline_agreement'] as const)
        : candidate.eligibleDimensionCount <
            policy.largeTransaction.adaptiveMinimumAgreement
          ? (['adaptive_baseline_insufficient'] as const)
          : (['adaptive_baseline_no_agreement'] as const),
    },
  ];
}

function buildBaselineDetail(
  candidate: EvaluatedCandidateV1,
  source: SourceGenerationCreateRequestV1,
  exclusionCounts: ReturnType<typeof emptyClassificationCounts>
) {
  const household = candidate.dimensions.find(
    (dimension) => dimension.dimension === 'household'
  );
  const comparison = household?.comparison ?? null;
  const fallbackWindowStart = subtractCalendarDays(
    candidate.transaction.fact.occurredOn,
    1
  );
  const fallbackWindowEnd = fallbackWindowStart;
  return {
    method: 'rollingMedianMad' as const,
    windowStart: household?.windowStart ?? fallbackWindowStart,
    windowEnd: household?.windowEnd ?? fallbackWindowEnd,
    sampleCount: household?.sampleCount ?? 0,
    activePeriodCount: household?.activePeriodCount ?? 0,
    robustCenterMinor: comparison?.medianMinor ?? null,
    dispersionMinor:
      comparison === null
        ? null
        : boundedContractAmount(comparison.scaledMadMinor),
    expectedRange: comparison
      ? {
          currency: source.currency,
          lowerMinor: boundedContractAmount(comparison.expectedLowerMinor),
          upperMinor: boundedContractAmount(comparison.expectedUpperMinor),
        }
      : null,
    exclusionCounts,
  };
}

function comparisonRow(
  dimension: DimensionEvaluationV1,
  observedMinor: number,
  currency: string
) {
  return {
    period: {
      start: dimension.windowStart,
      end: dimension.windowEnd,
    },
    value: {
      currency,
      amountMinor: observedMinor,
    },
    eligible: dimension.eligible,
    contribution: !dimension.eligible
      ? ('notEligible' as const)
      : dimension.comparison!.triggered
        ? ('triggered' as const)
        : dimension.comparison!.reinforced
          ? ('reinforced' as const)
          : ('informational' as const),
    sampleCount: dimension.sampleCount,
    medianMinor: dimension.comparison?.medianMinor ?? null,
    dispersionMinor:
      dimension.comparison === null
        ? null
        : boundedContractAmount(dimension.comparison.scaledMadMinor),
    empiricalPercentileBasisPoints:
      dimension.comparison?.empiricalPercentileBasisPoints ?? null,
    ratioBasisPoints: dimension.comparison?.ratioBasisPoints ?? null,
  };
}

function buildCorrectionTransitions(
  previous: readonly PreviousLargeTransactionOccurrenceV1[],
  current: ReadonlyMap<string, EvaluatedCandidateV1>,
  selected: ReadonlyMap<string, PublicationCandidateV1>,
  occurredAt: string,
  limit: number
): OccurrenceTransitionV1[] {
  const transitions: OccurrenceTransitionV1[] = [];
  for (const prior of previous) {
    const candidate = current.get(prior.transactionSourceRef);
    if (!correctionTransitionRequired(prior, candidate)) {
      continue;
    }
    const replacement = selected.get(prior.transactionSourceRef);
    transitions.push(
      replacement
        ? {
            occurrenceId: prior.detail.occurrenceId,
            state: 'superseded',
            reasonCode: 'correction_superseded',
            replacementOccurrenceId: replacement.publication.detail.occurrenceId,
            occurredAt,
          }
        : {
            occurrenceId: prior.detail.occurrenceId,
            state: 'resolved',
            reasonCode: 'correction_resolved',
            replacementOccurrenceId: null,
            occurredAt,
          }
    );
  }
  if (transitions.length > limit) {
    throw new RangeError(
      'Large-transaction lifecycle transitions exceed the policy limit'
    );
  }
  return transitions.sort((left, right) =>
    compareCodeUnits(left.occurrenceId, right.occurrenceId)
  );
}

function correctionTransitionRequired(
  prior: PreviousLargeTransactionOccurrenceV1,
  candidate: EvaluatedCandidateV1 | undefined
): boolean {
  if (candidate === undefined) return true;
  const materialChanged =
    prior.amountMinor !== candidate.transaction.amountMinor ||
    prior.classification !== candidate.transaction.classification;
  return (
    prior.changeKind === 'correction' ||
    (prior.changeKind === undefined && materialChanged)
  );
}

function baselineSufficiencyFor(
  candidate: EvaluatedCandidateV1
): BaselineSufficiencyV1 {
  if (candidate.eligibleDimensionCount === 0) return 'insufficient';
  if (candidate.eligibleDimensionCount === 1) return 'limited';
  return 'sufficient';
}

function confidenceFor(candidate: EvaluatedCandidateV1): ConfidenceV1 {
  if (
    (candidate.explicitTriggered && candidate.triggeredDimensionCount >= 2) ||
    candidate.triggeredDimensionCount >= 3
  ) {
    return 'high';
  }
  return 'medium';
}

function buildOccurrenceExclusions(
  input: LargeTransactionEvaluationInputV1,
  policy: FinanceInsightPolicySnapshotV1
): ReasonCodeV1[] {
  const counts = new Map<ReasonCodeV1, number>();
  for (const fact of input.projection.transactions) {
    const base = classifyTransactionV1(fact, policy);
    if (base.reasonCode) increment(counts, base.reasonCode);
    if (base.classification !== 'postedSpend') continue;
    const merchantKey = deriveMerchantKeyV1(input.identityKey, fact.merchantName);
    if (policy.largeTransaction.approvedMerchantKeys.includes(merchantKey)) {
      increment(counts, 'approved_merchant_excluded');
    } else if (
      matchesAnyScope(fact, merchantKey, policy.largeTransaction.expectedScopes)
    ) {
      increment(counts, 'expected_scope_excluded');
    } else if (
      matchesAnyScope(fact, merchantKey, policy.largeTransaction.suppressedScopes)
    ) {
      increment(counts, 'suppressed_scope_excluded');
    }
  }
  return [...counts.keys()].sort().slice(0, 12);
}

function classifiedExclusionCounts(
  input: LargeTransactionEvaluationInputV1
): ReturnType<typeof emptyClassificationCounts> {
  const counts = emptyClassificationCounts();
  for (const fact of input.projection.transactions) {
    const result = classifyTransactionV1(fact, input.policy);
    const key = ({
      postedSpend: null,
      pending: 'pending',
      transfer: 'transfer',
      income: 'income',
      refund: 'refund',
      unclassifiedCredit: 'unclassifiedCredit',
      knownRecurring: 'knownRecurring',
      policyExcluded: 'policyExcluded',
    } satisfies Record<
      TransactionClassificationV1,
      keyof ReturnType<typeof emptyClassificationCounts> | null
    >)[result.classification];
    if (key !== null) counts[key] += 1;
  }
  return counts;
}

function emptyClassificationCounts() {
  return {
    pending: 0,
    transfer: 0,
    income: 0,
    refund: 0,
    unclassifiedCredit: 0,
    knownRecurring: 0,
    policyExcluded: 0,
  };
}

function parsePreviousOccurrences(
  previous: readonly PreviousLargeTransactionOccurrenceV1[]
): PreviousLargeTransactionOccurrenceV1[] {
  const parsed = previous.map((item) => {
    const detail = parseInsightOccurrenceDetailV1(item.detail);
    if (
      detail.kind !== 'largeTransaction' ||
      detail.entity.kind !== 'transaction' ||
      detail.entity.sourceRef !== item.transactionSourceRef ||
      detail.sourceLifecycle !== 'open'
    ) {
      throw new RangeError(
        'Previous large-transaction lineage must identify one open transaction occurrence'
      );
    }
    return { ...item, detail };
  });
  if (
    new Set(parsed.map((item) => item.transactionSourceRef)).size !== parsed.length
  ) {
    throw new RangeError('Previous large-transaction lineage must be unique');
  }
  return parsed;
}

function validateEvaluationFence(
  assignment: AssignedEvaluationV1,
  source: SourceGenerationCreateRequestV1,
  policy: FinanceInsightPolicySnapshotV1,
  completedAt: string
): void {
  if (
    assignment.identity.connectorRef !== source.connectorRef ||
    assignment.identity.sourceGeneration !== source.sourceGeneration ||
    assignment.sourceSequence !== source.sourceSequence ||
    assignment.identity.detectorSetVersion !== policy.detectorSetVersion ||
    assignment.identity.policyVersion !== policy.policyVersion ||
    source.currency !== policy.currency
  ) {
    throw new RangeError(
      'Large-transaction evaluation input does not match its promoted assignment'
    );
  }

  const completed = Date.parse(completedAt);
  if (
    Number.isNaN(completed) ||
    completed < Date.parse(assignment.acceptedAt)
  ) {
    throw new RangeError('completedAt must be on or after the assigned evaluation');
  }
}

function validatePromotedProjection(
  projection: Readonly<SourceProjectionV1>,
  source: SourceGenerationCreateRequestV1
): void {
  const actualCounts = {
    transaction: projection.transactions.length,
    recurring: projection.recurring.length,
    category: projection.categories.length,
    account: projection.accounts.length,
    tag: projection.tags.length,
  } as const;
  for (const entry of source.manifest) {
    if (actualCounts[entry.kind] !== entry.itemCount) {
      throw new RangeError(
        'Large-transaction evaluation requires the complete promoted projection'
      );
    }
  }
}

function sourceFreshness(
  completeness: LargeTransactionSourceCompletenessV1,
  sourceAsOf: string,
  completedAt: string,
  maxAgeHours: number
): 'fresh' | 'stale' | 'partial' | 'unavailable' {
  if (completeness !== 'complete') return completeness;
  const age = Date.parse(completedAt) - Date.parse(sourceAsOf);
  return age >= 0 && age <= maxAgeHours * 60 * 60 * 1_000 ? 'fresh' : 'stale';
}

function emptyResult(
  state: LargeTransactionEvaluationResultV1['state'],
  reasonCodes: readonly ReasonCodeV1[]
): LargeTransactionEvaluationResultV1 {
  return {
    state,
    reasonCodes,
    summaries: [],
    publication: {
      occurrences: [],
      transitions: [],
      exclusionSummary: {},
    },
    omittedQualifiedCount: 0,
  };
}

function toSummary(
  detail: InsightOccurrenceDetailV1
): InsightOccurrenceSummaryV1 {
  const {
    ruleResults: _ruleResults,
    baseline: _baseline,
    comparisons: _comparisons,
    contributors: _contributors,
    exclusions: _exclusions,
    evidence: _evidence,
    lifecycleHistory: _lifecycleHistory,
    suppression: _suppression,
    availableActions: _availableActions,
    ...summary
  } = detail;
  return parseInsightOccurrenceSummaryV1(summary);
}

function boundedBasisPoints(deltaMinor: number, centerMinor: number): number {
  const exact =
    (BigInt(deltaMinor) * 10_000n) / BigInt(centerMinor);
  const bounded =
    exact < -1_000_000n
      ? -1_000_000n
      : exact > 1_000_000n
        ? 1_000_000n
        : exact;
  return Number(bounded);
}

function boundedContractAmount(value: number): number {
  return Math.max(-MAX_AMOUNT_MINOR_V1, Math.min(MAX_AMOUNT_MINOR_V1, value));
}

function boundedDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.slice(0, 120).trim() || 'Transaction';
}

function subtractCalendarDays(value: string, days: number): string {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return new Date(timestamp - days * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function compareTransactionFacts(
  left: TransactionSourceFactV1,
  right: TransactionSourceFactV1
): number {
  return (
    compareCodeUnits(left.occurredOn, right.occurredOn) ||
    compareCodeUnits(left.sourceRef, right.sourceRef)
  );
}

function compareCandidates(
  left: PublicationCandidateV1,
  right: PublicationCandidateV1
): number {
  return (
    compareCodeUnits(right.occurredOn, left.occurredOn) ||
    right.amountMinor - left.amountMinor ||
    compareCodeUnits(left.sourceRef, right.sourceRef)
  );
}

function orderedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()]
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => compareCodeUnits(left, right))
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function increment<K extends string>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
