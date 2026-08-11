import { describe, expect, it } from 'vitest';
import {
  canonicalizeV1,
  evaluateVarianceProjectionV1,
  parseFinanceInsightPolicySnapshotV1,
} from '../src/index.js';
import {
  projection,
  sixMonthSeries,
  transaction,
  varianceInput,
  variancePolicy,
} from './variance-fixtures.js';

describe('variance detector deterministic properties', () => {
  it('is independent of source and classification ordering', () => {
    const transactions = sixMonthSeries(
      [42_000, 40_000, 41_000, 39_000, 43_000, 40_000],
      70_000,
      { currentContributors: 5 }
    );
    const normal = varianceInput(transactions);
    const reversed = varianceInput([...transactions].reverse());
    reversed.classifications = [...reversed.classifications].reverse();
    expect(
      canonicalizeV1(
        evaluateVarianceProjectionV1(normal) as never
      )
    ).toBe(
      canonicalizeV1(
        evaluateVarianceProjectionV1(reversed) as never
      )
    );
  });

  it('is independent of pagination and window partition recombination', () => {
    const transactions = sixMonthSeries(Array(6).fill(50_000), 70_000, {
      currentContributors: 9,
    });
    const pages = [
      transactions.filter((_, index) => index % 3 === 0),
      transactions.filter((_, index) => index % 3 === 1),
      transactions.filter((_, index) => index % 3 === 2),
    ];
    const left = evaluateVarianceProjectionV1(
      varianceInput([...pages[0]!, ...pages[1]!, ...pages[2]!])
    );
    const right = evaluateVarianceProjectionV1(
      varianceInput([...pages[2]!, ...pages[0]!, ...pages[1]!])
    );
    expect(right).toEqual(left);
  });

  it('handles leap years, completed months, and household-local day boundaries', () => {
    const leapTransactions = [
      transaction('demo-feb', '2024-02-29', -65_000),
      transaction('demo-jan', '2024-01-31', -50_000),
      transaction('demo-dec', '2023-12-31', -50_000),
      transaction('demo-nov', '2023-11-30', -50_000),
      transaction('demo-oct', '2023-10-31', -50_000),
      transaction('demo-sep', '2023-09-30', -50_000),
      transaction('demo-aug', '2023-08-31', -50_000),
    ];
    const completed = evaluateVarianceProjectionV1(
      varianceInput(leapTransactions, {
        completedAt: '2024-03-02T15:00:00Z',
        sourceAsOf: '2024-03-02T14:00:00Z',
        coverageStart: '2023-08-01',
        coverageEnd: '2024-02-29',
        observationMonth: '2024-02',
      })
    );
    expect(completed.observationPeriod).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(completed.comparisonPeriods.at(-1)?.end).toBe('2024-01-31');

    const ny = evaluateVarianceProjectionV1(
      varianceInput([], {
        completedAt: '2026-08-11T03:30:00Z',
        sourceAsOf: '2026-08-11T03:00:00Z',
      })
    );
    const base = variancePolicy();
    const honoluluPolicy = parseFinanceInsightPolicySnapshotV1({
      ...base,
      timezone: 'Pacific/Honolulu',
    });
    const honolulu = evaluateVarianceProjectionV1(
      varianceInput([], {
        policy: honoluluPolicy,
        completedAt: '2026-08-11T03:30:00Z',
        sourceAsOf: '2026-08-11T03:00:00Z',
      })
    );
    expect(ny.observationPeriod?.end).toBe('2026-08-09');
    expect(honolulu.observationPeriod?.end).toBe('2026-08-09');

    const kiritimatiPolicy = parseFinanceInsightPolicySnapshotV1({
      ...base,
      timezone: 'Pacific/Kiritimati',
    });
    const kiritimati = evaluateVarianceProjectionV1(
      varianceInput([], {
        policy: kiritimatiPolicy,
        completedAt: '2026-08-11T03:30:00Z',
        sourceAsOf: '2026-08-11T03:00:00Z',
        coverageEnd: '2026-08-10',
      })
    );
    expect(kiritimati.observationPeriod?.end).toBe('2026-08-10');
  });

  it('uses exact integer and rational threshold arithmetic', () => {
    const exact = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000))
    );
    expect(
      exact.series.some((detail) => detail.kind === 'categoryVariance')
    ).toBe(true);
    const belowAbsolute = evaluateVarianceProjectionV1(
      varianceInput(sixMonthSeries(Array(6).fill(50_000), 64_999))
    );
    expect(
      belowAbsolute.series.some((detail) => detail.kind === 'categoryVariance')
    ).toBe(false);

    const halfCenter = evaluateVarianceProjectionV1(
      varianceInput(
        sixMonthSeries(
          [50_000, 50_000, 50_000, 50_001, 50_001, 50_001],
          65_001
        )
      )
    );
    const category = halfCenter.series.find(
      (detail) => detail.kind === 'categoryVariance'
    );
    expect(category?.baseline?.robustCenterMinor).toBe(50_001);
    expect(category?.absoluteDelta?.amountMinor).toBe(15_001);
  });

  it('keeps zero and sparse histories deterministic across merchant normalization', () => {
    const transactions = sixMonthSeries(Array(6).fill(0), 15_000, {
      merchantName: '  INVENTED   MARKET  ',
    });
    const normalized = evaluateVarianceProjectionV1(
      varianceInput(transactions)
    );
    const equivalent = evaluateVarianceProjectionV1(
      varianceInput(
        transactions.map((item) => ({
          ...item,
          merchantName: 'invented market',
        }))
      )
    );
    const merchant = (result: typeof normalized) =>
      result.series.find((detail) => detail.kind === 'merchantVariance');
    expect(merchant(equivalent)?.entity.sourceRef).toBe(
      merchant(normalized)?.entity.sourceRef
    );
    expect(merchant(normalized)?.entity.identityQuality).toBe('normalizedName');
  });

  it('orders exact ranking ties by entity kind and stable identity', () => {
    const transactions = ['b', 'a'].flatMap((suffix) =>
      sixMonthSeries(Array(6).fill(50_000), 70_000, {
        categoryRef: `demo-category-${suffix}`,
        merchantName: `Invented ${suffix.toUpperCase()}`,
      })
    );
    const result = evaluateVarianceProjectionV1(varianceInput(transactions));
    const tiedCategories = result.series.filter(
      (detail) => detail.kind === 'categoryVariance'
    );
    expect(tiedCategories.map((detail) => detail.entity.sourceRef)).toEqual([
      'demo-category-a',
      'demo-category-b',
    ]);
  });

  it('rejects unclassified, mismatched-policy, and duplicate classification input', () => {
    const input = varianceInput(sixMonthSeries(Array(6).fill(50_000), 65_000));
    expect(() =>
      evaluateVarianceProjectionV1({
        ...input,
        classifications: input.classifications.slice(1),
      })
    ).toThrow('classified before evaluation');
    expect(() =>
      evaluateVarianceProjectionV1({
        ...input,
        classifications: [
          ...input.classifications,
          input.classifications[0]!,
        ],
      })
    ).toThrow('do not match');
    expect(() =>
      evaluateVarianceProjectionV1({
        ...input,
        classifications: input.classifications.map((item) => ({
          ...item,
          policyVersion: 2,
        })),
      })
    ).toThrow('does not match policy');
  });

  it('requires a positive minimum spread and an entity-local lineage', () => {
    const base = variancePolicy();
    expect(() =>
      parseFinanceInsightPolicySnapshotV1({
        ...base,
        variance: { ...base.variance, minimumSpreadMinor: 0 },
      })
    ).toThrow('expected number to be >0');
    const input = varianceInput(
      sixMonthSeries(Array(6).fill(50_000), 65_000)
    );
    expect(() =>
      evaluateVarianceProjectionV1({
        ...input,
        classificationLineages: input.classificationLineages.filter(
          (item) => item.entityKind !== 'category'
        ),
      })
    ).toThrow('required for every evaluated entity');
  });

  it('keeps results independent of irrelevant transactions outside every window', () => {
    const baseTransactions = sixMonthSeries(Array(6).fill(50_000), 65_000);
    const base = evaluateVarianceProjectionV1(varianceInput(baseTransactions));
    const withOutsideWindow = evaluateVarianceProjectionV1(
      varianceInput([
        ...baseTransactions,
        transaction('demo-old-outside', '2020-01-01', -9_000_000),
        transaction('demo-future-outside', '2026-08-20', -9_000_000),
      ])
    );
    expect(withOutsideWindow.publication).toEqual(base.publication);
  });

  it('preserves deterministic output over repeated invented permutations', () => {
    const source = sixMonthSeries(
      [40_000, 41_000, 39_000, 42_000, 38_000, 40_000],
      70_000,
      { currentContributors: 7 }
    );
    const expected = evaluateVarianceProjectionV1(varianceInput(source));
    for (let seed = 1; seed <= 20; seed += 1) {
      const shuffled = [...source].sort((left, right) => {
        const leftRank = hash(`${seed}:${left.sourceRef}`);
        const rightRank = hash(`${seed}:${right.sourceRef}`);
        return leftRank - rightRank;
      });
      expect(evaluateVarianceProjectionV1(varianceInput(shuffled))).toEqual(
        expected
      );
    }
  });
});

function hash(value: string): number {
  let result = 0;
  for (const character of value) {
    result = (result * 33 + character.charCodeAt(0)) >>> 0;
  }
  return result;
}
