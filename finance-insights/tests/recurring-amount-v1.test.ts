import { describe, expect, it } from 'vitest';
import {
  createCandidatePolicySnapshotV1,
  evaluateRecurringAmountDetectorV1,
  parseFinanceInsightPolicySnapshotV1,
  parseInsightOccurrenceDetailV1,
  type ConfiguredRecurringAssociationV1,
  type EvidenceRecordV1,
  type FinanceInsightPolicySnapshotV1,
  type PriorRecurringOccurrenceV1,
  type RecurringAmountDetectorResultV1,
  type RecurringAmountSourceContextV1,
  type RecurringEvidenceBindingV1,
  type SourceProjectionV1,
  type TransactionSourceFactV1,
} from '../src/index.js';

const IDENTITY_KEY = Buffer.alloc(32, 17);
const ACCEPTED_AT = '2026-08-10T15:04:00Z';
const COMPLETED_AT = '2026-08-10T15:05:00Z';

describe('recurring amount detector v1', () => {
  it('keeps an expected summer bill as a sufficient non-alert analysis', async () => {
    const result = await evaluate(projectionWithCurrent(20_500));

    expect(result.analyses[0]).toMatchObject({
      state: 'withinExpectedRange',
      observedAmountMinor: 20_500,
      seasonalYearCount: 2,
      absoluteGatePassed: false,
      occurrenceId: expect.stringMatching(/^occurrence-v1_/),
    });
    expect(result.publication?.occurrences).toHaveLength(0);
  });

  it('opens a material seasonal spike only when both policy gates pass', async () => {
    const result = await evaluate(projectionWithCurrent(28_640));
    const analysis = result.analyses[0]!;
    const detail = result.publication?.occurrences[0]?.detail;

    expect(analysis).toMatchObject({
      state: 'qualifiedIncrease',
      absoluteGatePassed: true,
      relativeGatePassed: true,
      robustCenterMinor: 20_000,
      expectedLowerMinor: 19_000,
      expectedUpperMinor: 21_000,
    });
    expect(detail).toMatchObject({
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      severity: 'high',
      baselineSufficiency: 'sufficient',
      reasonCodes: [
        'recurring_absolute_gate_exceeded',
        'recurring_relative_gate_exceeded',
        'zero_mad_minimum_spread',
        'optional_evidence_unavailable',
      ],
      baseline: {
        method: 'seasonalMedianMad',
        sampleCount: 6,
        activePeriodCount: 2,
      },
    });
    expect(result.terminalResult).toMatchObject({
      state: 'completed',
      summaries: [{ occurrenceId: analysis.occurrenceId }],
    });
  });

  it('records a material seasonal decrease without opening an alert', async () => {
    const result = await evaluate(projectionWithCurrent(12_000));

    expect(result.analyses[0]).toMatchObject({
      state: 'decreaseAnalysisOnly',
      absoluteGatePassed: true,
      relativeGatePassed: true,
      reasonCodes: expect.arrayContaining(['recurring_decrease_analysis_only']),
    });
    expect(result.publication?.occurrences).toHaveLength(0);
  });

  it('does not substitute rolling history for two prior seasonal years', async () => {
    const transactions = [
      transaction('current', '2026-12-15', -28_640),
      ...Array.from({ length: 12 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 10 - index, 15))
          .toISOString()
          .slice(0, 10);
        return transaction(`rolling-${index}`, date, -20_000);
      }),
    ];
    const result = await evaluate(projection(transactions));

    expect(result.analyses[0]).toMatchObject({
      state: 'insufficientBaseline',
      seasonalYearCount: 1,
      reasonCodes: expect.arrayContaining(['seasonal_baseline_insufficient']),
    });
    expect(result.publication?.occurrences[0]?.detail).toMatchObject({
      analysisState: 'insufficientBaseline',
      baselineSufficiency: 'limited',
      comparisons: expect.any(Array),
    });
  });

  it('uses valid billing-period evidence without replacing the original amount', async () => {
    const result = await evaluate(projectionWithCurrent(23_333), {
      evidence: [billingPeriodEvidence(35)],
    });
    const detail = result.publication?.occurrences[0]?.detail;

    expect(result.analyses[0]).toMatchObject({
      state: 'withinExpectedRange',
      observedAmountMinor: 23_333,
      analysisAmountMinor: 20_000,
      reasonCodes: expect.arrayContaining(['period_normalized']),
    });
    expect(detail).toBeUndefined();
  });

  it('applies the absolute gate to the exact 30-day equivalent amount', async () => {
    const result = await evaluate(projectionWithCurrent(30_335), {
      evidence: [billingPeriodEvidence(35)],
    });

    expect(result.analyses[0]).toMatchObject({
      analysisAmountMinor: 26_001,
      absoluteGatePassed: false,
      relativeGatePassed: true,
      state: 'withinExpectedRange',
    });
    expect(result.publication?.occurrences).toHaveLength(0);
  });

  it('does not apply billing-period evidence from an older bill', async () => {
    const oldEvidence = {
      ...billingPeriodEvidence(35),
      observedAt: '2025-07-15T14:00:00Z',
    };
    const result = await evaluate(projectionWithCurrent(30_335), {
      evidence: [oldEvidence],
    });

    expect(result.analyses[0]).toMatchObject({
      analysisAmountMinor: 30_335,
      state: 'qualifiedIncrease',
      reasonCodes: expect.arrayContaining(['optional_evidence_unavailable']),
    });
    expect(result.analyses[0]?.reasonCodes).not.toContain('period_normalized');
  });

  it('retains normalized usage context without exposing document text', async () => {
    const result = await evaluate(projectionWithCurrent(28_640), {
      evidence: [
        billingPeriodEvidence(30),
        evidence('usage', 150, 'usageUnit', 'demo-document-usage-v1'),
        evidence('billAmount', 28_640, 'currencyMinor', 'demo-document-usage-v1'),
      ],
    });
    const detail = result.publication?.occurrences[0]?.detail;

    expect(detail?.confidence).toBe('high');
    expect(detail?.evidence.map((item) => item.evidenceType)).toEqual([
      'billAmount',
      'billingPeriod',
      'usage',
    ]);
    expect(detail?.explanation).toContain('Normalized usage evidence');
    expect(result.analyses[0]?.usageContext).toEqual({
      usageUnits: 150,
      billAmountMinor: 28_640,
      unitCostMilliMinorPerUsage: 190_933,
      usageChangeBasisPoints: null,
      unitCostChangeBasisPoints: null,
    });
    expect(detail?.ruleResults.map((item) => item.ruleCode)).toEqual(
      expect.arrayContaining([
        'recurring_usage_context',
        'recurring_unit_cost_context',
      ])
    );
    expect(JSON.stringify(detail)).not.toContain('raw');
  });

  it('decomposes normalized usage and unit-cost movement with exact ratios', async () => {
    const records: EvidenceRecordV1[] = [
      {
        ...evidence('usage', 100, 'usageUnit', 'demo-document-prior-v1'),
        observedAt: '2026-07-10T14:00:00Z',
      },
      {
        ...evidence(
          'billAmount',
          20_000,
          'currencyMinor',
          'demo-document-prior-v1'
        ),
        observedAt: '2026-07-10T14:00:00Z',
      },
      {
        ...evidence('usage', 125, 'usageUnit', 'demo-document-current-v1'),
        observedAt: '2026-08-10T14:00:00Z',
      },
      {
        ...evidence(
          'billAmount',
          30_000,
          'currencyMinor',
          'demo-document-current-v1'
        ),
        observedAt: '2026-08-10T14:00:00Z',
      },
      billingPeriodEvidence(30),
    ];
    const result = await evaluate(projectionWithCurrent(30_000), {
      evidence: records,
      evidenceBindings: [
        {
          transactionSourceRef: 'demo-transaction-current',
          documentRef: 'demo-document-prior-v1',
        },
        {
          transactionSourceRef: 'demo-transaction-current',
          documentRef: 'demo-document-current-v1',
        },
        {
          transactionSourceRef: 'demo-transaction-current',
          documentRef: 'demo-document-bill-v1',
        },
      ],
    });

    expect(result.analyses[0]?.usageContext).toEqual({
      usageUnits: 125,
      billAmountMinor: 30_000,
      unitCostMilliMinorPerUsage: 240_000,
      usageChangeBasisPoints: 2_500,
      unitCostChangeBasisPoints: 2_000,
    });
  });

  it('ignores conflicting period evidence and reports optional evidence unavailable', async () => {
    const result = await evaluate(projectionWithCurrent(28_640), {
      evidence: [billingPeriodEvidence(29), billingPeriodEvidence(31)],
    });

    expect(result.analyses[0]).toMatchObject({
      analysisAmountMinor: 28_640,
      reasonCodes: expect.arrayContaining(['optional_evidence_unavailable']),
    });
    expect(result.analyses[0]?.reasonCodes).not.toContain('period_normalized');
  });

  it('keeps the core result stable when OWL evidence is absent', async () => {
    const withEvidence = await evaluate(projectionWithCurrent(28_640), {
      evidence: [billingPeriodEvidence(30)],
    });
    const withoutEvidence = await evaluate(projectionWithCurrent(28_640));

    expect(withoutEvidence.analyses[0]).toMatchObject({
      state: withEvidence.analyses[0]!.state,
      expectedLowerMinor: withEvidence.analyses[0]!.expectedLowerMinor,
      expectedUpperMinor: withEvidence.analyses[0]!.expectedUpperMinor,
    });
    expect(withoutEvidence.publication?.occurrences[0]?.detail.confidence).toBe(
      'medium'
    );
    expect(withEvidence.publication?.occurrences[0]?.detail.confidence).toBe('high');
  });

  it('blocks an ambiguous obligation join and records the reason', async () => {
    const recurring = [
      recurringFact('electric-a', { displayName: 'Demo Electric' }),
      recurringFact('electric-b', { displayName: 'Demo Electric' }),
    ];
    const current = transaction('ambiguous', '2026-07-15', -28_640, {
      recurringRef: null,
      merchantName: 'Demo Electric',
    });
    const result = await evaluate(
      projection([current], recurring)
    );

    expect(result.analyses).toHaveLength(2);
    expect(result.analyses.every((item) => item.state === 'unavailable')).toBe(true);
    expect(
      result.analyses.every((item) =>
        item.reasonCodes.includes('classification_ambiguous')
      )
    ).toBe(true);
    expect(result.publication?.occurrences).toHaveLength(2);
    expect(result.publication?.occurrences.every(
      (item) => item.detail.analysisState === 'unavailable'
    )).toBe(true);
  });

  it('does not supersede a prior occurrence from an ambiguous reassignment', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const recurring = [
      recurringFact('electric'),
      recurringFact('electric-alt', { displayName: 'Demo Electric' }),
    ];
    const current = transaction('current', '2026-07-15', -30_000, {
      recurringRef: null,
      merchantName: 'Demo Electric',
    });
    const result = await evaluate(projection([current], recurring), {
      prior: [prior],
    });

    expect(
      result.analyses.every((item) =>
        item.reasonCodes.includes('classification_ambiguous')
      )
    ).toBe(true);
    expect(result.publication?.occurrences).toHaveLength(0);
    expect(result.publication?.transitions).toHaveLength(0);
  });

  it('resolves a corrected same-period occurrence that no longer qualifies', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const corrected = projectionWithCurrent(20_500, 'current');
    const result = await evaluate(corrected, { prior: [prior] });

    expect(result.analyses[0]?.state).toBe('withinExpectedRange');
    expect(result.publication?.occurrences).toHaveLength(0);
    expect(result.publication?.transitions).toEqual([
      {
        occurrenceId: prior.detail.occurrenceId,
        state: 'resolved',
        reasonCode: 'correction_resolved',
        replacementOccurrenceId: null,
        occurredAt: COMPLETED_AT,
      },
    ]);
  });

  it('resolves an open occurrence when new evidence alone removes qualification', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const reevaluated = await evaluate(projectionWithCurrent(28_640), {
      prior: [prior],
      evidence: [billingPeriodEvidence(35)],
    });

    expect(reevaluated.analyses[0]?.state).toBe('withinExpectedRange');
    expect(reevaluated.publication?.occurrences).toHaveLength(0);
    expect(reevaluated.publication?.transitions).toEqual([
      {
        occurrenceId: prior.detail.occurrenceId,
        state: 'resolved',
        reasonCode: 'correction_resolved',
        replacementOccurrenceId: null,
        occurredAt: COMPLETED_AT,
      },
    ]);
  });

  it('resolves open alerts for recurring entities absent from a complete projection', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const removed = await evaluate(projection([], []), { prior: [prior] });

    expect(removed.analyses).toHaveLength(0);
    expect(removed.publication?.occurrences).toHaveLength(0);
    expect(removed.publication?.transitions).toEqual([
      {
        occurrenceId: prior.detail.occurrenceId,
        state: 'resolved',
        reasonCode: 'correction_resolved',
        replacementOccurrenceId: null,
        occurredAt: COMPLETED_AT,
      },
    ]);
  });

  it('supersedes a corrected same-period occurrence when the successor qualifies', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const result = await evaluate(projectionWithCurrent(30_000, 'current'), {
      prior: [prior],
    });
    const replacement = result.publication?.occurrences[0];

    expect(replacement?.detail.occurrenceId).not.toBe(prior.detail.occurrenceId);
    expect(replacement?.sourceRevisionRef).not.toBe(prior.sourceRevisionRef);
    expect(result.publication?.transitions[0]).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      state: 'superseded',
      reasonCode: 'correction_superseded',
      replacementOccurrenceId: replacement?.detail.occurrenceId,
    });
  });

  it('selects the terminal correction successor on a later rerun', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const predecessor = priorFrom(first, 28_640);
    const secondProjection = projectionWithCurrent(30_000, 'current');
    const corrected = await evaluate(secondProjection, {
      prior: [predecessor],
    });
    const successor = priorFrom(corrected, 30_000);
    const transitionedPredecessor = supersedePrior(predecessor, successor);
    const thirdProjection = projectionWithCurrent(32_000, 'current');
    const correctedAgain = await evaluate(thirdProjection, {
      prior: [transitionedPredecessor, successor],
    });
    const terminalSuccessor = priorFrom(correctedAgain, 32_000);
    const transitionedSuccessor = supersedePrior(
      successor,
      terminalSuccessor
    );
    const rerun = await evaluate(thirdProjection, {
      prior: [
        transitionedSuccessor,
        transitionedPredecessor,
        terminalSuccessor,
      ],
    });

    expect(rerun.publication?.occurrences[0]?.detail).toMatchObject({
      occurrenceId: terminalSuccessor.detail.occurrenceId,
      createdAt: terminalSuccessor.detail.createdAt,
      deliveryRevision: terminalSuccessor.detail.deliveryRevision,
    });
    expect(rerun.publication?.transitions).toHaveLength(0);
  });

  it('does not fork corrections from dangling or cyclic supersession records', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const predecessor = priorFrom(first, 28_640);
    const corrected = await evaluate(projectionWithCurrent(30_000, 'current'), {
      prior: [predecessor],
    });
    const successor = priorFrom(corrected, 30_000);
    const transitionedPredecessor = supersedePrior(predecessor, successor);
    const currentProjection = projectionWithCurrent(32_000, 'current');
    const withoutPrior = await evaluate(currentProjection);
    const dangling = await evaluate(currentProjection, {
      prior: [transitionedPredecessor],
    });
    const transitionedSuccessor = supersedePrior(successor, predecessor);
    const cycleForward = await evaluate(currentProjection, {
      prior: [transitionedPredecessor, transitionedSuccessor],
    });
    const cycleReverse = await evaluate(currentProjection, {
      prior: [transitionedSuccessor, transitionedPredecessor],
    });

    expect(dangling.publication).toEqual(withoutPrior.publication);
    expect(cycleForward.publication).toEqual(withoutPrior.publication);
    expect(cycleReverse.publication).toEqual(withoutPrior.publication);
  });

  it('links a qualifying billing-period correction to its predecessor', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const corrected = projection(
      seasonalHistory().map((item) =>
        item.sourceRef === 'demo-transaction-current'
          ? { ...item, occurredOn: '2026-08-15' }
          : item
      )
    );
    const result = await evaluate(corrected, { prior: [prior] });
    const replacement = result.publication?.occurrences[0];

    expect(replacement?.detail.observationPeriod.start).toBe('2026-08-01');
    expect(result.publication?.transitions[0]).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      state: 'superseded',
      replacementOccurrenceId: replacement?.detail.occurrenceId,
    });
  });

  it('resolves an open occurrence when its source correction becomes a credit', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const corrected = projection(
      seasonalHistory().map((item) =>
        item.sourceRef === 'demo-transaction-current'
          ? { ...item, amountMinor: 28_640 }
          : item
      )
    );
    const result = await evaluate(corrected, { prior: [prior] });

    expect(result.analyses[0]).toMatchObject({
      billingPeriod: '2026-07',
      state: 'unavailable',
      reasonCodes: ['unclassified_credit_excluded'],
    });
    expect(result.publication?.occurrences).toHaveLength(0);
    expect(result.publication?.transitions[0]).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      state: 'resolved',
      reasonCode: 'correction_resolved',
    });
  });

  it('preserves an open occurrence when a partial correction becomes a credit', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const corrected = projection(
      seasonalHistory().map((item) =>
        item.sourceRef === 'demo-transaction-current'
          ? { ...item, amountMinor: 28_640 }
          : item
      )
    );
    const result = await evaluate(corrected, {
      prior: [prior],
      source: { completeness: 'partial' },
    });

    expect(result.analyses[0]).toMatchObject({
      state: 'unavailable',
      occurrenceId: prior.detail.occurrenceId,
      reasonCodes: expect.arrayContaining(['source_partial']),
    });
    expect(result.publication?.occurrences[0]?.detail).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      deliveryRevision: prior.detail.deliveryRevision,
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      freshness: { state: 'partial' },
    });
    expect(result.publication?.transitions).toHaveLength(0);
  });

  it('supersedes a reassigned correction into the new obligation series', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const recurring = [
      recurringFact('electric'),
      recurringFact('electric-reassigned', { displayName: 'Demo Electric Reassigned' }),
    ];
    const transactions = seasonalHistory().map((item) =>
      item.sourceRef === 'demo-transaction-current'
        ? { ...item, recurringRef: 'demo-recurring-electric-reassigned' }
        : item
    );
    const result = await evaluate(projection(transactions, recurring), {
      prior: [prior],
    });

    const replacement = result.publication?.occurrences.find(
      (item) => item.detail.entity.sourceRef === 'demo-recurring-electric-reassigned'
    );
    expect(replacement?.detail.insightId).not.toBe(prior.detail.insightId);
    expect(result.publication?.transitions[0]).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      state: 'superseded',
      replacementOccurrenceId: replacement?.detail.occurrenceId,
    });
  });

  it('resolves a reassigned correction when no successor is published', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const recurring = [
      recurringFact('electric'),
      recurringFact('electric-reassigned', {
        displayName: 'Demo Electric Reassigned',
      }),
    ];
    const transactions = seasonalHistory()
      .map((item) => ({
        ...item,
        recurringRef: 'demo-recurring-electric-reassigned',
      }))
      .map((item) =>
        item.sourceRef === 'demo-transaction-current'
          ? { ...item, amountMinor: -20_000 }
          : item
      );
    const result = await evaluate(projection(transactions, recurring), {
      prior: [prior],
    });

    expect(result.publication?.occurrences).toHaveLength(0);
    expect(result.publication?.transitions[0]).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      state: 'resolved',
      reasonCode: 'correction_resolved',
      replacementOccurrenceId: null,
    });
  });

  it('increments one delivery revision for a material evidence change', async () => {
    const first = await evaluate(projectionWithCurrent(30_000), {
      evidence: [billingPeriodEvidence(30)],
    });
    const prior = priorFrom(first, 30_000);
    const changed = await evaluate(projectionWithCurrent(30_000), {
      evidence: [billingPeriodEvidence(32)],
      prior: [prior],
    });
    const detail = changed.publication?.occurrences[0]?.detail;

    expect(detail?.occurrenceId).toBe(prior.detail.occurrenceId);
    expect(detail?.deliveryRevision).toBe(2);
    expect(detail?.reasonCodes).toContain('material_source_change');
  });

  it('is idempotent for the same promoted generation and assigned policy', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const second = await evaluate(projectionWithCurrent(28_640));

    expect(second).toEqual(first);
  });

  it('does not open a new alert from stale or partial input', async () => {
    for (const source of [
      {
        sourceAsOf: '2026-08-07T15:04:59Z',
        completeness: 'complete' as const,
      },
      {
        sourceAsOf: '2026-08-10T15:04:00Z',
        completeness: 'partial' as const,
      },
    ]) {
      const result = await evaluate(projectionWithCurrent(28_640), { source });
      expect(result.analyses[0]?.state).toBe('unavailable');
      expect(result.publication?.occurrences[0]?.detail).toMatchObject({
        analysisState: 'unavailable',
        sourceLifecycle: null,
      });
    }
  });

  it('preserves an open reliable occurrence when reevaluation is stale', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const result = await evaluate(projectionWithCurrent(28_640), {
      prior: [prior],
      source: { sourceAsOf: '2026-08-07T15:04:59Z' },
    });

    expect(result.analyses[0]).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['source_stale']),
    });
    expect(result.publication?.occurrences[0]?.detail).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      deliveryRevision: prior.detail.deliveryRevision,
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      freshness: { state: 'stale' },
      reasonCodes: expect.arrayContaining(['source_stale']),
    });
    expect(result.publication?.transitions).toHaveLength(0);
  });

  it('preserves an open reliable occurrence when a correction is partial', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const result = await evaluate(
      projectionWithCurrent(30_000, 'current'),
      {
        prior: [prior],
        source: { completeness: 'partial' },
      }
    );

    expect(result.analyses[0]).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining(['source_partial']),
    });
    expect(result.publication?.occurrences[0]?.detail).toMatchObject({
      occurrenceId: prior.detail.occurrenceId,
      deliveryRevision: prior.detail.deliveryRevision,
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      freshness: { state: 'partial' },
    });
    expect(result.publication?.transitions).toHaveLength(0);
  });

  it('gives source unavailability precedence over sparse baseline state', async () => {
    const result = await evaluate(
      projection([
        transaction('current', '2026-07-15', -28_640),
        transaction('prior', '2025-07-15', -20_000),
      ]),
      { source: { completeness: 'partial' } }
    );

    expect(result.analyses[0]).toMatchObject({
      state: 'unavailable',
      reasonCodes: expect.arrayContaining([
        'seasonal_baseline_insufficient',
        'source_partial',
      ]),
    });
    expect(result.publication?.occurrences[0]?.detail.analysisState).toBe(
      'unavailable'
    );
  });

  it('uses exact integer arithmetic at both approved gate boundaries', async () => {
    const exact = await evaluate(projectionWithCurrentAndBaseline(35_000, 28_000));
    const below = await evaluate(projectionWithCurrentAndBaseline(34_999, 28_000));

    expect(exact.analyses[0]).toMatchObject({
      absoluteVarianceMinor: 7_000,
      percentageVarianceBasisPoints: 2_500,
      absoluteGatePassed: true,
      relativeGatePassed: true,
      state: 'qualifiedIncrease',
    });
    expect(below.analyses[0]).toMatchObject({
      absoluteVarianceMinor: 6_999,
      percentageVarianceBasisPoints: 2_500,
      absoluteGatePassed: false,
      relativeGatePassed: false,
      state: 'withinExpectedRange',
    });
  });

  it('uses the configured minimum spread for a zero-MAD cohort', async () => {
    const result = await evaluate(projectionWithCurrent(28_640));

    expect(result.analyses[0]).toMatchObject({
      scaledMadMinor: 0,
      expectedLowerMinor: 19_000,
      expectedUpperMinor: 21_000,
      reasonCodes: expect.arrayContaining(['zero_mad_minimum_spread']),
    });
  });

  it('handles leap-month observation periods and 29-day normalization', async () => {
    const current = transaction('current-leap', '2024-02-29', -19_333);
    const history = [
      transaction('h-2023-01', '2023-01-28', -20_000),
      transaction('h-2023-02', '2023-02-28', -20_000),
      transaction('h-2022-02', '2022-02-28', -20_000),
      transaction('h-2022-03', '2022-03-28', -20_000),
    ];
    const result = await evaluate(projection([current, ...history]), {
      evidence: [billingPeriodEvidence(29)],
      source: {
        sourceAsOf: '2024-03-01T15:04:00Z',
        coverageStart: '2021-01-01',
        coverageEnd: '2024-02-29',
      },
      assignment: {
        acceptedAt: '2024-03-01T15:04:00Z',
      },
      completedAt: '2024-03-01T15:05:00Z',
      evidenceBindings: [
        {
          transactionSourceRef: 'demo-transaction-current-leap',
          documentRef: 'demo-document-bill-v1',
        },
      ],
    });

    expect(result.analyses[0]).toMatchObject({
      billingPeriod: '2024-02',
      analysisAmountMinor: 20_000,
      state: 'withinExpectedRange',
    });
  });

  it('excludes pending, transfers, refunds, and unknown credits with exact counts', async () => {
    const transactions = [
      ...seasonalHistory(),
      transaction('pending', '2026-06-15', -90_000, { isPending: true }),
      transaction('transfer', '2026-05-15', -90_000, {
        categoryRef: 'demo-category-transfer',
      }),
      transaction('refund', '2026-04-15', 90_000, {
        categoryRef: 'demo-category-refund',
      }),
      transaction('credit', '2026-03-15', 90_000),
    ];
    const result = await evaluate(projection(transactions));
    const detail = result.publication?.occurrences[0]?.detail;

    expect(result.publication?.exclusionSummary).toMatchObject({
      pending_excluded: 1,
      transfer_excluded: 1,
      refund_excluded: 1,
      unclassified_credit_excluded: 1,
    });
    expect(detail?.exclusions).toEqual([
      'pending_excluded',
      'transfer_excluded',
      'refund_excluded',
      'unclassified_credit_excluded',
    ]);
  });

  it('does not let a distinct excluded credit suppress a qualifying current bill', async () => {
    const result = await evaluate(
      projection([
        ...seasonalHistory(),
        transaction('later-credit', '2026-07-20', 5_000),
      ])
    );

    expect(result.analyses[0]).toMatchObject({
      transactionSourceRef: 'demo-transaction-current',
      state: 'qualifiedIncrease',
    });
    expect(result.publication?.exclusionSummary).toMatchObject({
      unclassified_credit_excluded: 1,
    });
  });

  it('treats duplicate same-period source references as association ambiguity', async () => {
    const result = await evaluate(
      projection([
        ...seasonalHistory(),
        transaction('duplicate', '2026-07-20', -28_640),
      ])
    );

    expect(result.analyses[0]).toMatchObject({
      state: 'unavailable',
      reasonCodes: ['classification_ambiguous'],
    });
  });

  it('preserves an open occurrence when a later record makes association ambiguous', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    const prior = priorFrom(first, 28_640);
    const result = await evaluate(
      projection([
        ...seasonalHistory(),
        transaction('duplicate', '2026-07-20', -28_640),
      ]),
      { prior: [prior] }
    );

    expect(result.analyses[0]).toMatchObject({
      state: 'unavailable',
      occurrenceId: prior.detail.occurrenceId,
    });
    expect(result.publication?.occurrences).toHaveLength(0);
    expect(result.publication?.transitions).toHaveLength(0);
  });

  it('lets classification exclusion win over an ambiguous inferred join', async () => {
    const recurring = [
      recurringFact('electric-a', { displayName: 'Demo Electric' }),
      recurringFact('electric-b', { displayName: 'Demo Electric' }),
    ];
    const pending = transaction('pending-ambiguous', '2026-07-15', -28_640, {
      recurringRef: null,
      isPending: true,
    });
    const result = await evaluate(projection([pending], recurring));

    expect(result.publication?.exclusionSummary).toMatchObject({
      pending_excluded: 1,
      classification_ambiguous: 0,
    });
    expect(
      result.analyses.every(
        (item) => !item.reasonCodes.includes('classification_ambiguous')
      )
    ).toBe(true);
  });

  it('keeps repeated stale explanation updates idempotently bounded', async () => {
    const first = await evaluate(projectionWithCurrent(28_640));
    let prior = priorFrom(first, 28_640);
    for (let index = 0; index < 10; index += 1) {
      const result = await evaluate(projectionWithCurrent(28_640), {
        prior: [prior],
        source: { sourceAsOf: '2026-08-07T15:04:59Z' },
      });
      prior = priorFrom(result, 28_640);
    }

    expect(prior.detail.explanation.length).toBeLessThanOrEqual(500);
    expect(
      prior.detail.explanation.match(/last reliable result/g)
    ).toHaveLength(1);
  });

  it('bounds alternating unavailable and insufficient lifecycle history', async () => {
    const sparse = projection([
      transaction('current', '2026-07-15', -28_640),
      transaction('prior', '2025-07-15', -20_000),
    ]);
    let result = await evaluate(sparse);
    let prior = priorFrom(result, 28_640);
    for (let index = 0; index < 30; index += 1) {
      const acceptedAt = new Date(
        Date.parse('2026-08-10T16:00:00Z') + index * 120_000
      ).toISOString();
      const completedAt = new Date(
        Date.parse(acceptedAt) + 1_000
      ).toISOString();
      result = await evaluate(sparse, {
        prior: [prior],
        assignment: { acceptedAt },
        completedAt,
        source: {
          completeness: index % 2 === 0 ? 'partial' : 'complete',
        },
      });
      const publication = result.publication?.occurrences[0];
      if (publication) prior = priorFrom(result, 28_640);
    }

    expect(prior.detail.lifecycleHistory.length).toBeLessThanOrEqual(46);
    expect(result.analyses[0]?.state).toMatch(
      /^(?:unavailable|insufficientBaseline)$/
    );
  });

  it('is independent of input order and merged page/window partitions', async () => {
    const original = projectionWithCurrent(28_640);
    const reversed = projection(
      [...original.transactions].reverse(),
      [...original.recurring].reverse()
    );
    const partitioned = projection([
      ...original.transactions.filter((_, index) => index % 2 === 0),
      ...original.transactions.filter((_, index) => index % 2 === 1),
    ]);

    const [first, second, third] = await Promise.all([
      evaluate(original),
      evaluate(reversed),
      evaluate(partitioned),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('bounds comparisons, contributors, evidence, and typed targets deterministically', async () => {
    const transactions = [
      transaction('current', '2026-07-15', -28_640),
      ...Array.from({ length: 37 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 5 - index, 15))
          .toISOString()
          .slice(0, 10);
        return transaction(`history-${index}`, date, -20_000);
      }),
    ];
    const records = Array.from({ length: 12 }, (_, index) =>
      evidence(
        index % 2 === 0 ? 'usage' : 'billAmount',
        100 + index,
        index % 2 === 0 ? 'usageUnit' : 'currencyMinor',
        `demo-document-${index}`
      )
    );
    const result = await evaluate(projection(transactions), { evidence: records });
    const detail = result.publication?.occurrences[0]?.detail;

    expect(detail?.comparisons).toHaveLength(36);
    expect(detail?.contributors).toHaveLength(1);
    expect(detail?.evidence).toHaveLength(8);
    expect(detail?.targets).toHaveLength(4);
    expect(detail?.targets.slice(2)).toEqual([
      { system: 'owl', targetKind: 'document', sourceRef: 'demo-document-0' },
      { system: 'owl', targetKind: 'document', sourceRef: 'demo-document-1' },
    ]);
  });

  it('uses configured identity overrides without inventing missing overrides', async () => {
    const unlinked = seasonalHistory().map((item) => ({
      ...item,
      recurringRef: null,
      merchantName: 'Different Merchant',
    }));
    const configuredAssociations: ConfiguredRecurringAssociationV1[] = unlinked.map(
      (item) => ({
        transactionSourceRef: item.sourceRef,
        recurringSourceRef: 'demo-recurring-electric',
      })
    );
    const configured = await evaluate(projection(unlinked), {
      configuredAssociations,
    });
    const absent = await evaluate(projection(unlinked));

    expect(configured.analyses[0]).toMatchObject({
      state: 'qualifiedIncrease',
      associationConfidence: 'configured',
    });
    expect(absent.analyses[0]).toMatchObject({
      state: 'unavailable',
      transactionSourceRef: null,
    });
  });
});

function policy(): FinanceInsightPolicySnapshotV1 {
  const candidate = createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: '2026-08-01T00:00:00Z',
    currency: 'USD',
    timezone: 'America/New_York',
  });
  return parseFinanceInsightPolicySnapshotV1({
    ...JSON.parse(JSON.stringify(candidate)),
    featureGates: {
      ...candidate.featureGates,
      recurringAmountAnalysis: true,
      recurringAmountNotifications: true,
    },
    sourceClassification: {
      ...candidate.sourceClassification,
      transferCategoryRefs: ['demo-category-transfer'],
      refundCategoryRefs: ['demo-category-refund'],
    },
  });
}

async function evaluate(
  sourceProjection: SourceProjectionV1,
  overrides: {
    evidence?: readonly EvidenceRecordV1[];
    evidenceBindings?: readonly RecurringEvidenceBindingV1[];
    prior?: readonly PriorRecurringOccurrenceV1[];
    configuredAssociations?: readonly ConfiguredRecurringAssociationV1[];
    source?: Partial<RecurringAmountSourceContextV1>;
    assignment?: Partial<{ acceptedAt: string }>;
    completedAt?: string;
  } = {}
): Promise<RecurringAmountDetectorResultV1> {
  const assignedPolicy = policy();
  const source = {
    connectorRef: 'demo-connector-v1',
    sourceGeneration: 'demo-generation-v1',
    sourceAsOf: '2026-08-10T15:04:00Z',
    coverageStart: '2023-06-01',
    coverageEnd: '2026-07-31',
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    completeness: 'complete' as const,
    ...overrides.source,
  };
  const assignment = {
    identity: {
      householdScope: 'demo-household-v1',
      connectorRef: source.connectorRef,
      sourceGeneration: source.sourceGeneration,
      detectorSetVersion: assignedPolicy.detectorSetVersion,
      policyVersion: assignedPolicy.policyVersion,
    },
    sourceSequence: 1,
    evaluationSequence: 1,
    acceptedAt: overrides.assignment?.acceptedAt ?? ACCEPTED_AT,
  };
  return evaluateRecurringAmountDetectorV1({
    projectionLoader: {
      async loadCurrentProjection() {
        return sourceProjection;
      },
    },
    evidence: {
      async find() {
        return overrides.evidence ?? [];
      },
    },
    source,
    assignment,
    policy: assignedPolicy,
    identityKey: IDENTITY_KEY,
    completedAt: overrides.completedAt ?? COMPLETED_AT,
    configuredAssociations: overrides.configuredAssociations,
    evidenceBindings: overrides.evidenceBindings,
    priorOccurrences: overrides.prior,
  });
}

function projectionWithCurrent(
  amountMinor: number,
  currentSuffix = 'current'
): SourceProjectionV1 {
  return projection(seasonalHistory(amountMinor, currentSuffix));
}

function projectionWithCurrentAndBaseline(
  currentAmount: number,
  baselineAmount: number
): SourceProjectionV1 {
  return projection(seasonalHistory(currentAmount, 'current', baselineAmount));
}

function seasonalHistory(
  currentAmount = 28_640,
  currentSuffix = 'current',
  baselineAmount = 20_000
): TransactionSourceFactV1[] {
  return [
    transaction(currentSuffix, '2026-07-15', -currentAmount),
    transaction('2025-06', '2025-06-15', -baselineAmount),
    transaction('2025-07', '2025-07-15', -baselineAmount),
    transaction('2025-08', '2025-08-15', -baselineAmount),
    transaction('2024-06', '2024-06-15', -baselineAmount),
    transaction('2024-07', '2024-07-15', -baselineAmount),
    transaction('2024-08', '2024-08-15', -baselineAmount),
  ];
}

function projection(
  transactions: readonly TransactionSourceFactV1[],
  recurring = [recurringFact('electric')]
): SourceProjectionV1 {
  return {
    transactions,
    recurring,
    categories: [],
    accounts: [],
    tags: [],
  };
}

function transaction(
  suffix: string,
  occurredOn: string,
  amountMinor: number,
  overrides: Partial<TransactionSourceFactV1> = {}
): TransactionSourceFactV1 {
  return {
    sourceRef: `demo-transaction-${suffix}`,
    occurredOn,
    amountMinor,
    merchantName: 'Demo Electric',
    categoryRef: 'demo-category-utility',
    accountRef: 'demo-account-household',
    isPending: false,
    recurringRef: 'demo-recurring-electric',
    tagRefs: [],
    ...overrides,
  };
}

function recurringFact(
  suffix: string,
  overrides: Partial<SourceProjectionV1['recurring'][number]> = {}
): SourceProjectionV1['recurring'][number] {
  return {
    sourceRef: `demo-recurring-${suffix}`,
    displayName: 'Demo Electric',
    amountMinor: -20_000,
    cadence: 'monthly',
    nextDate: '2026-08-15',
    categoryRef: 'demo-category-utility',
    accountRef: 'demo-account-household',
    active: true,
    ...overrides,
  };
}

function billingPeriodEvidence(days: number): EvidenceRecordV1 {
  return evidence('billingPeriod', days, 'days', 'demo-document-bill-v1');
}

function evidence(
  evidenceType: EvidenceRecordV1['evidenceType'],
  normalizedValueMinor: number,
  normalizedUnit: NonNullable<EvidenceRecordV1['normalizedUnit']>,
  documentRef: string
): EvidenceRecordV1 {
  return {
    source: 'owl',
    evidenceType,
    observedAt: '2026-07-15T14:00:00Z',
    documentRef,
    normalizedValueMinor,
    normalizedUnit,
  };
}

function priorFrom(
  result: RecurringAmountDetectorResultV1,
  materialAmountMinor: number
): PriorRecurringOccurrenceV1 {
  const occurrence = result.publication?.occurrences[0];
  if (!occurrence || occurrence.sourceRevisionRef === null) {
    throw new Error('Expected a published recurring occurrence');
  }
  return {
    recurringSourceRef: occurrence.detail.entity.sourceRef,
    transactionSourceRef: occurrence.detail.contributors[0]!.sourceRef,
    billingPeriod: occurrence.detail.observationPeriod.start.slice(0, 7),
    sourceRevisionRef: occurrence.sourceRevisionRef,
    materialAmountMinor,
    classification: 'knownRecurring',
    detail: occurrence.detail,
  };
}

function supersedePrior(
  prior: PriorRecurringOccurrenceV1,
  successor: PriorRecurringOccurrenceV1
): PriorRecurringOccurrenceV1 {
  return {
    ...prior,
    detail: parseInsightOccurrenceDetailV1({
      ...prior.detail,
      sourceLifecycle: 'superseded',
      resolutionReason: 'correction_superseded',
      supersededByOccurrenceId: successor.detail.occurrenceId,
      updatedAt: COMPLETED_AT,
      resolvedAt: COMPLETED_AT,
      lifecycleHistory: [
        ...prior.detail.lifecycleHistory,
        {
          sequence: prior.detail.lifecycleHistory.length + 1,
          state: 'superseded',
          reasonCode: 'correction_superseded',
          occurredAt: COMPLETED_AT,
          replacementOccurrenceId: successor.detail.occurrenceId,
        },
      ],
      availableActions: [],
    }),
  };
}
