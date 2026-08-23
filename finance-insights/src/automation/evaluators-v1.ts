import type { CanonicalJsonValue } from '../core/canonical.js';
import { canonicalDigestV1, normalizeIdentityTextV1 } from '../core/canonical.js';
import { classifyTransactionV1 } from '../projection/classification.js';
import type { TransactionSourceFactV1 } from '../contracts/source-v1.js';
import {
  CONNECTOR_HEALTH_DETECTOR_VERSION_V1,
  DUPLICATE_TRANSACTION_DETECTOR_VERSION_V1,
  FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1,
  type ConnectorHealthJobRequestV1,
  type DuplicateTransactionJobRequestV1,
  type FinanceAutomationAttentionV1,
  type FinanceAutomationEvidenceV1,
  type FinanceAutomationFreshnessV1,
  type FinanceAutomationJobRequestV1,
  type FinanceAutomationReasonCodeV1,
  type FinanceAutomationSignalKindV1,
  type FinanceAutomationProvenanceV1,
} from './contracts-v1.js';
import {
  deriveAutomationRunIdV1,
  deriveConnectorHealthSignalIdV1,
  deriveDuplicateSignalIdV1,
} from './identity-v1.js';
import {
  normalizeConnectorHealthJobRequestV1,
  normalizeDuplicateAutomationJobRequestV1,
} from './canonical-input-v1.js';

export interface FinanceAutomationSignalDraftV1 {
  readonly signalId: string;
  readonly kind: FinanceAutomationSignalKindV1;
  readonly connectorRef: string;
  readonly severity: 'medium' | 'high';
  readonly confidence: 'medium' | 'high';
  readonly attention: FinanceAutomationAttentionV1;
  readonly reasonCodes: readonly FinanceAutomationReasonCodeV1[];
  readonly relatedSourceRefs: readonly string[];
  readonly evidence: FinanceAutomationEvidenceV1;
  readonly freshness: FinanceAutomationFreshnessV1;
  readonly provenance: FinanceAutomationProvenanceV1;
  readonly fingerprint: string;
}

export interface FinanceAutomationEvaluationPlanV1 {
  readonly runId: string;
  readonly jobKind: FinanceAutomationJobRequestV1['jobKind'];
  readonly connectorRef: string;
  readonly scheduledFor: string;
  readonly observedAt: string;
  readonly sourceAsOf: string | null;
  readonly sourceGeneration: string | null;
  readonly sourceSequence: number | null;
  readonly bridgeContractVersion: string;
  readonly healthStaleAfterHours: number | null;
  readonly coverageStart: string | null;
  readonly coverageEnd: string | null;
  readonly inputFingerprint: string;
  readonly completedAt: string;
  readonly status: 'completed' | 'skipped';
  readonly skipReason:
    | 'disabled'
    | 'source_stale'
    | 'source_partial'
    | 'source_unavailable'
    | null;
  readonly candidateCount: number;
  readonly exclusionSummary: Readonly<Record<string, number>>;
  readonly settleAbsent: boolean;
  readonly desiredSignals: readonly FinanceAutomationSignalDraftV1[];
}

export function evaluateFinanceAutomationJobV1(
  request: FinanceAutomationJobRequestV1,
  identityNamespace: Uint8Array
): FinanceAutomationEvaluationPlanV1 {
  return request.jobKind === 'duplicateTransactions'
    ? evaluateDuplicateTransactionsV1(request, identityNamespace)
    : evaluateConnectorHealthV1(request, identityNamespace);
}

export function evaluateDuplicateTransactionsV1(
  request: DuplicateTransactionJobRequestV1,
  identityNamespace: Uint8Array
): FinanceAutomationEvaluationPlanV1 {
  const runId = deriveAutomationRunIdV1(
    identityNamespace,
    request.jobKind,
    request.connectorRef,
    request.scheduledFor
  );
  const base = {
    runId,
    jobKind: request.jobKind,
    connectorRef: request.connectorRef,
    scheduledFor: request.scheduledFor,
    observedAt: request.source.sourceAsOf,
    sourceAsOf: request.source.sourceAsOf,
    sourceGeneration: request.source.sourceGeneration,
    sourceSequence: request.source.sourceSequence,
    bridgeContractVersion: request.source.bridgeContractVersion,
    healthStaleAfterHours: null,
    coverageStart: request.source.coverageStart,
    coverageEnd: request.source.coverageEnd,
    inputFingerprint: duplicateInputFingerprint(
      normalizeDuplicateAutomationJobRequestV1(request)
    ),
    completedAt: request.evaluatedAt,
  } as const;
  if (!request.automationPolicy.duplicateTransactions.enabled) {
    return skippedPlan(base, 'disabled');
  }
  if (request.sourceCompleteness !== 'complete') {
    return skippedPlan(
      base,
      request.sourceCompleteness === 'partial'
        ? 'source_partial'
        : 'source_unavailable'
    );
  }
  const ageHours = elapsedHours(
    request.source.sourceAsOf,
    request.evaluatedAt
  );
  if (
    ageHours < 0 ||
    ageHours > request.automationPolicy.duplicateTransactions.freshnessMaxAgeHours
  ) {
    return skippedPlan(base, 'source_stale');
  }

  const suppression = new Map(
    request.suppressedPairs.map((pair) => [
      [...pair.sourceRefs].sort().join('\0'),
      pair.reason,
    ])
  );
  const exclusions = new Map<string, number>();
  const groups = new Map<string, TransactionSourceFactV1[]>();
  for (const fact of request.transactions) {
    const classification = classifyTransactionV1(fact, request.insightPolicy);
    if (classification.classification !== 'postedSpend') {
      increment(exclusions, classification.reasonCode ?? 'non_spend_excluded');
      continue;
    }
    if (fact.accountRef === null) {
      increment(exclusions, 'missing_account_excluded');
      continue;
    }
    const key = JSON.stringify([
      fact.accountRef,
      fact.amountMinor,
      normalizeIdentityTextV1(fact.merchantName),
    ]);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const drafts: FinanceAutomationSignalDraftV1[] = [];
  let overflow = false;
  for (const groupKey of [...groups.keys()].sort()) {
    const facts = groups
      .get(groupKey)!
      .sort(
        (left, right) =>
          left.occurredOn.localeCompare(right.occurredOn) ||
          left.sourceRef.localeCompare(right.sourceRef)
      );
    for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
      const left = facts[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < facts.length; rightIndex += 1) {
        const right = facts[rightIndex]!;
        const dateGapDays = calendarDayGap(left.occurredOn, right.occurredOn);
        if (
          dateGapDays >
          request.automationPolicy.duplicateTransactions.matchWindowDays
        ) {
          break;
        }
        const sourceRefs = [left.sourceRef, right.sourceRef].sort() as [
          string,
          string,
        ];
        const suppressionReason = suppression.get(sourceRefs.join('\0'));
        if (suppressionReason !== undefined) {
          increment(
            exclusions,
            suppressionReason === 'connectorRetry'
              ? 'connector_retry_excluded'
              : 'expected_duplicate_excluded'
          );
          continue;
        }
        if (
          drafts.length >=
          request.automationPolicy.duplicateTransactions.maxCandidates
        ) {
          overflow = true;
          break;
        }
        const reasonCode =
          dateGapDays === 0
            ? 'duplicate_exact_match'
            : 'duplicate_adjacent_date_match';
        const confidence = dateGapDays === 0 ? 'high' : 'medium';
        const evidence = {
          kind: 'duplicateTransaction',
          sameAmount: true,
          sameMerchant: true,
          sameAccount: true,
          dateGapDays,
          observedDates: [left.occurredOn, right.occurredOn].sort() as [
            string,
            string,
          ],
        } as const;
        const signalId = deriveDuplicateSignalIdV1(
          identityNamespace,
          request.connectorRef,
          sourceRefs
        );
        drafts.push({
          signalId,
          kind: 'duplicateTransaction',
          connectorRef: request.connectorRef,
          severity: confidence,
          confidence,
          attention: confidence === 'high' ? 'actionable' : 'informational',
          reasonCodes: [reasonCode],
          relatedSourceRefs: sourceRefs,
          evidence,
          freshness: 'fresh',
          provenance: {
            connectorRef: request.connectorRef,
            providerClass: 'monarchBridgeNormalized',
            bridgeContractVersion: request.source.bridgeContractVersion,
            sourceGeneration: request.source.sourceGeneration,
            sourceAsOf: request.source.sourceAsOf,
            observedAt: request.source.sourceAsOf,
            evaluatedAt: request.evaluatedAt,
            detectorSetVersion: FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1,
            detectorVersion: DUPLICATE_TRANSACTION_DETECTOR_VERSION_V1,
            policyVersion: request.automationPolicy.policyVersion,
          },
          fingerprint: signalFingerprint({
            reasonCode,
            sourceRefs,
            evidence,
            attention: confidence === 'high' ? 'actionable' : 'informational',
          }),
        });
      }
      if (overflow) break;
    }
    if (overflow) break;
  }
  if (overflow) increment(exclusions, 'candidate_limit_reached');

  return {
    ...base,
    status: 'completed',
    skipReason: null,
    candidateCount: drafts.length,
    exclusionSummary: orderedCounts(exclusions),
    settleAbsent: !overflow,
    desiredSignals: drafts,
  };
}

export function evaluateConnectorHealthV1(
  request: ConnectorHealthJobRequestV1,
  identityNamespace: Uint8Array
): FinanceAutomationEvaluationPlanV1 {
  const runId = deriveAutomationRunIdV1(
    identityNamespace,
    request.jobKind,
    request.connectorRef,
    request.scheduledFor
  );
  const sourceAsOf = request.observation.lastSuccessfulSyncAt;
  const base = {
    runId,
    jobKind: request.jobKind,
    connectorRef: request.connectorRef,
    scheduledFor: request.scheduledFor,
    observedAt: request.observation.observedAt,
    sourceAsOf,
    sourceGeneration: null,
    sourceSequence: null,
    bridgeContractVersion: request.observation.bridgeContractVersion,
    healthStaleAfterHours:
      request.automationPolicy.connectorHealth.staleAfterHours,
    coverageStart: null,
    coverageEnd: null,
    inputFingerprint: canonicalDigestV1(
      normalizeConnectorHealthJobRequestV1(request)
        .observation as CanonicalJsonValue
    ),
    completedAt: request.evaluatedAt,
  } as const;
  if (!request.automationPolicy.connectorHealth.enabled) {
    return skippedPlan(base, 'disabled');
  }

  const exactSourceAgeHours =
    sourceAsOf === null ? null : elapsedHours(sourceAsOf, request.evaluatedAt);
  const sourceAgeHours =
    exactSourceAgeHours === null ? null : Math.floor(exactSourceAgeHours);
  const stale =
    exactSourceAgeHours === null ||
    exactSourceAgeHours < 0 ||
    exactSourceAgeHours >
      request.automationPolicy.connectorHealth.staleAfterHours;
  const unhealthy = request.observation.state !== 'connected' || stale;
  if (!unhealthy) {
    return {
      ...base,
      status: 'completed',
      skipReason: null,
      candidateCount: 0,
      exclusionSummary: {},
      settleAbsent: true,
      desiredSignals: [],
    };
  }

  const actionable =
    request.observation.state === 'unavailable' ||
    request.observation.consecutiveFailures >=
      request.automationPolicy.connectorHealth
        .actionableAfterConsecutiveFailures;
  const reasonCodes: FinanceAutomationReasonCodeV1[] = [];
  if (request.observation.state === 'degraded') {
    reasonCodes.push('connector_reported_degraded');
  }
  if (request.observation.state === 'unavailable') {
    reasonCodes.push('connector_reported_unavailable');
  }
  if (stale) reasonCodes.push('connector_sync_stale');
  if (
    request.observation.consecutiveFailures >=
    request.automationPolicy.connectorHealth.actionableAfterConsecutiveFailures
  ) {
    reasonCodes.push('connector_repeated_failures');
  }
  const freshness: FinanceAutomationFreshnessV1 =
    sourceAsOf === null ? 'unavailable' : stale ? 'stale' : 'fresh';
  const evidence = {
    kind: 'connectorHealth',
    reportedState: request.observation.state,
    consecutiveFailures: request.observation.consecutiveFailures,
    sourceAgeHours,
  } as const;
  const signalId = deriveConnectorHealthSignalIdV1(
    identityNamespace,
    request.connectorRef
  );
  const draft: FinanceAutomationSignalDraftV1 = {
    signalId,
    kind: 'connectorHealth',
    connectorRef: request.connectorRef,
    severity: actionable ? 'high' : 'medium',
    confidence: 'high',
    attention: actionable ? 'actionable' : 'informational',
    reasonCodes,
    relatedSourceRefs: [],
    evidence,
    freshness,
    provenance: {
      connectorRef: request.connectorRef,
      providerClass: 'monarchBridgeNormalized',
      bridgeContractVersion: request.observation.bridgeContractVersion,
      sourceGeneration: null,
      sourceAsOf,
      observedAt: request.observation.observedAt,
      evaluatedAt: request.evaluatedAt,
      detectorSetVersion: FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1,
      detectorVersion: CONNECTOR_HEALTH_DETECTOR_VERSION_V1,
      policyVersion: request.automationPolicy.policyVersion,
    },
    fingerprint: signalFingerprint({
      reasonCodes,
      attention: actionable ? 'actionable' : 'informational',
      evidence,
    }),
  };

  return {
    ...base,
    status: 'completed',
    skipReason: null,
    candidateCount: 1,
    exclusionSummary: {},
    settleAbsent: true,
    desiredSignals: [draft],
  };
}

function skippedPlan(
  base: Pick<
    FinanceAutomationEvaluationPlanV1,
    | 'runId'
    | 'jobKind'
    | 'connectorRef'
    | 'scheduledFor'
    | 'observedAt'
    | 'sourceAsOf'
    | 'sourceGeneration'
    | 'sourceSequence'
    | 'bridgeContractVersion'
    | 'healthStaleAfterHours'
    | 'coverageStart'
    | 'coverageEnd'
    | 'inputFingerprint'
    | 'completedAt'
  >,
  skipReason: Exclude<
    FinanceAutomationEvaluationPlanV1['skipReason'],
    null
  >
): FinanceAutomationEvaluationPlanV1 {
  return {
    ...base,
    status: 'skipped',
    skipReason,
    candidateCount: 0,
    exclusionSummary: {},
    settleAbsent: false,
    desiredSignals: [],
  };
}

export function rebaseConnectorHealthPlanV1(
  plan: FinanceAutomationEvaluationPlanV1,
  sourceAsOf: string | null
): FinanceAutomationEvaluationPlanV1 {
  if (
    plan.jobKind !== 'connectorHealth' ||
    plan.status !== 'completed' ||
    plan.sourceAsOf === sourceAsOf
  ) {
    return plan;
  }
  const draft = plan.desiredSignals[0];
  if (!draft || draft.evidence.kind !== 'connectorHealth') {
    return { ...plan, sourceAsOf };
  }
  const exactSourceAgeHours =
    sourceAsOf === null ? null : elapsedHours(sourceAsOf, plan.completedAt);
  const sourceAgeHours =
    exactSourceAgeHours === null ? null : Math.floor(exactSourceAgeHours);
  const stale =
    exactSourceAgeHours === null ||
    exactSourceAgeHours < 0 ||
    plan.healthStaleAfterHours === null ||
    exactSourceAgeHours > plan.healthStaleAfterHours;
  if (draft.evidence.reportedState === 'connected' && !stale) {
    return {
      ...plan,
      sourceAsOf,
      candidateCount: 0,
      desiredSignals: [],
    };
  }
  const reasonCodes: FinanceAutomationReasonCodeV1[] = [];
  for (const reason of draft.reasonCodes) {
    if (reason !== 'connector_sync_stale') reasonCodes.push(reason);
  }
  if (stale) reasonCodes.push('connector_sync_stale');
  const evidence = { ...draft.evidence, sourceAgeHours };
  const rebasedDraft: FinanceAutomationSignalDraftV1 = {
    ...draft,
    reasonCodes,
    evidence,
    freshness: sourceAsOf === null ? 'unavailable' : stale ? 'stale' : 'fresh',
    provenance: { ...draft.provenance, sourceAsOf },
    fingerprint: signalFingerprint({
      reasonCodes,
      attention: draft.attention,
      evidence,
    }),
  };
  return {
    ...plan,
    sourceAsOf,
    desiredSignals: [rebasedDraft],
  };
}

function elapsedHours(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / (60 * 60 * 1_000);
}

function calendarDayGap(left: string, right: string): number {
  return Math.abs(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) /
      (24 * 60 * 60 * 1_000)
  );
}

function signalFingerprint(value: CanonicalJsonValue): string {
  return canonicalDigestV1(value);
}

function duplicateInputFingerprint(
  request: DuplicateTransactionJobRequestV1
): string {
  const source = {
    ...request.source,
    capturedConstituents: [...request.source.capturedConstituents].sort((left, right) =>
      left.kind.localeCompare(right.kind)
    ),
    manifest: [...request.source.manifest].sort((left, right) =>
      left.kind.localeCompare(right.kind)
    ),
  };
  const transactions = [...request.transactions].sort((left, right) =>
    left.sourceRef.localeCompare(right.sourceRef)
  );
  return canonicalDigestV1({
    source: source as CanonicalJsonValue,
    transactions: transactions as CanonicalJsonValue,
  });
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function orderedCounts(counts: Map<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}
