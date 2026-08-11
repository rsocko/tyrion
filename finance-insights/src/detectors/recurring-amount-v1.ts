import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  MAX_AMOUNT_MINOR_V1,
  parseInsightOccurrenceDetailV1,
  parseInsightOccurrenceSummaryV1,
  type AssignedEvaluationV1,
  type EvidenceRecordV1,
  type InsightOccurrenceDetailV1,
  type InsightOccurrenceSummaryV1,
  type ReasonCodeV1,
  type TransactionSourceFactV1,
} from '../contracts/v1.js';
import {
  deriveInsightIdV1,
  deriveOccurrenceIdV1,
  deriveSourceRevisionRefV1,
  evaluateMaterialChangeV1,
  nextDeliveryRevisionV1,
} from '../core/identity.js';
import { normalizeIdentityTextV1 } from '../core/canonical.js';
import type { DocumentEvidencePortV1 } from '../evidence/port.js';
import type {
  EvaluationPublicationV1,
  RecurringAssociationV1,
  SourceProjectionV1,
} from '../persistence/sqlite-store.js';
import type { EvaluationTerminalResultV1 } from '../ports/repositories.js';
import type { FinanceInsightPolicySnapshotV1 } from '../policy/v1.js';
import {
  classifyTransactionV1,
  type TransactionClassificationResultV1,
} from '../projection/classification.js';
import {
  explainRecurringAmountV1,
  RECURRING_AMOUNT_EXPLANATION_TEMPLATE_VERSION_V1,
} from './recurring-explanations-v1.js';

export const RECURRING_AMOUNT_DETECTOR_VERSION_V1 =
  'recurring-amount-detector-v1' as const;
export const RECURRING_AMOUNT_METHOD_VERSION_V1 =
  'seasonal-median-scaled-mad-v1' as const;
export const RECURRING_ASSOCIATION_VERSION_V1 =
  'recurring-association-v1' as const;
export const RECURRING_AMOUNT_MAX_COMPARISONS_V1 = 36 as const;
export const RECURRING_AMOUNT_MAX_CONTRIBUTORS_V1 = 1 as const;

export type RecurringAmountAnalysisStateV1 =
  | 'qualifiedIncrease'
  | 'decreaseAnalysisOnly'
  | 'withinExpectedRange'
  | 'insufficientBaseline'
  | 'unavailable';

export interface RecurringAmountProjectionLoaderV1 {
  loadCurrentProjection(connectorRef: string): Promise<SourceProjectionV1 | null>;
}

export interface RecurringUsageContextV1 {
  usageUnits: number;
  billAmountMinor: number;
  unitCostMilliMinorPerUsage: number;
  usageChangeBasisPoints: number | null;
  unitCostChangeBasisPoints: number | null;
}

export interface RecurringAmountSourceContextV1 {
  connectorRef: string;
  sourceGeneration: string;
  sourceAsOf: string;
  coverageStart: string;
  coverageEnd: string;
  currency: string;
  bridgeContractVersion: string;
  completeness: 'complete' | 'partial' | 'unavailable';
}

export interface ConfiguredRecurringAssociationV1 {
  transactionSourceRef: string;
  recurringSourceRef: string;
}

export interface RecurringEvidenceBindingV1 {
  transactionSourceRef: string;
  documentRef: string;
}

export interface PriorRecurringOccurrenceV1 {
  recurringSourceRef: string;
  transactionSourceRef: string;
  billingPeriod: string;
  sourceRevisionRef: string;
  materialAmountMinor: number;
  classification: string;
  detail: InsightOccurrenceDetailV1;
}

export interface RecurringAmountDetectorOptionsV1 {
  projectionLoader: RecurringAmountProjectionLoaderV1;
  evidence: DocumentEvidencePortV1;
  source: RecurringAmountSourceContextV1;
  assignment: AssignedEvaluationV1;
  policy: FinanceInsightPolicySnapshotV1;
  identityKey: Uint8Array;
  completedAt: string;
  configuredAssociations?: readonly ConfiguredRecurringAssociationV1[];
  evidenceBindings?: readonly RecurringEvidenceBindingV1[];
  priorOccurrences?: readonly PriorRecurringOccurrenceV1[];
}

export interface RecurringAmountExplanationInputV1 {
  displayName: string;
  state: RecurringAmountAnalysisStateV1;
  periodNormalized: boolean;
  optionalEvidenceAvailable: boolean;
  usageContextAvailable: boolean;
}

export interface RecurringAmountAnalysisV1 {
  recurringSourceRef: string;
  transactionSourceRef: string | null;
  billingPeriod: string | null;
  state: RecurringAmountAnalysisStateV1;
  associationConfidence: RecurringAssociationV1['confidence'] | null;
  observedAmountMinor: number | null;
  analysisAmountMinor: number | null;
  seasonalSampleCount: number;
  seasonalYearCount: number;
  robustCenterMinor: number | null;
  scaledMadMinor: number | null;
  expectedLowerMinor: number | null;
  expectedUpperMinor: number | null;
  absoluteVarianceMinor: number | null;
  percentageVarianceBasisPoints: number | null;
  absoluteGatePassed: boolean;
  relativeGatePassed: boolean;
  usageContext: RecurringUsageContextV1 | null;
  reasonCodes: readonly ReasonCodeV1[];
  occurrenceId: string | null;
}

export interface RecurringAmountDetectorResultV1 {
  analyses: readonly RecurringAmountAnalysisV1[];
  associations: readonly RecurringAssociationV1[];
  publication: EvaluationPublicationV1 | null;
  terminalResult: EvaluationTerminalResultV1;
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface AssociatedTransaction {
  fact: TransactionSourceFactV1;
  classification: TransactionClassificationResultV1;
  confidence: RecurringAssociationV1['confidence'];
}

interface EvidenceContext {
  records: readonly EvidenceRecordV1[];
  billingPeriodDays: number | null;
  periodNormalized: boolean;
  usageContextAvailable: boolean;
  usageContext: RecurringUsageContextV1 | null;
  optionalEvidenceAvailable: boolean;
}

interface AnalysisComputation {
  state: RecurringAmountAnalysisStateV1;
  center: Rational | null;
  scaledMad: Rational | null;
  lower: Rational | null;
  upper: Rational | null;
  absoluteDelta: Rational | null;
  gateAbsoluteDelta: Rational | null;
  percentageBasisPoints: number | null;
  absoluteGatePassed: boolean;
  relativeGatePassed: boolean;
  reasonCodes: ReasonCodeV1[];
}

const ELIGIBLE_RECURRING_CLASSIFICATIONS = new Set([
  'knownRecurring',
  'postedSpend',
]);
const EXCLUSION_REASON_ORDER: readonly ReasonCodeV1[] = [
  'pending_excluded',
  'transfer_excluded',
  'income_excluded',
  'refund_excluded',
  'unclassified_credit_excluded',
  'policy_excluded',
];
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

export async function evaluateRecurringAmountDetectorV1(
  options: RecurringAmountDetectorOptionsV1
): Promise<RecurringAmountDetectorResultV1> {
  validateEvaluationFence(options);
  const projection = await options.projectionLoader.loadCurrentProjection(
    options.source.connectorRef
  );
  if (projection === null) {
    return emptyResult(options.completedAt, 'unavailable');
  }
  if (!options.policy.featureGates.recurringAmountAnalysis) {
    return emptyResult(options.completedAt, 'completed');
  }

  const recurringFacts = [...projection.recurring]
    .filter((fact) => fact.active)
    .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  const recurringByRef = new Map(
    recurringFacts.map((fact) => [fact.sourceRef, fact])
  );
  const priorOccurrences = [...(options.priorOccurrences ?? [])].sort(
    (left, right) =>
      Date.parse(right.detail.updatedAt) - Date.parse(left.detail.updatedAt) ||
      left.detail.occurrenceId.localeCompare(right.detail.occurrenceId)
  );
  const priorTransactionRefs = new Set(
    priorOccurrences.map((item) => item.transactionSourceRef)
  );
  const configured = configuredAssociationMap(
    options.configuredAssociations ?? [],
    recurringByRef
  );
  const exclusionCounts = emptyExclusionCounts();
  const associatedByRecurring = new Map<string, AssociatedTransaction[]>();
  const ambiguousByRecurring = new Map<string, TransactionSourceFactV1[]>();
  const associations: RecurringAssociationV1[] = [];

  for (const transaction of [...projection.transactions].sort(transactionOrder)) {
    const classification = classifyTransactionV1(transaction, options.policy);
    const match = associateTransaction(
      transaction,
      recurringFacts,
      recurringByRef,
      configured
    );
    if (match.kind === 'ambiguous') {
      if (!ELIGIBLE_RECURRING_CLASSIFICATIONS.has(classification.classification)) {
        recordExclusion(exclusionCounts, classification);
        continue;
      }
      for (const recurringRef of match.recurringRefs) {
        appendMapValue(ambiguousByRecurring, recurringRef, transaction);
      }
      continue;
    }
    if (match.kind === 'none') {
      recordExclusion(exclusionCounts, classification);
      continue;
    }
    const association: RecurringAssociationV1 = {
      connectorRef: options.source.connectorRef,
      transactionSourceRef: transaction.sourceRef,
      recurringSourceRef: match.recurringRef,
      associationVersion: RECURRING_ASSOCIATION_VERSION_V1,
      confidence: match.confidence,
      sourceSequence: options.assignment.sourceSequence,
      createdAt: options.completedAt,
    };
    associations.push(association);
    if (!ELIGIBLE_RECURRING_CLASSIFICATIONS.has(classification.classification)) {
      recordExclusion(exclusionCounts, classification);
      if (!priorTransactionRefs.has(transaction.sourceRef)) continue;
    }
    appendMapValue(associatedByRecurring, match.recurringRef, {
      fact: transaction,
      classification,
      confidence: match.confidence,
    });
  }

  const evidenceByRecurring = new Map(
    await Promise.all(
      recurringFacts.map(async (recurring) => {
        const associated = (
          associatedByRecurring.get(recurring.sourceRef) ?? []
        ).sort(associatedTransactionOrder);
        const ambiguous = (
          ambiguousByRecurring.get(recurring.sourceRef) ?? []
        ).sort(transactionOrder);
        const current = associated.at(-1)?.fact ?? ambiguous.at(-1) ?? null;
        return [
          recurring.sourceRef,
          normalizeEvidence(
            await options.evidence.find({
              connectorRef: options.source.connectorRef,
              sourceGeneration: options.source.sourceGeneration,
              entitySourceRef: recurring.sourceRef,
            }),
            current,
            options.evidenceBindings ?? []
          ),
        ] as const;
      })
    )
  );
  const analyses: RecurringAmountAnalysisV1[] = [];
  const publications: EvaluationPublicationV1['occurrences'][number][] = [];
  const publishedOccurrenceIds = new Set<string>();
  const transitions: EvaluationPublicationV1['transitions'][number][] = [];

  for (const recurring of recurringFacts) {
    const ambiguous = ambiguousByRecurring.get(recurring.sourceRef) ?? [];
    const associated = (associatedByRecurring.get(recurring.sourceRef) ?? []).sort(
      associatedTransactionOrder
    );
    const evidence = evidenceByRecurring.get(recurring.sourceRef)!;
    const result = analyzeRecurring(
      recurring,
      associated,
      ambiguous,
      evidence,
      exclusionCounts,
      priorOccurrences,
      options
    );
    analyses.push(result.analysis);
    if (
      result.publication &&
      !publishedOccurrenceIds.has(result.publication.detail.occurrenceId)
    ) {
      publishedOccurrenceIds.add(result.publication.detail.occurrenceId);
      publications.push(result.publication);
    }
    if (result.transition) transitions.push(result.transition);
  }
  if (options.source.completeness === 'complete') {
    const activeRecurringRefs = new Set(recurringFacts.map((fact) => fact.sourceRef));
    const transitionedOccurrenceIds = new Set(
      transitions.map((transition) => transition.occurrenceId)
    );
    for (const prior of priorOccurrences) {
      if (
        prior.detail.sourceLifecycle === 'open' &&
        !activeRecurringRefs.has(prior.recurringSourceRef) &&
        !transitionedOccurrenceIds.has(prior.detail.occurrenceId)
      ) {
        transitionedOccurrenceIds.add(prior.detail.occurrenceId);
        transitions.push({
          occurrenceId: prior.detail.occurrenceId,
          state: 'resolved',
          reasonCode: 'correction_resolved',
          replacementOccurrenceId: null,
          occurredAt: options.completedAt,
        });
      }
    }
  }

  publications.sort((left, right) =>
    left.detail.occurrenceId.localeCompare(right.detail.occurrenceId)
  );
  transitions.sort(
    (left, right) =>
      left.occurrenceId.localeCompare(right.occurrenceId) ||
      left.state.localeCompare(right.state)
  );
  const publication: EvaluationPublicationV1 = {
    occurrences: publications,
    transitions,
    exclusionSummary: exclusionSummary(exclusionCounts, ambiguousByRecurring),
  };
  const summaries = publications.map(({ detail }) => summaryFrom(detail));
  return {
    analyses,
    associations: associations.sort(
      (left, right) =>
        left.transactionSourceRef.localeCompare(right.transactionSourceRef) ||
        left.recurringSourceRef.localeCompare(right.recurringSourceRef)
    ),
    publication,
    terminalResult: {
      state: 'completed',
      summaries,
      completedAt: options.completedAt,
    },
  };
}

function analyzeRecurring(
  recurring: SourceProjectionV1['recurring'][number],
  associated: readonly AssociatedTransaction[],
  ambiguous: readonly TransactionSourceFactV1[],
  evidence: EvidenceContext,
  exclusionCounts: ReturnType<typeof emptyExclusionCounts>,
  priorOccurrences: readonly PriorRecurringOccurrenceV1[],
  options: RecurringAmountDetectorOptionsV1
): {
  analysis: RecurringAmountAnalysisV1;
  publication: EvaluationPublicationV1['occurrences'][number] | null;
  transition: EvaluationPublicationV1['transitions'][number] | null;
} {
  const latest = associated.at(-1) ?? null;
  const latestAmbiguous = [...ambiguous].sort(transactionOrder).at(-1) ?? null;
  const latestPeriod = latest ? monthOf(latest.fact.occurredOn) : null;
  const samePeriod = latestPeriod
    ? associated.filter((item) => monthOf(item.fact.occurredOn) === latestPeriod)
    : [];
  const isAmbiguous =
    ambiguous.length > 0 ||
    samePeriod.length > 1 ||
    latest === null;
  if (isAmbiguous) {
    const hasAssociationAmbiguity =
      ambiguous.length > 0 || samePeriod.length > 1;
    const unavailableTransaction = latest?.fact ?? latestAmbiguous;
    const observed = unavailableTransaction
      ? spendAmount(unavailableTransaction)
      : null;
    const reasonCodes: ReasonCodeV1[] = [
      hasAssociationAmbiguity
        ? 'classification_ambiguous'
        : 'source_unavailable',
      ...(freshnessReasonFor(options) === null
        ? []
        : [freshnessReasonFor(options)!]),
    ];
    const analysis = baseAnalysis({
      recurringSourceRef: recurring.sourceRef,
      transactionSourceRef: unavailableTransaction?.sourceRef ?? null,
      billingPeriod: unavailableTransaction
        ? monthOf(unavailableTransaction.occurredOn)
        : null,
      state: 'unavailable',
      associationConfidence: latest?.confidence ?? null,
      observedAmountMinor: observed,
      analysisAmountMinor: observed,
      reasonCodes,
    });
    if (!unavailableTransaction) {
      return { analysis, publication: null, transition: null };
    }
    const unavailableCurrent: AssociatedTransaction =
      latest ??
      {
        fact: unavailableTransaction,
        classification: classifyTransactionV1(
          unavailableTransaction,
          options.policy
        ),
        confidence: 'ambiguous',
      };
    const unavailablePeriod = monthOf(unavailableTransaction.occurredOn);
    const priorOpen = priorOccurrences.find(
      (item) =>
        item.recurringSourceRef === recurring.sourceRef &&
        item.billingPeriod === unavailablePeriod &&
        item.detail.sourceLifecycle === 'open'
    );
    if (priorOpen) {
      return {
        analysis: { ...analysis, occurrenceId: priorOpen.detail.occurrenceId },
        publication:
          freshnessReasonFor(options) === null
            ? null
            : stalePriorPublication(priorOpen, options),
        transition: null,
      };
    }
    const identity = identityFor(
      recurring.sourceRef,
      unavailableTransaction,
      unavailablePeriod,
      unavailableCurrent.classification.classification,
      unavailableCurrent.confidence,
      priorOccurrences,
      options
    );
    if (
      identity.correctionPrior?.detail.sourceLifecycle === 'open' ||
      (freshnessReasonFor(options) !== null &&
        identity.priorOccurrence?.detail.sourceLifecycle === 'open')
    ) {
      const prior = identity.priorOccurrence!;
      return {
        analysis: {
          ...analysis,
          occurrenceId: prior.detail.occurrenceId,
        },
        publication:
          freshnessReasonFor(options) === null
            ? null
            : stalePriorPublication(prior, options),
        transition: null,
      };
    }
    const detail = buildDetail({
      recurring,
      current: unavailableCurrent,
      history: [],
      evidence,
      exclusionCounts,
      computation: unavailableComputation(reasonCodes),
      identity,
      seasonalYears: 0,
      seasonal: [],
      options,
    });
    return {
      analysis: { ...analysis, occurrenceId: identity.occurrenceId },
      publication: { detail, sourceRevisionRef: identity.sourceRevisionRef },
      transition: correctionTransition(identity, true, options.completedAt),
    };
  }

  const current = latest!;
  const billingPeriod = latestPeriod!;
  if (!ELIGIBLE_RECURRING_CLASSIFICATIONS.has(current.classification.classification)) {
    const identity = identityFor(
      recurring.sourceRef,
      current.fact,
      billingPeriod,
      current.classification.classification,
      current.confidence,
      priorOccurrences,
      options
    );
    if (
      freshnessReasonFor(options) !== null &&
      identity.priorOccurrence?.detail.sourceLifecycle === 'open'
    ) {
      return {
        analysis: {
          ...baseAnalysis({
            recurringSourceRef: recurring.sourceRef,
            transactionSourceRef: current.fact.sourceRef,
            billingPeriod,
            state: 'unavailable',
            associationConfidence: current.confidence,
            observedAmountMinor: null,
            analysisAmountMinor: null,
            reasonCodes: orderedReasons([
              ...(current.classification.reasonCode
                ? [current.classification.reasonCode]
                : []),
              freshnessReasonFor(options)!,
            ]),
          }),
          occurrenceId: identity.priorOccurrence.detail.occurrenceId,
        },
        publication: stalePriorPublication(identity.priorOccurrence, options),
        transition: null,
      };
    }
    return {
      analysis: {
        ...baseAnalysis({
          recurringSourceRef: recurring.sourceRef,
          transactionSourceRef: current.fact.sourceRef,
          billingPeriod,
          state: 'unavailable',
          associationConfidence: current.confidence,
          observedAmountMinor: null,
          analysisAmountMinor: null,
          reasonCodes: current.classification.reasonCode
            ? [current.classification.reasonCode]
            : [],
        }),
        occurrenceId: identity.occurrenceId,
      },
      publication: null,
      transition: correctionTransition(identity, false, options.completedAt),
    };
  }
  const history = associated
    .filter(
      (item) =>
        ELIGIBLE_RECURRING_CLASSIFICATIONS.has(
          item.classification.classification
        ) &&
        monthIndex(item.fact.occurredOn) < monthIndex(current.fact.occurredOn) &&
        monthIndex(current.fact.occurredOn) - monthIndex(item.fact.occurredOn) <=
          options.policy.recurringAmount.historyMonths
    );
  const seasonal = history.filter(
    (item) =>
      yearOf(item.fact.occurredOn) < yearOf(current.fact.occurredOn) &&
      circularMonthDistance(
        monthNumber(item.fact.occurredOn),
        monthNumber(current.fact.occurredOn)
      ) <= options.policy.recurringAmount.adjacentMonthWindow
  );
  const seasonalYears = new Set(
    seasonal.map((item) => yearOf(item.fact.occurredOn))
  ).size;
  const computation = computeAnalysis(
    spendAmount(current.fact),
    seasonal.map((item) => spendAmount(item.fact)),
    seasonalYears,
    evidence,
    options
  );
  const identity = identityFor(
    recurring.sourceRef,
    current.fact,
    billingPeriod,
    current.classification.classification,
    current.confidence,
    priorOccurrences,
    options,
    roundRational(
      equivalentThirtyDayAmount(spendAmount(current.fact), evidence.billingPeriodDays)
    )
  );
  if (identity.materialRevision) {
    computation.reasonCodes = orderedReasons([
      ...computation.reasonCodes,
      'material_source_change',
    ]);
  }
  const analysis = analysisFrom(
    recurring.sourceRef,
    current,
    billingPeriod,
    seasonal,
    seasonalYears,
    computation,
    evidence,
    identity.occurrenceId
  );
  const shouldPublish =
    computation.state === 'qualifiedIncrease' ||
    computation.state === 'insufficientBaseline' ||
    computation.state === 'unavailable';
  identity.successorQualifies = computation.state === 'qualifiedIncrease';
  const transition =
    correctionTransition(
      identity,
      shouldPublish &&
        (computation.state === 'qualifiedIncrease' ||
          identity.reassignedCorrection),
      options.completedAt
    ) ??
    reliableReevaluationTransition(identity, computation.state, options.completedAt);
  if (
    identity.priorOccurrence?.detail.sourceLifecycle === 'open' &&
    computation.state === 'unavailable'
  ) {
    return {
      analysis,
      publication: stalePriorPublication(
        identity.priorOccurrence,
        options
      ),
      transition: null,
    };
  }
  if (lifecycleUpdateWouldExhaustCapacity(identity, computation.state)) {
    return { analysis, publication: null, transition: null };
  }
  if (
    !shouldPublish ||
    (identity.priorOccurrence?.detail.sourceLifecycle === 'open' &&
      identity.correctionPrior === null &&
      computation.state !== 'qualifiedIncrease') ||
    (identity.correctionPrior !== null &&
      !identity.successorQualifies &&
      !identity.reassignedCorrection)
  ) {
    return { analysis, publication: null, transition };
  }

  function lifecycleUpdateWouldExhaustCapacity(
    identity: IdentityResult,
    state: RecurringAmountAnalysisStateV1
  ): boolean {
    const prior = identity.priorOccurrence?.detail;
    if (!prior || identity.correctionPrior !== null) return false;
    const nextTerminal =
      state === 'qualifiedIncrease'
        ? 'open'
        : state === 'insufficientBaseline'
          ? 'insufficientBaseline'
          : state === 'unavailable'
            ? 'unavailable'
            : null;
    const priorTerminal = prior.lifecycleHistory.at(-1)?.state;
    if (nextTerminal === null || priorTerminal === nextTerminal) return false;
    return state === 'qualifiedIncrease'
      ? prior.lifecycleHistory.length > 48
      : prior.lifecycleHistory.length >= 46;
  }

  function stalePriorPublication(
    prior: PriorRecurringOccurrenceV1,
    options: RecurringAmountDetectorOptionsV1
  ): EvaluationPublicationV1['occurrences'][number] {
    const warningReason = freshnessReasonFor(options) ?? 'source_unavailable';
    const suffix = `Source coverage is ${freshnessFor(options).state}; this is the last reliable result.`;
    const priorBase = prior.detail.explanation.replace(
      /\s*Source coverage is (?:stale|partial|unavailable); this is the last reliable result\.$/,
      ''
    );
    const maximumBaseLength = 500 - suffix.length - 1;
    const explanation = `${priorBase.slice(0, maximumBaseLength).trimEnd()} ${suffix}`;
    const detail = parseInsightOccurrenceDetailV1({
      ...prior.detail,
      reasonCodes: orderedReasons([
        ...prior.detail.reasonCodes,
        warningReason,
      ]),
      explanation,
      freshness: freshnessFor(options),
      provenance: {
        ...prior.detail.provenance,
        connectorRef: options.source.connectorRef,
        sourceGeneration: options.source.sourceGeneration,
        bridgeContractVersion: options.source.bridgeContractVersion,
        sourceAsOf: options.source.sourceAsOf,
        coverageStart: options.source.coverageStart,
        coverageEnd: options.source.coverageEnd,
        completeness: options.source.completeness,
        detectorSetVersion: options.assignment.identity.detectorSetVersion,
        policyVersion: options.assignment.identity.policyVersion,
        evaluationStartedAt: options.assignment.acceptedAt,
        evaluationCompletedAt: options.completedAt,
      },
      updatedAt: options.completedAt,
    });
    return { detail, sourceRevisionRef: prior.sourceRevisionRef };
  }
  const detail = buildDetail({
    recurring,
    current,
    history,
    evidence,
    exclusionCounts,
    computation,
    identity,
    seasonalYears,
    seasonal,
    options,
  });
  return {
    analysis,
    publication: { detail, sourceRevisionRef: identity.sourceRevisionRef },
    transition,
  };
}

function computeAnalysis(
  observedAmountMinor: number,
  seasonalAmounts: readonly number[],
  seasonalYears: number,
  evidence: EvidenceContext,
  options: RecurringAmountDetectorOptionsV1
): AnalysisComputation {
  const reasons: ReasonCodeV1[] = [];
  if (!evidence.optionalEvidenceAvailable) {
    reasons.push('optional_evidence_unavailable');
  }
  if (
    seasonalYears < options.policy.recurringAmount.minimumSeasonalYears ||
    seasonalAmounts.length === 0
  ) {
    reasons.push('seasonal_baseline_insufficient');
    const freshnessReason = freshnessReasonFor(options);
    if (freshnessReason !== null) reasons.push(freshnessReason);
    return {
      state: freshnessReason === null ? 'insufficientBaseline' : 'unavailable',
      center: null,
      scaledMad: null,
      lower: null,
      upper: null,
      absoluteDelta: null,
      gateAbsoluteDelta: null,
      percentageBasisPoints: null,
      absoluteGatePassed: false,
      relativeGatePassed: false,
      reasonCodes: orderedReasons(reasons),
    };
  }
  const center30 = median(seasonalAmounts);
  const mad30 = medianRationals(
    seasonalAmounts.map((amount) =>
      absolute(subtract(integer(amount), center30))
    )
  );
  const scaledMad30 = multiply(
    mad30,
    rational(
      BigInt(options.policy.recurringAmount.scaledMadMultiplierMilli),
      1_000n
    )
  );
  const spread30 = maxRational(
    scaledMad30,
    integer(options.policy.recurringAmount.minimumSpreadMinor)
  );
  if (isZero(mad30)) reasons.push('zero_mad_minimum_spread');

  const observed30 = equivalentThirtyDayAmount(
    observedAmountMinor,
    evidence.billingPeriodDays
  );
  const lower30 = maxRational(integer(0), subtract(center30, spread30));
  const upper30 = add(center30, spread30);
  const gateDelta = subtract(observed30, center30);
  const outside =
    compare(observed30, upper30) > 0 || compare(observed30, lower30) < 0;
  const absoluteGatePassed =
    compare(
      absolute(gateDelta),
      integer(options.policy.recurringAmount.absoluteGateMinor)
    ) >= 0;
  const relativeGatePassed =
    !isZero(center30) &&
    compare(
      multiply(absolute(gateDelta), integer(10_000)),
      multiply(
        absolute(center30),
        integer(options.policy.recurringAmount.relativeGateBasisPoints)
      )
    ) >= 0;
  const periodScale = evidence.billingPeriodDays
    ? rational(BigInt(evidence.billingPeriodDays), 30n)
    : integer(1);
  if (evidence.periodNormalized) reasons.push('period_normalized');
  const center = multiply(center30, periodScale);
  const scaledMad = multiply(scaledMad30, periodScale);
  const spread = multiply(spread30, periodScale);
  const lower = maxRational(integer(0), subtract(center, spread));
  const upper = add(center, spread);
  const observed = integer(observedAmountMinor);
  const delta = subtract(observed, center);
  if (absoluteGatePassed) reasons.push('recurring_absolute_gate_exceeded');
  if (relativeGatePassed) reasons.push('recurring_relative_gate_exceeded');
  let state: RecurringAmountAnalysisStateV1 = 'withinExpectedRange';
  if (outside && absoluteGatePassed && relativeGatePassed) {
    if (compare(gateDelta, integer(0)) > 0) {
      state = 'qualifiedIncrease';
    } else {
      state = 'decreaseAnalysisOnly';
      reasons.push('recurring_decrease_analysis_only');
    }
  }
  const freshnessReason = freshnessReasonFor(options);
  if (freshnessReason !== null) {
    state = 'unavailable';
    reasons.push(freshnessReason);
  }
  return {
    state,
    center,
    scaledMad,
    lower,
    upper,
    absoluteDelta: delta,
    gateAbsoluteDelta: gateDelta,
    percentageBasisPoints: isZero(center30)
      ? null
      : clampBasisPoints(
          roundRational(
            multiply(divide(gateDelta, center30), integer(10_000))
          )
        ),
    absoluteGatePassed,
    relativeGatePassed,
    reasonCodes: orderedReasons(reasons),
  };
}

interface IdentityResult {
  insightId: string;
  occurrenceId: string;
  sourceRevisionRef: string;
  deliveryRevision: number;
  createdAt: string;
  lifecycleHistory: InsightOccurrenceDetailV1['lifecycleHistory'];
  priorOccurrence: PriorRecurringOccurrenceV1 | null;
  correctionPrior: PriorRecurringOccurrenceV1 | null;
  reassignedCorrection: boolean;
  successorQualifies: boolean;
  materialRevision: boolean;
}

function identityFor(
  recurringSourceRef: string,
  transaction: TransactionSourceFactV1,
  billingPeriod: string,
  classification: string,
  associationConfidence: string,
  priorOccurrences: readonly PriorRecurringOccurrenceV1[],
  options: RecurringAmountDetectorOptionsV1,
  materialAmountMinor = spendAmount(transaction)
): IdentityResult {
  const insightId = deriveInsightIdV1(options.identityKey, {
    householdScope: options.assignment.identity.householdScope,
    kind: 'recurringAmountChange',
    entityKind: 'recurring',
    entitySourceRef: recurringSourceRef,
  });
  const prior = selectPriorOccurrence(
    priorOccurrences,
    transaction.sourceRef
  );
  const isCorrection =
    prior !== null &&
    (prior.detail.observedValue?.amountMinor !== spendAmount(transaction) ||
      prior.recurringSourceRef !== recurringSourceRef ||
      prior.billingPeriod !== billingPeriod ||
      prior.classification !== classification);
  const reassignedCorrection =
    isCorrection &&
    (prior.recurringSourceRef !== recurringSourceRef ||
      prior.billingPeriod !== billingPeriod);
  const sameEpisode =
    prior !== null &&
    prior.recurringSourceRef === recurringSourceRef &&
    prior.billingPeriod === billingPeriod;
  const materialFact = {
    associationConfidence,
    billingPeriod,
    classification,
    observedAmountMinor: spendAmount(transaction),
    recurringSourceRef,
    transactionSourceRef: transaction.sourceRef,
  };
  const sourceRevisionRef =
    sameEpisode && !isCorrection
      ? prior.sourceRevisionRef
      : deriveSourceRevisionRefV1(options.identityKey, {
          sourceKind: 'transaction',
          sourceRef: transaction.sourceRef,
          materialFact,
          predecessorRevisionRef: isCorrection ? prior.sourceRevisionRef : null,
        });
  const occurrenceId = deriveOccurrenceIdV1(options.identityKey, insightId, {
    kind: 'recurringAmountChange',
    billingPeriod,
    sourceRevisionRef,
  });
  let deliveryRevision = 1;
  let createdAt = options.completedAt;
  let lifecycleHistory: InsightOccurrenceDetailV1['lifecycleHistory'] = [];
  let materialRevision = false;
  if (sameEpisode && !isCorrection && prior.detail.occurrenceId === occurrenceId) {
    const decision = evaluateMaterialChangeV1({
      previousAmountMinor: prior.materialAmountMinor,
      nextAmountMinor: materialAmountMinor,
      previousClassification: prior.classification,
      nextClassification: classification,
      amountBoundaryMinor: options.policy.materialChange.amountBoundaryMinor,
      changeKind:
        prior.detail.observedValue?.amountMinor === spendAmount(transaction)
          ? 'evidence'
          : 'reevaluation',
    });
    deliveryRevision = nextDeliveryRevisionV1(
      prior.detail.deliveryRevision,
      decision
    );
    materialRevision = decision.lineage === 'materialRevision';
    createdAt = prior.detail.createdAt;
    lifecycleHistory = prior.detail.lifecycleHistory;
  }

  function selectPriorOccurrence(
    priorOccurrences: readonly PriorRecurringOccurrenceV1[],
    transactionSourceRef: string
  ): PriorRecurringOccurrenceV1 | null {
    const candidates = priorOccurrences
      .filter((item) => item.transactionSourceRef === transactionSourceRef)
      .sort((left, right) =>
        left.detail.occurrenceId.localeCompare(right.detail.occurrenceId)
      );
    if (candidates.length === 0) return null;
    const byOccurrenceId = new Map(
      candidates.map((item) => [item.detail.occurrenceId, item])
    );
    const successorIds = new Set(
      candidates.flatMap((item) =>
        item.detail.supersededByOccurrenceId === null
          ? []
          : [item.detail.supersededByOccurrenceId]
      )
    );
    const roots = candidates.filter(
      (item) => !successorIds.has(item.detail.occurrenceId)
    );
    const terminalSuccessors = roots.flatMap((root) => {
      const visited = new Set<string>();
      let current = root;
      while (current.detail.supersededByOccurrenceId !== null) {
        if (visited.has(current.detail.occurrenceId)) return [];
        visited.add(current.detail.occurrenceId);
        const successor = byOccurrenceId.get(
          current.detail.supersededByOccurrenceId
        );
        if (!successor) return [];
        current = successor;
      }
      return [current];
    });
    const preferredTerminal =
      terminalSuccessors.find(
        (item) => item.detail.sourceLifecycle === 'open'
      ) ??
      terminalSuccessors.find(
        (item) => item.detail.sourceLifecycle === null
      ) ??
      terminalSuccessors[0];
    if (preferredTerminal) return preferredTerminal;
    return (
      candidates.find((item) => item.detail.sourceLifecycle === 'open') ??
      candidates.find((item) => item.detail.sourceLifecycle === null) ??
      null
    );
  }
  return {
    insightId,
    occurrenceId,
    sourceRevisionRef,
    deliveryRevision,
    createdAt,
    lifecycleHistory,
    priorOccurrence: prior,
    correctionPrior: isCorrection ? prior : null,
    reassignedCorrection,
    successorQualifies: false,
    materialRevision,
  };
}

function buildDetail(input: {
  recurring: SourceProjectionV1['recurring'][number];
  current: AssociatedTransaction;
  history: readonly AssociatedTransaction[];
  evidence: EvidenceContext;
  exclusionCounts: ReturnType<typeof emptyExclusionCounts>;
  computation: AnalysisComputation;
  identity: IdentityResult;
  seasonalYears: number;
  seasonal: readonly AssociatedTransaction[];
  options: RecurringAmountDetectorOptionsV1;
}): InsightOccurrenceDetailV1 {
  const {
    recurring,
    current,
    history,
    evidence,
    exclusionCounts,
    computation,
    identity,
    seasonalYears,
    seasonal,
    options,
  } = input;
  identity.successorQualifies = computation.state === 'qualifiedIncrease';
  const billingPeriod = monthOf(current.fact.occurredOn);
  const analysisState =
    computation.state === 'qualifiedIncrease'
      ? 'qualified'
      : computation.state === 'insufficientBaseline'
        ? 'insufficientBaseline'
        : 'unavailable';
  const terminalState =
    analysisState === 'qualified' ? 'open' : analysisState;
  const terminalReason =
    terminalState === 'insufficientBaseline'
      ? 'seasonal_baseline_insufficient'
      : terminalState === 'unavailable'
        ? computation.reasonCodes.includes('source_stale')
          ? 'source_stale'
          : computation.reasonCodes.includes('source_partial')
            ? 'source_partial'
            : computation.reasonCodes.includes('classification_ambiguous')
              ? 'classification_ambiguous'
              : 'source_unavailable'
        : null;
  const lifecycleHistory = nextLifecycleHistory(
    identity.lifecycleHistory,
    terminalState,
    terminalReason,
    options
  );
  const explanation = explainRecurringAmountV1({
    displayName: recurring.displayName,
    state: computation.state,
    periodNormalized: evidence.periodNormalized,
    optionalEvidenceAvailable: evidence.optionalEvidenceAvailable,
    usageContextAvailable: evidence.usageContextAvailable,
  });
  const freshness = freshnessFor(options);
  const observedAmount = spendAmount(current.fact);
  const baselinePeriod =
    seasonal.length > 0
      ? {
          start: seasonal[0]!.fact.occurredOn,
          end: seasonal.at(-1)!.fact.occurredOn,
        }
      : null;
  const expectedRange =
    computation.lower && computation.upper
      ? {
          currency: options.source.currency,
          lowerMinor: clampAmount(floorRational(computation.lower)),
          upperMinor: clampAmount(ceilRational(computation.upper)),
        }
      : null;
  const detail = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    insightId: identity.insightId,
    occurrenceId: identity.occurrenceId,
    deliveryRevision: identity.deliveryRevision,
    kind: 'recurringAmountChange' as const,
    entity: {
      kind: 'recurring' as const,
      sourceRef: recurring.sourceRef,
      displayName: recurring.displayName,
      identityQuality: 'stableSource' as const,
    },
    analysisState,
    sourceLifecycle: analysisState === 'qualified' ? ('open' as const) : null,
    resolutionReason: null,
    supersededByOccurrenceId: null,
    severity: analysisState === 'qualified' ? ('high' as const) : ('info' as const),
    confidence: confidenceFor(
      analysisState,
      current.confidence,
      evidence,
      freshness.state
    ),
    baselineSufficiency:
      seasonalYears >= options.policy.recurringAmount.minimumSeasonalYears
        ? ('sufficient' as const)
        : seasonalYears > 0
          ? ('limited' as const)
          : ('insufficient' as const),
    reasonCodes: computation.reasonCodes,
    headline: explanation.headline,
    explanation: explanation.explanation,
    observationPeriod: calendarMonthPeriod(current.fact.occurredOn),
    baselinePeriod,
    observedValue: {
      currency: options.source.currency,
      amountMinor: observedAmount,
    },
    expectedRange,
    absoluteDelta:
      computation.absoluteDelta === null
        ? null
        : {
            currency: options.source.currency,
            amountMinor: clampAmount(roundRational(computation.absoluteDelta)),
          },
    percentageDeltaBasisPoints: computation.percentageBasisPoints,
    currency: options.source.currency,
    freshness,
    provenance: {
      connectorRef: options.source.connectorRef,
      sourceGeneration: options.source.sourceGeneration,
      bridgeContractVersion: options.source.bridgeContractVersion,
      providerClass: 'monarchBridgeNormalized' as const,
      sourceAsOf: options.source.sourceAsOf,
      coverageStart: options.source.coverageStart,
      coverageEnd: options.source.coverageEnd,
      completeness: options.source.completeness,
      detectorSetVersion: options.assignment.identity.detectorSetVersion,
      detectorVersion: RECURRING_AMOUNT_DETECTOR_VERSION_V1,
      methodVersion: RECURRING_AMOUNT_METHOD_VERSION_V1,
      explanationTemplateVersion:
        RECURRING_AMOUNT_EXPLANATION_TEMPLATE_VERSION_V1,
      policyVersion: options.policy.policyVersion,
      evaluationStartedAt: options.assignment.acceptedAt,
      evaluationCompletedAt: options.completedAt,
    },
    targets: targetsFor(recurring.sourceRef, current.fact.sourceRef, evidence.records),
    createdAt: identity.createdAt,
    updatedAt: options.completedAt,
    resolvedAt: null,
    ruleResults: ruleResultsFor(computation, observedAmount, evidence, options),
    baseline: {
      method: 'seasonalMedianMad' as const,
      windowStart: historyWindowStart(
        current.fact.occurredOn,
        options.policy.recurringAmount.historyMonths
      ),
      windowEnd: previousCalendarDay(calendarMonthPeriod(current.fact.occurredOn).start),
      sampleCount: seasonal.length,
      activePeriodCount: seasonalYears,
      robustCenterMinor:
        computation.center === null
          ? null
          : clampAmount(roundRational(computation.center)),
      dispersionMinor:
        computation.scaledMad === null
          ? null
          : Math.max(0, clampAmount(ceilRational(computation.scaledMad))),
      expectedRange,
      exclusionCounts,
    },
    comparisons: history.slice(-RECURRING_AMOUNT_MAX_COMPARISONS_V1).map((item) => {
      const eligible = seasonal.some(
        (seasonalItem) => seasonalItem.fact.sourceRef === item.fact.sourceRef
      );
      return {
        period: {
          start: item.fact.occurredOn,
          end: item.fact.occurredOn,
        },
        value: {
          currency: options.source.currency,
          amountMinor: spendAmount(item.fact),
        },
        eligible,
        contribution: eligible ? ('reinforced' as const) : ('informational' as const),
        sampleCount: 1,
        medianMinor: spendAmount(item.fact),
        dispersionMinor: 0,
        empiricalPercentileBasisPoints: null,
        ratioBasisPoints: null,
      };
    }),
    contributors: [
      {
        rank: 1,
        sourceRef: current.fact.sourceRef,
        occurredOn: current.fact.occurredOn,
        displayName: current.fact.merchantName.slice(0, 120),
        amount: {
          currency: options.source.currency,
          amountMinor: observedAmount,
        },
        contributionMinor:
          computation.absoluteDelta === null
            ? 0
            : clampAmount(roundRational(computation.absoluteDelta)),
      },
    ].slice(0, RECURRING_AMOUNT_MAX_CONTRIBUTORS_V1),
    exclusions: exclusionReasons(exclusionCounts),
    evidence: evidence.records,
    lifecycleHistory,
    suppression: EMPTY_SUPPRESSION,
    availableActions:
      analysisState === 'qualified'
        ? ([
            'expected',
            'notUseful',
            'suppress30Days',
            'suppress90Days',
            'suppress180Days',
          ] as const)
        : [],
  };
  return parseInsightOccurrenceDetailV1(detail);
}

function ruleResultsFor(
  computation: AnalysisComputation,
  observedAmount: number,
  evidence: EvidenceContext,
  options: RecurringAmountDetectorOptionsV1
): InsightOccurrenceDetailV1['ruleResults'] {
  const results: InsightOccurrenceDetailV1['ruleResults'][number][] = [
    {
      ruleCode: 'recurring_expected_range',
      outcome:
        computation.state === 'qualifiedIncrease' ||
        computation.state === 'decreaseAnalysisOnly'
          ? 'triggered'
          : computation.center === null
            ? 'notEligible'
            : 'informational',
      observedMinor: observedAmount,
      thresholdMinor: null,
      observedBasisPoints: computation.percentageBasisPoints,
      thresholdBasisPoints: null,
      reasonCodes: [],
    },
    {
      ruleCode: 'recurring_absolute_gate',
      outcome: computation.absoluteGatePassed ? 'triggered' : 'notEligible',
      observedMinor:
        computation.gateAbsoluteDelta === null
          ? null
          : Math.abs(
              clampAmount(roundRational(computation.gateAbsoluteDelta))
            ),
      thresholdMinor: options.policy.recurringAmount.absoluteGateMinor,
      observedBasisPoints: null,
      thresholdBasisPoints: null,
      reasonCodes: computation.absoluteGatePassed
        ? ['recurring_absolute_gate_exceeded']
        : [],
    },
    {
      ruleCode: 'recurring_relative_gate',
      outcome: computation.relativeGatePassed ? 'triggered' : 'notEligible',
      observedMinor: null,
      thresholdMinor: null,
      observedBasisPoints:
        computation.percentageBasisPoints === null
          ? null
          : Math.abs(computation.percentageBasisPoints),
      thresholdBasisPoints: options.policy.recurringAmount.relativeGateBasisPoints,
      reasonCodes: computation.relativeGatePassed
        ? ['recurring_relative_gate_exceeded']
        : [],
    },
  ];
  if (computation.reasonCodes.includes('period_normalized')) {
    results.push({
      ruleCode: 'recurring_period_normalization',
      outcome: 'informational',
      observedMinor: observedAmount,
      thresholdMinor: null,
      observedBasisPoints: null,
      thresholdBasisPoints: null,
      reasonCodes: ['period_normalized'],
    });
  }
  if (evidence.usageContext) {
    results.push(
      {
        ruleCode: 'recurring_usage_context',
        outcome: 'informational',
        observedMinor: null,
        thresholdMinor: null,
        observedBasisPoints: evidence.usageContext.usageChangeBasisPoints,
        thresholdBasisPoints: null,
        reasonCodes: [],
      },
      {
        ruleCode: 'recurring_unit_cost_context',
        outcome: 'informational',
        observedMinor: roundRational(
          rational(
            BigInt(evidence.usageContext.unitCostMilliMinorPerUsage),
            1_000n
          )
        ),
        thresholdMinor: null,
        observedBasisPoints: evidence.usageContext.unitCostChangeBasisPoints,
        thresholdBasisPoints: null,
        reasonCodes: [],
      }
    );
  }
  return results;
}

function nextLifecycleHistory(
  prior: InsightOccurrenceDetailV1['lifecycleHistory'],
  terminalState: 'open' | 'insufficientBaseline' | 'unavailable',
  reasonCode: ReasonCodeV1 | null,
  options: RecurringAmountDetectorOptionsV1
): InsightOccurrenceDetailV1['lifecycleHistory'] {
  if (prior.length === 0) {
    return [
      {
        sequence: 1,
        state: 'analyzing',
        reasonCode: null,
        occurredAt: options.assignment.acceptedAt,
        replacementOccurrenceId: null,
      },
      {
        sequence: 2,
        state: terminalState,
        reasonCode,
        occurredAt: options.completedAt,
        replacementOccurrenceId: null,
      },
    ];
  }
  const priorTerminal = prior.at(-1)!;
  if (priorTerminal.state === terminalState) return prior;
  if (
    priorTerminal.state === 'insufficientBaseline' ||
    priorTerminal.state === 'unavailable'
  ) {
    const sequence = priorTerminal.sequence;
    return [
      ...prior,
      {
        sequence: sequence + 1,
        state: 'analyzing',
        reasonCode: null,
        occurredAt: options.assignment.acceptedAt,
        replacementOccurrenceId: null,
      },
      {
        sequence: sequence + 2,
        state: terminalState,
        reasonCode,
        occurredAt: options.completedAt,
        replacementOccurrenceId: null,
      },
    ];
  }
  return prior;
}

function correctionTransition(
  identity: IdentityResult,
  successorPublished: boolean,
  occurredAt: string
): EvaluationPublicationV1['transitions'][number] | null {
  if (!identity.correctionPrior) return null;
  if (identity.correctionPrior.detail.sourceLifecycle !== 'open') return null;
  if (successorPublished) {
    return {
      occurrenceId: identity.correctionPrior.detail.occurrenceId,
      state: 'superseded',
      reasonCode: 'correction_superseded',
      replacementOccurrenceId: identity.occurrenceId,
      occurredAt,
    };
  }

  return {
    occurrenceId: identity.correctionPrior.detail.occurrenceId,
    state: 'resolved',
    reasonCode: 'correction_resolved',
    replacementOccurrenceId: null,
    occurredAt,
  };
}

function reliableReevaluationTransition(
  identity: IdentityResult,
  state: RecurringAmountAnalysisStateV1,
  occurredAt: string
): EvaluationPublicationV1['transitions'][number] | null {
  if (
    identity.correctionPrior ||
    identity.priorOccurrence?.detail.sourceLifecycle !== 'open' ||
    (state !== 'withinExpectedRange' && state !== 'decreaseAnalysisOnly')
  ) {
    return null;
  }
  return {
    occurrenceId: identity.priorOccurrence.detail.occurrenceId,
    state: 'resolved',
    reasonCode: 'correction_resolved',
    replacementOccurrenceId: null,
    occurredAt,
  };
}

function analysisFrom(
  recurringSourceRef: string,
  current: AssociatedTransaction,
  billingPeriod: string,
  seasonal: readonly AssociatedTransaction[],
  seasonalYears: number,
  computation: AnalysisComputation,
  evidence: EvidenceContext,
  occurrenceId: string
): RecurringAmountAnalysisV1 {
  const observed = spendAmount(current.fact);
  return {
    recurringSourceRef,
    transactionSourceRef: current.fact.sourceRef,
    billingPeriod,
    state: computation.state,
    associationConfidence: current.confidence,
    observedAmountMinor: observed,
    analysisAmountMinor:
      roundRational(
        equivalentThirtyDayAmount(observed, evidence.billingPeriodDays)
      ),
    seasonalSampleCount: seasonal.length,
    seasonalYearCount: seasonalYears,
    robustCenterMinor:
      computation.center === null ? null : roundRational(computation.center),
    scaledMadMinor:
      computation.scaledMad === null ? null : ceilRational(computation.scaledMad),
    expectedLowerMinor:
      computation.lower === null ? null : floorRational(computation.lower),
    expectedUpperMinor:
      computation.upper === null ? null : ceilRational(computation.upper),
    absoluteVarianceMinor:
      computation.absoluteDelta === null
        ? null
        : roundRational(computation.absoluteDelta),
    percentageVarianceBasisPoints: computation.percentageBasisPoints,
    absoluteGatePassed: computation.absoluteGatePassed,
    relativeGatePassed: computation.relativeGatePassed,
    reasonCodes: computation.reasonCodes,
    usageContext: evidence.usageContext,
    occurrenceId,
  };
}

function baseAnalysis(input: {
  recurringSourceRef: string;
  transactionSourceRef: string | null;
  billingPeriod: string | null;
  state: RecurringAmountAnalysisStateV1;
  associationConfidence: RecurringAssociationV1['confidence'] | null;
  observedAmountMinor: number | null;
  analysisAmountMinor: number | null;
  reasonCodes: readonly ReasonCodeV1[];
}): RecurringAmountAnalysisV1 {
  return {
    ...input,
    seasonalSampleCount: 0,
    seasonalYearCount: 0,
    robustCenterMinor: null,
    scaledMadMinor: null,
    expectedLowerMinor: null,
    expectedUpperMinor: null,
    absoluteVarianceMinor: null,
    percentageVarianceBasisPoints: null,
    absoluteGatePassed: false,
    relativeGatePassed: false,
    usageContext: null,
    occurrenceId: null,
  };
}

function unavailableComputation(
  reasonCodes: readonly ReasonCodeV1[]
): AnalysisComputation {
  return {
    state: 'unavailable',
    center: null,
    scaledMad: null,
    lower: null,
    upper: null,
    absoluteDelta: null,
    gateAbsoluteDelta: null,
    percentageBasisPoints: null,
    absoluteGatePassed: false,
    relativeGatePassed: false,
    reasonCodes: [...reasonCodes],
  };
}

function associateTransaction(
  transaction: TransactionSourceFactV1,
  recurringFacts: readonly SourceProjectionV1['recurring'][number][],
  recurringByRef: ReadonlyMap<string, SourceProjectionV1['recurring'][number]>,
  configured: ReadonlyMap<string, string>
):
  | { kind: 'none' }
  | {
      kind: 'one';
      recurringRef: string;
      confidence: 'exact' | 'configured';
    }
  | { kind: 'ambiguous'; recurringRefs: readonly string[] } {
  if (transaction.recurringRef !== null) {
    return recurringByRef.has(transaction.recurringRef)
      ? {
          kind: 'one',
          recurringRef: transaction.recurringRef,
          confidence: 'exact',
        }
      : { kind: 'none' };
  }
  const configuredRef = configured.get(transaction.sourceRef);
  if (configuredRef) {
    return {
      kind: 'one',
      recurringRef: configuredRef,
      confidence: 'configured',
    };
  }
  const merchant = normalizeIdentityTextV1(transaction.merchantName);
  const candidates = recurringFacts.filter(
    (recurring) =>
      normalizeIdentityTextV1(recurring.displayName) === merchant &&
      contextMatches(transaction.accountRef, recurring.accountRef) &&
      contextMatches(transaction.categoryRef, recurring.categoryRef) &&
      cadenceMatches(transaction.occurredOn, recurring)
  );
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) {
    return {
      kind: 'one',
      recurringRef: candidates[0]!.sourceRef,
      confidence: 'exact',
    };
  }
  return {
    kind: 'ambiguous',
    recurringRefs: candidates.map((candidate) => candidate.sourceRef).sort(),
  };
}

function configuredAssociationMap(
  associations: readonly ConfiguredRecurringAssociationV1[],
  recurringByRef: ReadonlyMap<string, SourceProjectionV1['recurring'][number]>
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const association of [...associations].sort(
    (left, right) =>
      left.transactionSourceRef.localeCompare(right.transactionSourceRef) ||
      left.recurringSourceRef.localeCompare(right.recurringSourceRef)
  )) {
    if (
      !recurringByRef.has(association.recurringSourceRef) ||
      conflicts.has(association.transactionSourceRef)
    ) {
      continue;
    }
    const existing = result.get(association.transactionSourceRef);
    if (existing && existing !== association.recurringSourceRef) {
      result.delete(association.transactionSourceRef);
      conflicts.add(association.transactionSourceRef);
      continue;
    }
    result.set(association.transactionSourceRef, association.recurringSourceRef);
  }
  return result;
}

function normalizeEvidence(
  records: readonly EvidenceRecordV1[],
  current: TransactionSourceFactV1 | null,
  bindings: readonly RecurringEvidenceBindingV1[]
): EvidenceContext {
  const boundDocumentRefs =
    current === null
      ? new Set<string>()
      : new Set(
          bindings
            .filter(
              (binding) =>
                binding.transactionSourceRef === current.sourceRef
            )
            .map((binding) => binding.documentRef)
        );
  const sorted = records
    .filter((item) => {
      if (current === null || item.source !== 'owl') return false;
      if (boundDocumentRefs.size > 0) {
        return (
          item.documentRef !== null &&
          boundDocumentRefs.has(item.documentRef)
        );
      }
      return item.observedAt.slice(0, 10) === current.occurredOn;
    })
    .sort(
      (left, right) =>
        left.evidenceType.localeCompare(right.evidenceType) ||
        left.observedAt.localeCompare(right.observedAt) ||
        (left.documentRef ?? '').localeCompare(right.documentRef ?? '')
    )
    .slice(0, 8);
  const billingPeriods = sorted.filter(
    (item) =>
      item.source === 'owl' &&
      item.evidenceType === 'billingPeriod' &&
      item.normalizedUnit === 'days' &&
      item.normalizedValueMinor !== null &&
      item.normalizedValueMinor > 0 &&
      item.normalizedValueMinor <= 366
  );
  const billingPeriodDays =
    billingPeriods.length === 1
      ? billingPeriods[0]!.normalizedValueMinor
      : null;
  const usage = sorted.some(
    (item) =>
      item.source === 'owl' &&
      item.evidenceType === 'usage' &&
      item.normalizedUnit === 'usageUnit' &&
      item.normalizedValueMinor !== null &&
      item.normalizedValueMinor >= 0
  );
  const billAmount = sorted.some(
    (item) =>
      item.source === 'owl' &&
      item.evidenceType === 'billAmount' &&
      item.normalizedUnit === 'currencyMinor' &&
      item.normalizedValueMinor !== null
  );
  const usageContext = usageContextFrom(sorted);
  return {
    records: sorted,
    billingPeriodDays,
    periodNormalized: billingPeriodDays !== null && billingPeriodDays !== 30,
    usageContextAvailable:
      usage && billAmount && billingPeriodDays !== null && usageContext !== null,
    usageContext,
    optionalEvidenceAvailable:
      billingPeriodDays !== null || usage || billAmount,
  };
}

function usageContextFrom(
  evidence: readonly EvidenceRecordV1[]
): RecurringUsageContextV1 | null {
  const groups = new Map<
    string,
    { usage: number | null; billAmountMinor: number | null }
  >();
  for (const item of evidence) {
    if (
      item.source !== 'owl' ||
      item.normalizedValueMinor === null ||
      (item.evidenceType !== 'usage' && item.evidenceType !== 'billAmount')
    ) {
      continue;
    }
    const group = groups.get(item.observedAt) ?? {
      usage: null,
      billAmountMinor: null,
    };
    if (
      item.evidenceType === 'usage' &&
      item.normalizedUnit === 'usageUnit' &&
      item.normalizedValueMinor > 0
    ) {
      group.usage = item.normalizedValueMinor;
    }
    if (
      item.evidenceType === 'billAmount' &&
      item.normalizedUnit === 'currencyMinor' &&
      item.normalizedValueMinor >= 0
    ) {
      group.billAmountMinor = item.normalizedValueMinor;
    }
    groups.set(item.observedAt, group);
  }
  const complete = [...groups.entries()]
    .filter(
      (
        item
      ): item is [string, { usage: number; billAmountMinor: number }] =>
        item[1].usage !== null && item[1].billAmountMinor !== null
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
  const current = complete.at(-1)?.[1];
  if (!current) return null;
  const previous = complete.at(-2)?.[1] ?? null;
  const currentUnitCost = divide(
    integer(current.billAmountMinor),
    integer(current.usage)
  );
  const previousUnitCost = previous
    ? divide(integer(previous.billAmountMinor), integer(previous.usage))
    : null;
  return {
    usageUnits: current.usage,
    billAmountMinor: current.billAmountMinor,
    unitCostMilliMinorPerUsage: roundRational(
      multiply(currentUnitCost, integer(1_000))
    ),
    usageChangeBasisPoints: previous
      ? ratioChangeBasisPoints(current.usage, previous.usage)
      : null,
    unitCostChangeBasisPoints:
      previousUnitCost && !isZero(previousUnitCost)
        ? clampBasisPoints(
            roundRational(
              multiply(
                divide(
                  subtract(currentUnitCost, previousUnitCost),
                  previousUnitCost
                ),
                integer(10_000)
              )
            )
          )
        : null,
  };
}

function ratioChangeBasisPoints(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return clampBasisPoints(
    roundRational(
      multiply(
        divide(integer(current - previous), integer(previous)),
        integer(10_000)
      )
    )
  );
}

function targetsFor(
  recurringSourceRef: string,
  transactionSourceRef: string,
  evidence: readonly EvidenceRecordV1[]
): InsightOccurrenceDetailV1['targets'] {
  const targets: InsightOccurrenceDetailV1['targets'] = [
    {
      system: 'monarch',
      targetKind: 'recurring',
      sourceRef: recurringSourceRef,
    },
    {
      system: 'monarch',
      targetKind: 'transaction',
      sourceRef: transactionSourceRef,
    },
  ];
  const owlRefs = [
    ...new Set(
      evidence
        .filter((item) => item.source === 'owl' && item.documentRef !== null)
        .map((item) => item.documentRef!)
    ),
  ].sort();
  for (const sourceRef of owlRefs.slice(0, 2)) {
    targets.push({ system: 'owl', targetKind: 'document', sourceRef });
  }
  return targets;
}

function freshnessFor(options: RecurringAmountDetectorOptionsV1) {
  const reason = freshnessReasonFor(options);
  const state =
    reason === null
      ? ('fresh' as const)
      : reason === 'source_stale'
        ? ('stale' as const)
        : reason === 'source_partial'
          ? ('partial' as const)
          : ('unavailable' as const);
  return {
    state,
    sourceAsOf: options.source.sourceAsOf,
    maxAgeHours: 48 as const,
    warningReason: reason,
  };
}

function freshnessReasonFor(
  options: RecurringAmountDetectorOptionsV1
): Extract<
  ReasonCodeV1,
  'source_stale' | 'source_partial' | 'source_unavailable'
> | null {
  if (options.source.completeness === 'partial') return 'source_partial';
  if (options.source.completeness === 'unavailable') return 'source_unavailable';
  const source = Date.parse(options.source.sourceAsOf);
  const completed = Date.parse(options.completedAt);
  if (
    source > completed ||
    completed - source >
      options.policy.freshness.newAlertMaxAgeHours * 60 * 60 * 1_000
  ) {
    return 'source_stale';
  }
  return null;
}

function confidenceFor(
  analysisState: 'qualified' | 'insufficientBaseline' | 'unavailable',
  association: RecurringAssociationV1['confidence'],
  evidence: EvidenceContext,
  freshness: 'fresh' | 'stale' | 'partial' | 'unavailable'
): 'low' | 'medium' | 'high' {
  if (
    analysisState === 'insufficientBaseline' ||
    analysisState === 'unavailable' ||
    freshness !== 'fresh'
  ) {
    return 'low';
  }
  if (association !== 'exact' || !evidence.optionalEvidenceAvailable) return 'medium';
  return 'high';
}

function validateEvaluationFence(options: RecurringAmountDetectorOptionsV1): void {
  if (
    options.assignment.identity.connectorRef !== options.source.connectorRef ||
    options.assignment.identity.sourceGeneration !== options.source.sourceGeneration ||
    options.assignment.identity.detectorSetVersion !== options.policy.detectorSetVersion ||
    options.assignment.identity.policyVersion !== options.policy.policyVersion
  ) {
    throw new RangeError('Recurring detector input does not match the assigned evaluation');
  }
  if (options.source.currency !== options.policy.currency) {
    throw new RangeError('Recurring detector source currency conflicts with policy');
  }
  if (
    Number.isNaN(Date.parse(options.completedAt)) ||
    Date.parse(options.completedAt) < Date.parse(options.assignment.acceptedAt)
  ) {
    throw new RangeError('Recurring detector completedAt must follow assignment acceptance');
  }
}

function emptyResult(
  completedAt: string,
  state: 'completed' | 'unavailable'
): RecurringAmountDetectorResultV1 {
  return {
    analyses: [],
    associations: [],
    publication:
      state === 'completed'
        ? { occurrences: [], transitions: [], exclusionSummary: {} }
        : null,
    terminalResult:
      state === 'completed'
        ? { state, summaries: [], completedAt }
        : { state, completedAt },
  };
}

function summaryFrom(
  detail: InsightOccurrenceDetailV1
): InsightOccurrenceSummaryV1 {
  const {
    ruleResults: _ruleResults,
    baseline: _baseline,
    comparisons: _comparisons,
    contributors: _contributors,
    exclusions: _exclusions,
    evidence: _evidence,
    lifecycleHistory: _history,
    suppression: _suppression,
    availableActions: _actions,
    ...summary
  } = detail;
  return parseInsightOccurrenceSummaryV1(summary);
}

function emptyExclusionCounts() {
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

function recordExclusion(
  counts: ReturnType<typeof emptyExclusionCounts>,
  classification: TransactionClassificationResultV1
): void {
  if (
    classification.classification !== 'postedSpend' &&
    classification.classification !== 'knownRecurring'
  ) {
    counts[classification.classification] += 1;
  }
}

function exclusionReasons(
  counts: ReturnType<typeof emptyExclusionCounts>
): ReasonCodeV1[] {
  const countByReason: Readonly<Partial<Record<ReasonCodeV1, number>>> = {
    pending_excluded: counts.pending,
    transfer_excluded: counts.transfer,
    income_excluded: counts.income,
    refund_excluded: counts.refund,
    unclassified_credit_excluded: counts.unclassifiedCredit,
    policy_excluded: counts.policyExcluded,
  };
  return EXCLUSION_REASON_ORDER.filter((reason) => (countByReason[reason] ?? 0) > 0);
}

function exclusionSummary(
  counts: ReturnType<typeof emptyExclusionCounts>,
  ambiguous: ReadonlyMap<string, readonly TransactionSourceFactV1[]>
): Readonly<Record<string, number>> {
  return {
    pending_excluded: counts.pending,
    transfer_excluded: counts.transfer,
    income_excluded: counts.income,
    refund_excluded: counts.refund,
    unclassified_credit_excluded: counts.unclassifiedCredit,
    policy_excluded: counts.policyExcluded,
    classification_ambiguous: [...ambiguous.values()].reduce(
      (total, values) => total + values.length,
      0
    ),
  };
}

function orderedReasons(reasons: readonly ReasonCodeV1[]): ReasonCodeV1[] {
  const order: readonly ReasonCodeV1[] = [
    'recurring_absolute_gate_exceeded',
    'recurring_relative_gate_exceeded',
    'recurring_decrease_analysis_only',
    'seasonal_baseline_insufficient',
    'zero_mad_minimum_spread',
    'period_normalized',
    'optional_evidence_unavailable',
    'classification_ambiguous',
    'source_stale',
    'source_partial',
    'source_unavailable',
    'material_source_change',
  ];
  const unique = new Set(reasons);
  return order.filter((reason) => unique.has(reason)).slice(0, 12);
}

function equivalentThirtyDayAmount(
  observedAmount: number,
  billingPeriodDays: number | null
): Rational {
  return billingPeriodDays === null
    ? integer(observedAmount)
    : multiply(integer(observedAmount), rational(30n, BigInt(billingPeriodDays)));
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function contextMatches(left: string | null, right: string | null): boolean {
  return right === null || left === right;
}

function cadenceMatches(
  occurredOn: string,
  recurring: SourceProjectionV1['recurring'][number]
): boolean {
  if (
    recurring.nextDate === null ||
    recurring.cadence === 'unknown' ||
    recurring.cadence === 'weekly' ||
    recurring.cadence === 'biweekly'
  ) {
    return false;
  }
  const intervalMonths = {
    monthly: 1,
    quarterly: 3,
    semiannual: 6,
    annual: 12,
  }[recurring.cadence];
  const difference = Math.abs(
    monthIndex(recurring.nextDate) - monthIndex(occurredOn)
  );
  if (difference % intervalMonths !== 0) return false;
  const occurredDay = Number(occurredOn.slice(8, 10));
  const expectedDay = Number(recurring.nextDate.slice(8, 10));
  const occurredMonthEnd = calendarMonthPeriod(occurredOn).end.endsWith(
    occurredOn.slice(8, 10)
  );
  const expectedMonthEnd = calendarMonthPeriod(recurring.nextDate).end.endsWith(
    recurring.nextDate.slice(8, 10)
  );
  return (
    Math.abs(occurredDay - expectedDay) <= 3 ||
    (occurredMonthEnd && expectedMonthEnd)
  );
}

function transactionOrder(
  left: TransactionSourceFactV1,
  right: TransactionSourceFactV1
): number {
  return (
    left.occurredOn.localeCompare(right.occurredOn) ||
    left.sourceRef.localeCompare(right.sourceRef)
  );
}

function associatedTransactionOrder(
  left: AssociatedTransaction,
  right: AssociatedTransaction
): number {
  return transactionOrder(left.fact, right.fact);
}

function spendAmount(transaction: TransactionSourceFactV1): number {
  return -transaction.amountMinor;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

function monthNumber(date: string): number {
  return Number(date.slice(5, 7));
}

function monthIndex(date: string): number {
  return yearOf(date) * 12 + monthNumber(date) - 1;
}

function circularMonthDistance(left: number, right: number): number {
  const distance = Math.abs(left - right);
  return Math.min(distance, 12 - distance);
}

function calendarMonthPeriod(date: string): { start: string; end: string } {
  const year = yearOf(date);
  const month = monthNumber(date);
  const end = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${date.slice(0, 7)}-01`,
    end: `${date.slice(0, 7)}-${String(end).padStart(2, '0')}`,
  };
}

function historyWindowStart(date: string, months: number): string {
  const value = new Date(Date.UTC(yearOf(date), monthNumber(date) - 1 - months, 1));
  return value.toISOString().slice(0, 10);
}

function previousCalendarDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function clampAmount(value: number): number {
  return Math.max(-MAX_AMOUNT_MINOR_V1, Math.min(MAX_AMOUNT_MINOR_V1, value));
}

function clampBasisPoints(value: number): number {
  return Math.max(-1_000_000, Math.min(1_000_000, value));
}

function integer(value: number): Rational {
  return rational(BigInt(value), 1n);
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

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function subtract(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function multiply(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator
  );
}

function divide(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator,
    left.denominator * right.numerator
  );
}

function absolute(value: Rational): Rational {
  return {
    numerator: value.numerator < 0n ? -value.numerator : value.numerator,
    denominator: value.denominator,
  };
}

function compare(left: Rational, right: Rational): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function maxRational(left: Rational, right: Rational): Rational {
  return compare(left, right) >= 0 ? left : right;
}

function isZero(value: Rational): boolean {
  return value.numerator === 0n;
}

function median(values: readonly number[]): Rational {
  return medianRationals(values.map(integer));
}

function medianRationals(values: readonly Rational[]): Rational {
  if (values.length === 0) throw new RangeError('Median requires at least one value');
  const ordered = [...values].sort(compare);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return divide(add(ordered[middle - 1]!, ordered[middle]!), integer(2));
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

function roundRational(value: Rational): number {
  const negative = value.numerator < 0n;
  const magnitude = negative ? -value.numerator : value.numerator;
  const quotient = magnitude / value.denominator;
  const remainder = magnitude % value.denominator;
  const rounded = remainder * 2n >= value.denominator ? quotient + 1n : quotient;
  return Number(negative ? -rounded : rounded);
}
