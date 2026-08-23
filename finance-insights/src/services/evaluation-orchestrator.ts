import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  parseEvaluationResultV1,
  type AssignedEvaluationV1,
  type InsightOccurrenceDetailV1,
  type InsightOccurrenceSummaryV1,
} from '../contracts/v1.js';
import { canonicalDigestV1, type CanonicalJsonValue } from '../core/canonical.js';
import {
  deriveInsightIdV1,
  deriveMerchantKeyV1,
} from '../core/identity.js';
import {
  evaluateLargeTransactionsV1,
  evaluateRecurringAmountDetectorV1,
  evaluateVarianceProjectionV1,
  type ClassifiedVarianceTransactionV1,
  type PreviousLargeTransactionOccurrenceV1,
  type PriorRecurringOccurrenceV1,
  type VarianceEntityClassificationLineageV1,
} from '../detectors/index.js';
import type {
  EvaluationPublicationV1,
  FinanceInsightSqliteStoreV1,
  OccurrencePublicationV1,
} from '../persistence/sqlite-store.js';
import { storeError } from '../persistence/errors.js';
import type { EvaluationRecordV1 } from '../ports/repositories.js';
import { FinanceInsightLifecycleServiceV1 } from './lifecycle.js';

const MAX_COMPOSED_OCCURRENCES_V1 = 5_110;
const MAX_COMPOSED_TRANSITIONS_V1 = 6_000;
const MAX_OPERATOR_EVALUATIONS_V1 = 100;

export type FinanceInsightTelemetryEventV1 =
  | {
      name: 'evaluation_started';
      detectorCount: 3;
    }
  | {
      name: 'evaluation_completed';
      detectorCount: 3;
      occurrenceCount: number;
      transitionCount: number;
      empty: boolean;
    }
  | {
      name: 'evaluation_failed';
      detectorCount: 3;
      code: 'source_unavailable' | 'operation_failed';
    };

export interface FinanceInsightTelemetrySinkV1 {
  emit(event: FinanceInsightTelemetryEventV1): void;
}

export interface FinanceInsightEvaluationOrchestratorOptionsV1 {
  store: FinanceInsightSqliteStoreV1;
  lifecycle: FinanceInsightLifecycleServiceV1;
  identityNamespace: Uint8Array;
  telemetry?: FinanceInsightTelemetrySinkV1;
  clock?: () => string;
  testHook?: (point: 'afterClaim') => void | Promise<void>;
}

export interface FinanceInsightOperatorRunResultV1 {
  requested: number;
  completed: number;
  unavailable: number;
  failed: number;
}

export class FinanceInsightEvaluationOrchestratorV1 {
  private readonly store: FinanceInsightSqliteStoreV1;
  private readonly lifecycle: FinanceInsightLifecycleServiceV1;
  private readonly identityNamespace: Uint8Array;
  private readonly telemetry: FinanceInsightTelemetrySinkV1 | undefined;
  private readonly clock: () => string;
  private readonly testHook:
    | ((point: 'afterClaim') => void | Promise<void>)
    | undefined;

  constructor(options: FinanceInsightEvaluationOrchestratorOptionsV1) {
    if (options.identityNamespace.byteLength < 32) {
      throw new RangeError(
        'Finance insight identity namespace must contain at least 32 bytes'
      );
    }
    this.store = options.store;
    this.lifecycle = options.lifecycle;
    this.identityNamespace = Uint8Array.from(options.identityNamespace);
    this.telemetry = options.telemetry;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.testHook = options.testHook;
  }

  async run(assignment: AssignedEvaluationV1): Promise<EvaluationRecordV1> {
    await this.lifecycle.claimEvaluation(assignment);
    let completedAt = assignment.acceptedAt;
    try {
      await this.testHook?.('afterClaim');
      this.emitTelemetry({ name: 'evaluation_started', detectorCount: 3 });
      const source = await this.store.sourceGenerations.find(
        assignment.identity.connectorRef,
        assignment.identity.sourceGeneration
      );
      const policy = await this.store.policies.find(
        assignment.identity.policyVersion
      );
      if (
        !source ||
        source.state !== 'promoted' ||
        source.request.sourceGeneration !== assignment.identity.sourceGeneration ||
        source.request.connectorRef !== assignment.identity.connectorRef ||
        source.assignedDetectorSetVersion !==
          assignment.identity.detectorSetVersion ||
        source.assignedPolicyVersion !== assignment.identity.policyVersion ||
        !policy ||
        policy.detectorSetVersion !== assignment.identity.detectorSetVersion
      ) {
        return storeError('stale_evaluation');
      }

      const projection = await this.store.loadCurrentProjection(
        assignment.identity.connectorRef,
        assignment.identity.sourceGeneration
      );
      if (!projection) {
        this.emitTelemetry({
          name: 'evaluation_failed',
          detectorCount: 3,
          code: 'source_unavailable',
        });
        return this.lifecycle.completeEvaluation(assignment, {
          state: 'unavailable',
          completedAt,
        });
      }

      const classificationLineages = varianceLineages(
        projection,
        policy.policyVersion,
        policy.sourceClassification.classifierVersion,
        this.identityNamespace
      );
      const prior = await this.store.listLatestOccurrencePublicationsByInsightIds(
        assignment.identity.connectorRef,
        relevantInsightIds(
          assignment,
          projection,
          classificationLineages,
          this.identityNamespace
        )
      );
      const classifications = await this.store.classifyCurrentTransactions(
        assignment.identity.connectorRef,
        assignment.identity.policyVersion,
        assignment.identity.sourceGeneration
      );
      const classificationsBySource = new Map(
        classifications.map((item) => [item.sourceRef, item.classification])
      );
      const recurringPrior = recurringPriorOccurrences(
        prior,
        classificationsBySource
      );
      const largePrior = largePriorOccurrences(prior);
      const variancePrior = prior.filter(
        (item) =>
          item.detail.kind === 'categoryVariance' ||
          item.detail.kind === 'merchantVariance'
      );
      completedAt = this.clock();

      const recurring = await evaluateRecurringAmountDetectorV1({
        projectionLoader: {
          loadCurrentProjection: async (connectorRef) =>
            connectorRef === assignment.identity.connectorRef ? projection : null,
        },
        evidence: this.store.documentEvidence,
        source: {
          connectorRef: source.request.connectorRef,
          sourceGeneration: source.request.sourceGeneration,
          sourceAsOf: source.request.sourceAsOf,
          coverageStart: source.request.coverageStart,
          coverageEnd: source.request.coverageEnd,
          currency: source.request.currency,
          bridgeContractVersion: source.request.bridgeContractVersion,
          completeness: 'complete',
        },
        assignment,
        policy,
        identityNamespace: this.identityNamespace,
        completedAt,
        priorOccurrences: recurringPrior,
      });
      const large = evaluateLargeTransactionsV1({
        projection,
        source: source.request,
        assignment,
        policy,
        identityNamespace: this.identityNamespace,
        sourceCompleteness: 'complete',
        completedAt,
        previousOccurrences: largePrior,
      });
      const variance = evaluateVarianceProjectionV1({
        identityNamespace: this.identityNamespace,
        householdScope: assignment.identity.householdScope,
        projection,
        classifications: classifications as readonly ClassifiedVarianceTransactionV1[],
        classificationLineages,
        policy,
        source: {
          connectorRef: source.request.connectorRef,
          sourceGeneration: source.request.sourceGeneration,
          sourceAsOf: source.request.sourceAsOf,
          coverageStart: source.request.coverageStart,
          coverageEnd: source.request.coverageEnd,
          bridgeContractVersion: source.request.bridgeContractVersion,
          completeness: 'complete',
        },
        evaluationStartedAt: assignment.acceptedAt,
        evaluationCompletedAt: completedAt,
        previousOccurrences: variancePrior,
      });

      const publication = composePublications(
        [
          recurring.publication ?? emptyPublication(),
          large.publication,
          variance.publication,
        ],
        recurring.associations
      );
      const summaries = publication.occurrences.map((item) =>
        occurrenceSummary(item.detail)
      );
      const result = await this.lifecycle.completeEvaluation(
        assignment,
        {
          state: 'completed',
          summaries,
          completedAt,
        },
        publication
      );
      this.emitTelemetry({
        name: 'evaluation_completed',
        detectorCount: 3,
        occurrenceCount: publication.occurrences.length,
        transitionCount: publication.transitions.length,
        empty: publication.occurrences.length === 0,
      });
      return result;
    } catch {
      try {
        completedAt = this.clock();
      } catch {
        // The accepted timestamp remains a deterministic terminal fallback.
      }
      try {
        const failed = await this.lifecycle.completeEvaluation(assignment, {
          state: 'failed',
          completedAt,
        });
        this.emitTelemetry({
          name: 'evaluation_failed',
          detectorCount: 3,
          code: 'operation_failed',
        });
        return failed;
      } catch (completionError) {
        if (
          completionError instanceof Error &&
          completionError.name === 'FinanceInsightStoreError'
        ) {
          throw completionError;
        }
        return storeError('insight_operation_failed');
      }
    }
  }

  async runBounded(
    assignments: readonly AssignedEvaluationV1[]
  ): Promise<FinanceInsightOperatorRunResultV1> {
    if (
      assignments.length < 1 ||
      assignments.length > MAX_OPERATOR_EVALUATIONS_V1
    ) {
      return storeError('invalid_request');
    }
    let completed = 0;
    let unavailable = 0;
    let failed = 0;
    for (const assignment of assignments) {
      try {
        const result = await this.run(assignment);
        if (result.state === 'completed') completed += 1;
        else if (result.state === 'unavailable') unavailable += 1;
        else if (result.state === 'failed') failed += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      requested: assignments.length,
      completed,
      unavailable,
      failed,
    };
  }

  private emitTelemetry(event: FinanceInsightTelemetryEventV1): void {
    try {
      this.telemetry?.emit(event);
    } catch {
      // Telemetry is metadata-only and must never alter evaluation state.
    }
  }
}

function composePublications(
  publications: readonly EvaluationPublicationV1[],
  recurringAssociations: EvaluationPublicationV1['recurringAssociations']
): EvaluationPublicationV1 {
  const occurrences = publications.flatMap((item) => item.occurrences);
  const transitions = publications.flatMap((item) => item.transitions);
  if (occurrences.length > MAX_COMPOSED_OCCURRENCES_V1) {
    throw new RangeError('Finance insight occurrence publication exceeds its bound');
  }
  if (transitions.length > MAX_COMPOSED_TRANSITIONS_V1) {
    throw new RangeError('Finance insight transition publication exceeds its bound');
  }
  requireUnique(
    occurrences.map((item) => item.detail.occurrenceId),
    'Finance insight occurrence publication contains an identity collision'
  );
  requireUnique(
    transitions.map((item) => item.occurrenceId),
    'Finance insight transition publication contains an identity collision'
  );
  const exclusionSummary: Record<string, number> = {};
  publications.forEach((publication, detectorIndex) => {
    for (const [key, count] of Object.entries(
      publication.exclusionSummary ?? {}
    )) {
      exclusionSummary[`detector${detectorIndex + 1}.${key}`] = count;
    }
  });
  return {
    occurrences,
    transitions,
    ...(recurringAssociations && recurringAssociations.length > 0
      ? { recurringAssociations }
      : {}),
    ...(Object.keys(exclusionSummary).length > 0 ? { exclusionSummary } : {}),
  };
}

function emptyPublication(): EvaluationPublicationV1 {
  return { occurrences: [], transitions: [] };
}

function requireUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new RangeError(message);
}

function occurrenceSummary(
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
  return summary;
}

function recurringPriorOccurrences(
  prior: readonly OccurrencePublicationV1[],
  classifications: ReadonlyMap<string, string>
): PriorRecurringOccurrenceV1[] {
  return prior.flatMap((item) => {
    const detail = item.detail;
    const transactionSourceRef = detail.contributors[0]?.sourceRef;
    if (
      detail.kind !== 'recurringAmountChange' ||
      detail.entity.kind !== 'recurring' ||
      !transactionSourceRef ||
      !item.sourceRevisionRef ||
      !detail.observedValue
    ) {
      return [];
    }
    return [
      {
        recurringSourceRef: detail.entity.sourceRef,
        transactionSourceRef,
        billingPeriod: detail.observationPeriod.start.slice(0, 7),
        sourceRevisionRef: item.sourceRevisionRef,
        materialAmountMinor: detail.observedValue.amountMinor,
        classification:
          classifications.get(transactionSourceRef) ?? 'knownRecurring',
        detail,
      },
    ];
  });
}

function largePriorOccurrences(
  prior: readonly OccurrencePublicationV1[]
): PreviousLargeTransactionOccurrenceV1[] {
  return prior.flatMap((item) => {
    const detail = item.detail;
    if (
      detail.kind !== 'largeTransaction' ||
      detail.entity.kind !== 'transaction' ||
      !item.sourceRevisionRef ||
      !detail.observedValue
    ) {
      return [];
    }
    return [
      {
        transactionSourceRef: detail.entity.sourceRef,
        sourceRevisionRef: item.sourceRevisionRef,
        amountMinor: detail.observedValue.amountMinor,
        classification: 'postedSpend' as const,
        detail,
      },
    ];
  });
}

function varianceLineages(
  projection: Awaited<
    ReturnType<FinanceInsightSqliteStoreV1['loadCurrentProjection']>
  > & {},
  policyVersion: number,
  classifierVersion: string,
  identityNamespace: Uint8Array
): VarianceEntityClassificationLineageV1[] {
  const entities = new Map<
    string,
    Pick<VarianceEntityClassificationLineageV1, 'entityKind' | 'entitySourceRef'>
  >();
  for (const transaction of projection.transactions) {
    if (transaction.categoryRef) {
      entities.set(`category:${transaction.categoryRef}`, {
        entityKind: 'category',
        entitySourceRef: transaction.categoryRef,
      });
    }

    const merchantRef = deriveMerchantKeyV1(identityNamespace, transaction.merchantName);
    entities.set(`merchant:${merchantRef}`, {
      entityKind: 'merchant',
      entitySourceRef: merchantRef,
    });
  }
  return [...entities.values()]
    .sort((left, right) =>
      `${left.entityKind}:${left.entitySourceRef}`.localeCompare(
        `${right.entityKind}:${right.entitySourceRef}`
      )
    )
    .map((entity) => ({
      ...entity,
      lineage: canonicalDigestV1({
        namespace: 'variance-classification-lineage-v1',
        entityKind: entity.entityKind,
        entitySourceRef: entity.entitySourceRef,
        classifierVersion,
        policyVersion,
      } as CanonicalJsonValue),
    }));
}

function relevantInsightIds(
  assignment: AssignedEvaluationV1,
  projection: Awaited<
    ReturnType<FinanceInsightSqliteStoreV1['loadCurrentProjection']>
  > & {},
  classificationLineages: readonly VarianceEntityClassificationLineageV1[],
  identityNamespace: Uint8Array
): string[] {
  const householdScope = assignment.identity.householdScope;
  return [
    ...projection.recurring.map((fact) =>
      deriveInsightIdV1(identityNamespace, {
        householdScope,
        kind: 'recurringAmountChange',
        entityKind: 'recurring',
        entitySourceRef: fact.sourceRef,
      })
    ),
    ...projection.transactions.map((fact) =>
      deriveInsightIdV1(identityNamespace, {
        householdScope,
        kind: 'largeTransaction',
        entityKind: 'transaction',
        entitySourceRef: fact.sourceRef,
      })
    ),
    ...classificationLineages.map((lineage) =>
      deriveInsightIdV1(identityNamespace, {
        householdScope,
        kind:
          lineage.entityKind === 'category'
            ? 'categoryVariance'
            : 'merchantVariance',
        entityKind: lineage.entityKind,
        entitySourceRef: lineage.entitySourceRef,
      })
    ),
  ];
}

export function financeInsightEvaluationResultV1(
  record: EvaluationRecordV1
): ReturnType<typeof parseEvaluationResultV1> {
  return parseEvaluationResultV1({
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    identity: record.assignment.identity,
    sourceSequence: record.assignment.sourceSequence,
    evaluationSequence: record.assignment.evaluationSequence,
    acceptedAt: record.assignment.acceptedAt,
    state: record.state,
    completedAt:
      record.state === 'queued' || record.state === 'evaluating'
        ? null
        : record.completedAt,
  });
}
