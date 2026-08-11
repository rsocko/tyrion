import { describe, expect, it } from 'vitest';
import {
  evaluateVarianceProjectionV1,
  fallbackTargetForV1,
  notificationEligibilityV1,
  parseInsightOccurrenceDetailV1,
} from '../src/index.js';
import {
  categoryResult,
  projection,
  sixMonthSeries,
  transaction,
  varianceInput,
  variancePolicy,
} from './variance-fixtures.js';

describe('category and merchant variance detector', () => {
  it('compares partial months with equivalent prior elapsed periods', () => {
    const transactions = sixMonthSeries(
      [39_000, 40_000, 40_210, 40_210, 41_000, 42_000],
      62_430
    );
    transactions.push(
      transaction('demo-after-slice', '2026-07-20', -900_000)
    );
    const result = categoryResult(varianceInput(transactions));
    expect(result?.observationPeriod).toEqual({
      start: '2026-08-01',
      end: '2026-08-10',
    });
    expect(result?.baseline?.robustCenterMinor).toBe(40_210);
    expect(
      result?.comparisons.find((item) => item.period.start === '2026-07-01')
        ?.value?.amountMinor
    ).toBe(42_000);
  });

  it('opens material increases and decreases only when every gate passes', () => {
    const increase = categoryResult(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    );
    expect(increase).toMatchObject({
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      absoluteDelta: { amountMinor: 15_000 },
      percentageDeltaBasisPoints: 3_000,
    });
    expect(increase?.reasonCodes).toEqual(
      expect.arrayContaining([
        'variance_absolute_gate_exceeded',
        'variance_relative_gate_exceeded',
        'robust_deviation_exceeded',
      ])
    );
    expect(increase?.contributors).toHaveLength(1);

    const decrease = categoryResult(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 35_000))
    );
    expect(decrease).toMatchObject({
      analysisState: 'qualified',
      absoluteDelta: { amountMinor: -15_000 },
      percentageDeltaBasisPoints: -3_000,
    });
    expect(decrease?.headline).toContain('decreased');
  });

  it('rejects percentage-only noise and dollar-only movement', () => {
    expect(
      categoryResult(
        varianceInput(sixMonthSeries(Array(6).fill(100), 250))
      )
    ).toBeUndefined();
    expect(
      categoryResult(
        varianceInput(sixMonthSeries(Array(6).fill(100_000), 120_000))
      )
    ).toBeUndefined();
  });

  it('uses the explicit zero-baseline new-spend rule without infinity', () => {
    const result = categoryResult(
      varianceInput(sixMonthSeries(Array(6).fill(0), 15_000))
    );
    expect(result).toMatchObject({
      analysisState: 'qualified',
      baselineSufficiency: 'sufficient',
      percentageDeltaBasisPoints: null,
      absoluteDelta: { amountMinor: 15_000 },
    });
    expect(result?.reasonCodes).toContain('new_spend_zero_baseline');
    expect(result?.explanation).not.toMatch(/infinity|infinite/i);
  });

  it('keeps sparse normalized merchants distinct from confidence', () => {
    const transactions = sixMonthSeries(
      [50_000, 50_000, 0, 0, 0, 0],
      80_000
    );
    const result = evaluateVarianceProjectionV1(varianceInput(transactions));
    const merchant = result.series.find(
      (detail) => detail.kind === 'merchantVariance'
    );
    expect(merchant).toMatchObject({
      analysisState: 'insufficientBaseline',
      baselineSufficiency: 'insufficient',
      confidence: 'low',
      sourceLifecycle: null,
    });
    expect(notificationEligibilityV1(merchant!, variancePolicy())).toBe(false);
  });

  it('excludes pending, transfer, income, refund, credit, recurring, and policy items', () => {
    const policy = variancePolicy(
      {},
      {
        transferTagRefs: ['demo-tag-transfer'],
        refundTagRefs: ['demo-tag-refund'],
        incomeTagRefs: ['demo-tag-income'],
        excludedCategoryRefs: ['demo-category-excluded'],
      }
    );
    const transactions = sixMonthSeries(Array(6).fill(50_000), 65_000);
    transactions.push(
      transaction('demo-pending', '2026-08-05', -10_000, { isPending: true }),
      transaction('demo-transfer', '2026-08-05', -10_000, {
        tagRefs: ['demo-tag-transfer'],
      }),
      transaction('demo-income', '2026-08-05', 10_000, {
        tagRefs: ['demo-tag-income'],
      }),
      transaction('demo-refund', '2026-08-05', 10_000, {
        tagRefs: ['demo-tag-refund'],
      }),
      transaction('demo-credit', '2026-08-05', 10_000),
      transaction('demo-recurring', '2026-08-05', -10_000, {
        recurringRef: 'demo-recurring-v1',
      }),
      transaction('demo-policy', '2026-08-05', -10_000, {
        categoryRef: 'demo-category-excluded',
      })
    );
    const result = categoryResult(
      varianceInput(transactions, {
        policy,
        projection: projection(transactions, [
          'demo-category-main',
          'demo-category-excluded',
        ]),
      })
    );
    expect(result?.observedValue?.amountMinor).toBe(65_000);
    expect(result?.baseline?.exclusionCounts).toEqual({
      pending: 1,
      transfer: 1,
      income: 1,
      refund: 1,
      unclassifiedCredit: 1,
      knownRecurring: 1,
      policyExcluded: 0,
    });
    expect(result?.exclusions).toEqual(
      expect.arrayContaining([
        'pending_excluded',
        'transfer_excluded',
        'income_excluded',
        'refund_excluded',
        'unclassified_credit_excluded',
        'known_recurring_excluded',
      ])
    );
  });

  it('recomputes category corrections and resolves the old category occurrence', () => {
    const originalTransactions = sixMonthSeries(
      Array(6).fill(50_000),
      65_000,
      { categoryRef: 'demo-category-old' }
    );
    const originalInput = varianceInput(originalTransactions, {
      classificationLineageOverrides: {
        'category:demo-category-old': 'category-old-lineage-v1',
      },
    });
    const original = evaluateVarianceProjectionV1(originalInput);
    const correctedTransactions = originalTransactions.map((item) => ({
      ...item,
      categoryRef: 'demo-category-new',
    }));
    const corrected = evaluateVarianceProjectionV1(
      varianceInput(correctedTransactions, {
        classificationLineageOverrides: {
          'category:demo-category-new': 'category-new-lineage-v2',
        },
        previousOccurrences: original.publication.occurrences,
      })
    );
    const oldCategory = original.series.find(
      (detail) => detail.kind === 'categoryVariance'
    )!;
    expect(
      corrected.publication.transitions.find(
        (item) => item.occurrenceId === oldCategory.occurrenceId
      )
    ).toMatchObject({
      state: 'resolved',
      reasonCode: 'correction_resolved',
      replacementOccurrenceId: null,
    });
    expect(
      corrected.series.find((detail) => detail.kind === 'categoryVariance')
        ?.entity.sourceRef
    ).toBe('demo-category-new');
  });

  it('supersedes direction or classification lineage reversals in the same series', () => {
    const first = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    );
    const second = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 35_000), {
        previousOccurrences: first.publication.occurrences,
      })
    );
    const previousCategory = first.series.find(
      (detail) => detail.kind === 'categoryVariance'
    )!;
    const nextCategory = second.series.find(
      (detail) => detail.kind === 'categoryVariance'
    )!;
    expect(nextCategory.insightId).toBe(previousCategory.insightId);
    expect(nextCategory.occurrenceId).not.toBe(previousCategory.occurrenceId);
    expect(
      second.publication.transitions.find(
        (item) => item.occurrenceId === previousCategory.occurrenceId
      )
    ).toEqual({
      occurrenceId: previousCategory.occurrenceId,
      state: 'superseded',
      reasonCode: 'correction_superseded',
      replacementOccurrenceId: nextCategory.occurrenceId,
      occurredAt: '2026-08-11T14:00:00Z',
    });
  });

  it('bounds and deterministically ranks persistent movers, contributors, and digest members', () => {
    const transactions = Array.from({ length: 12 }, (_, categoryIndex) =>
      sixMonthSeries(Array(6).fill(50_000), 70_000, {
        categoryRef: `demo-category-${String(categoryIndex).padStart(2, '0')}`,
        merchantName: `Invented Merchant ${String(categoryIndex).padStart(2, '0')}`,
        currentContributors: 11,
      })
    ).flat();
    const result = evaluateVarianceProjectionV1(varianceInput(transactions));
    expect(result.series).toHaveLength(10);
    expect(
      result.series.every((detail) => detail.kind === 'categoryVariance')
    ).toBe(true);
    expect(result.series.map((detail) => detail.entity.sourceRef)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `demo-category-${String(index).padStart(2, '0')}`
      )
    );
    expect(result.series[0]?.contributors).toHaveLength(10);
    expect(result.omittedQualifiedCount).toBeGreaterThan(0);
    expect(result.digest?.members).toHaveLength(10);
    expect(result.digest?.scheduledAt).toBe('2026-09-02T13:00:00.000Z');
    expect(result.digest?.members.every((member) => member.kind === 'categoryVariance')).toBe(
      true
    );
  });

  it('retires a previously open mover when deterministic top-ten ranking evicts it', () => {
    const firstTransactions = Array.from({ length: 10 }, (_, categoryIndex) =>
      sixMonthSeries(Array(6).fill(50_000), 70_000, {
        categoryRef: `demo-category-${String(categoryIndex).padStart(2, '0')}`,
        merchantName: `Invented Merchant ${String(categoryIndex).padStart(2, '0')}`,
      })
    ).flat();
    const first = evaluateVarianceProjectionV1(varianceInput(firstTransactions));
    const evicted = first.series.at(-1)!;
    const secondTransactions = [
      ...firstTransactions,
      ...sixMonthSeries(Array(6).fill(50_000), 90_000, {
        categoryRef: 'demo-category-new',
        merchantName: 'Invented Merchant New',
      }),
    ];
    const second = evaluateVarianceProjectionV1(
      varianceInput(secondTransactions, {
        previousOccurrences: first.publication.occurrences,
      })
    );
    expect(second.series).toHaveLength(10);
    expect(second.series.some((item) => item.entity.sourceRef === 'demo-category-new')).toBe(
      true
    );
    expect(
      second.publication.transitions.find(
        (item) => item.occurrenceId === evicted.occurrenceId
      )
    ).toMatchObject({
      state: 'resolved',
      reasonCode: 'variance_rank_omitted',
      replacementOccurrenceId: null,
    });

    const eviction = second.publication.transitions.find(
      (item) => item.occurrenceId === evicted.occurrenceId
    )!;
    const closedEvicted = parseInsightOccurrenceDetailV1({
      ...evicted,
      sourceLifecycle: 'resolved',
      resolutionReason: eviction.reasonCode,
      updatedAt: eviction.occurredAt,
      resolvedAt: eviction.occurredAt,
      lifecycleHistory: [
        ...evicted.lifecycleHistory,
        {
          sequence: evicted.lifecycleHistory.at(-1)!.sequence + 1,
          state: 'resolved',
          reasonCode: eviction.reasonCode,
          occurredAt: eviction.occurredAt,
          replacementOccurrenceId: null,
        },
      ],
      availableActions: [],
    });
    const third = evaluateVarianceProjectionV1(
      varianceInput(firstTransactions, {
        previousOccurrences: [
          ...second.publication.occurrences,
          { detail: closedEvicted, sourceRevisionRef: null },
        ],
      })
    );
    const reentered = third.series.find(
      (item) => item.entity.sourceRef === evicted.entity.sourceRef
    )!;
    expect(reentered.occurrenceId).not.toBe(evicted.occurrenceId);
    expect(reentered.sourceLifecycle).toBe('open');
    expect(reentered.lifecycleHistory.map((item) => item.state)).toEqual([
      'analyzing',
      'open',
    ]);
  });

  it('changes correction lineage only for the affected entity', () => {
    const transactions = ['a', 'b'].flatMap((suffix) =>
      sixMonthSeries(Array(6).fill(50_000), 70_000, {
        categoryRef: `demo-category-${suffix}`,
        merchantName: `Invented Merchant ${suffix.toUpperCase()}`,
      })
    );
    const first = evaluateVarianceProjectionV1(varianceInput(transactions));
    const second = evaluateVarianceProjectionV1(
      varianceInput(transactions, {
        classificationLineageOverrides: {
          'category:demo-category-a': 'category-a-correction-lineage-v2',
        },
        previousOccurrences: first.publication.occurrences,
      })
    );
    const occurrence = (
      result: typeof first,
      sourceRef: string
    ) =>
      result.series.find(
        (detail) =>
          detail.kind === 'categoryVariance' &&
          detail.entity.sourceRef === sourceRef
      )!;
    expect(occurrence(second, 'demo-category-a').occurrenceId).not.toBe(
      occurrence(first, 'demo-category-a').occurrenceId
    );
    expect(occurrence(second, 'demo-category-b').occurrenceId).toBe(
      occurrence(first, 'demo-category-b').occurrenceId
    );
  });

  it('keeps medium-confidence movers visible but out of notifications and digest', () => {
    const result = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 70_000))
    );
    const merchant = result.series.find(
      (detail) => detail.kind === 'merchantVariance'
    )!;
    expect(merchant).toMatchObject({
      analysisState: 'qualified',
      confidence: 'medium',
    });
    expect(merchant.reasonCodes).toContain('medium_confidence_no_notify');
    expect(notificationEligibilityV1(merchant, variancePolicy())).toBe(false);
    expect(
      result.digest?.members.some(
        (member) => member.occurrenceId === merchant.occurrenceId
      )
    ).toBe(false);
  });

  it('uses configured merchant aliases for stable keyed high-confidence movers', () => {
    const input = varianceInput(
      sixMonthSeries(Array(6).fill(50_000), 70_000),
      { merchantAlias: true }
    );
    const result = evaluateVarianceProjectionV1(input);
    const merchant = result.series.find(
      (detail) => detail.kind === 'merchantVariance'
    )!;
    expect(merchant.entity).toMatchObject({
      identityQuality: 'configuredAlias',
      displayName: 'Invented Market',
    });
    expect(merchant.confidence).toBe('high');
    expect(merchant.targets[0]).toMatchObject({
      targetKind: 'reportFilter',
      categorySourceRef: null,
      merchantKey: merchant.entity.sourceRef,
    });
    expect(
      result.digest?.members.some(
        (member) => member.occurrenceId === merchant.occurrenceId
      )
    ).toBe(true);
  });

  it('emits a typed report-filter target and safe reports-root fallback without URLs', () => {
    const result = categoryResult(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    )!;
    expect(result.targets).toEqual([
      {
        system: 'monarch',
        targetKind: 'reportFilter',
        reportKind: 'spending',
        period: { start: '2026-08-01', end: '2026-08-10' },
        categorySourceRef: 'demo-category-main',
        merchantKey: null,
      },
      { system: 'monarch', targetKind: 'safeRoot', root: 'reports' },
    ]);
    expect(fallbackTargetForV1(result.targets[0]!)).toEqual(
      result.targets[1]
    );
    expect(JSON.stringify(result.targets)).not.toMatch(/https?:|url/i);
  });

  it('does not open, revise, or resolve occurrences from stale or partial input', () => {
    const reliable = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    );
    for (const options of [
      { sourceAsOf: '2026-08-08T13:00:00Z' },
      { completeness: 'partial' as const },
      { completeness: 'unavailable' as const },
    ]) {
      const result = evaluateVarianceProjectionV1(
        varianceInput(sixMonthSeries(Array(6).fill(50_000), 80_000), {
          ...options,
          previousOccurrences: reliable.publication.occurrences,
        })
      );
      expect(result.publication).toMatchObject({
        occurrences: [],
        transitions: [],
      });
      expect(result.digest).toBeNull();
    }
  });

  it('ignores prior occurrences owned by another connector', () => {
    const first = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    );
    const foreign = parseInsightOccurrenceDetailV1({
      ...first.series.find(
        (detail) => detail.kind === 'categoryVariance'
      )!,
      observationPeriod: { start: '2026-07-01', end: '2026-07-31' },
      provenance: {
        ...first.series.find(
          (detail) => detail.kind === 'categoryVariance'
        )!.provenance,
        connectorRef: 'demo-other-connector-v1',
      },
    });
    const result = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000), {
        previousOccurrences: [
          { detail: foreign, sourceRevisionRef: null },
        ],
      })
    );
    expect(result.publication.transitions).toEqual([]);
  });

  it('increments delivery revision only at the exact material boundary', () => {
    const first = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    );
    const previous = first.publication.occurrences;
    const below = categoryResult(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_999), {
        previousOccurrences: previous,
      })
    )!;
    const exact = categoryResult(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 66_000), {
        previousOccurrences: previous,
      })
    )!;
    expect(below.deliveryRevision).toBe(1);
    expect(exact.deliveryRevision).toBe(2);
    expect(below.createdAt).toBe(first.series[0]?.createdAt);
  });

  it('produces contract-valid details and deterministic digest retry identity', () => {
    const first = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 70_000))
    );
    for (const detail of first.series) {
      expect(parseInsightOccurrenceDetailV1(detail)).toEqual(detail);
    }
    const retried = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 70_000), {
        previousOccurrences: first.publication.occurrences,
        previousDigest: first.digest,
      })
    );
    expect(retried.digest).toEqual(first.digest);
    expect(retried.publication.occurrences).toEqual(first.publication.occurrences);
    expect(
      retried.publication.occurrences.map((item) =>
        parseInsightOccurrenceDetailV1(item.detail)
      )
    ).toHaveLength(retried.series.length);
  });
});
