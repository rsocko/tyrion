import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_MINOR_V1,
  createCandidatePolicySnapshotV1,
  deriveMerchantKeyV1,
  evaluateLargeTransactionsV1,
  parseFinanceInsightPolicySnapshotV1,
  parseInsightOccurrenceDetailV1,
  parseSourceGenerationCreateRequestV1,
  type AssignedEvaluationV1,
  type FinanceInsightPolicySnapshotV1,
  type LargeTransactionEvaluationInputV1,
  type SourceGenerationCreateRequestV1,
  type SourceProjectionV1,
  type TransactionSourceFactV1,
} from '../src/index.js';
import { compareRobustlyV1 } from '../src/detectors/robust-statistics-v1.js';

const IDENTITY_KEY = Buffer.alloc(32, 23);
const DIGEST = `sha256:${'0'.repeat(64)}`;
const COMPLETED_AT = '2026-08-10T16:00:00Z';

describe('unusually large transaction detector v1', () => {
  it('opens one high-confidence occurrence when explicit and adaptive rules agree', () => {
    const candidate = transaction('candidate', '2026-08-10', -184_000);
    const result = evaluate([
      ...history('shared', 5, -20_000),
      candidate,
    ]);
    const detail = occurrenceFor(result, candidate.sourceRef);

    expect(detail).toMatchObject({
      kind: 'largeTransaction',
      confidence: 'high',
      baselineSufficiency: 'sufficient',
      observedValue: { currency: 'USD', amountMinor: 184_000 },
      reasonCodes: expect.arrayContaining([
        'explicit_amount_rule_exceeded',
        'adaptive_baseline_agreement',
        'adaptive_merchant_baseline_triggered',
        'adaptive_category_baseline_triggered',
      ]),
      targets: [
        {
          system: 'monarch',
          targetKind: 'transaction',
          sourceRef: 'candidate',
        },
      ],
    });
    expect(detail.comparisons).toHaveLength(4);
    expect(detail.ruleResults.map((rule) => rule.ruleCode)).toEqual([
      'large_transaction_explicit_amount',
      'large_transaction_adaptive_floor',
      'large_transaction_merchant_baseline',
      'large_transaction_category_baseline',
      'large_transaction_account_baseline',
      'large_transaction_household_baseline',
      'large_transaction_adaptive_agreement',
    ]);
    expect(detail.explanation.toLowerCase()).not.toMatch(
      /fraud|suspicious|compromised|card-security/
    );
    expect('url' in detail.targets[0]!).toBe(false);
  });

  it('opens on the explicit rule with a separately labeled insufficient adaptive baseline', () => {
    const candidate = transaction('new-merchant', '2026-08-10', -120_000, {
      merchantName: 'Invented New Merchant',
      categoryRef: null,
      accountRef: null,
    });
    const result = evaluate([candidate]);
    const detail = occurrenceFor(result, candidate.sourceRef);

    expect(detail.reasonCodes).toEqual([
      'explicit_amount_rule_exceeded',
      'adaptive_baseline_insufficient',
      'normalized_name_identity',
    ]);
    expect(detail.baselineSufficiency).toBe('insufficient');
    expect(detail.confidence).toBe('medium');
    expect(detail.comparisons.every((comparison) => !comparison.eligible)).toBe(
      true
    );
  });

  it('requires the exact floor and at least two eligible triggered dimensions below the explicit rule', () => {
    const base = twoDimensionHistory();
    const exactFloor = transaction('adaptive-floor', '2026-08-10', -15_000, {
      merchantName: 'Adaptive Merchant',
      categoryRef: 'adaptive-category',
      accountRef: 'ordinary-account',
    });
    const belowFloor = { ...exactFloor, sourceRef: 'below-floor', amountMinor: -14_999 };

    const exact = evaluate([...base, exactFloor]);
    const detail = occurrenceFor(exact, exactFloor.sourceRef);
    expect(detail.reasonCodes).toEqual(
      expect.arrayContaining([
        'adaptive_baseline_agreement',
        'adaptive_merchant_baseline_triggered',
        'adaptive_category_baseline_triggered',
      ])
    );
    expect(detail.reasonCodes).not.toContain('explicit_amount_rule_exceeded');
    expect(
      detail.ruleResults.filter((rule) => rule.outcome === 'triggered')
    ).toHaveLength(4);
    expect(evaluate([...base, belowFloor]).publication.occurrences).toHaveLength(
      0
    );
  });

  it('does not alert when only one adaptive baseline agrees, including account-only cases', () => {
    const merchantCandidate = transaction('merchant-only', '2026-08-10', -60_000, {
      merchantName: 'Only Merchant',
      categoryRef: null,
      accountRef: 'ordinary-account',
    });
    const merchantHistory = history('merchant-only-history', 5, -10_000, {
      merchantName: ' only   merchant ',
      categoryRef: 'other-category',
      accountRef: 'other-account',
    });
    const ordinaryHousehold = history('ordinary-household', 10, -58_000, {
      uniqueDimensions: true,
    });
    expect(
      evaluate([...merchantHistory, ...ordinaryHousehold, merchantCandidate])
        .publication.occurrences
    ).toHaveLength(0);

    const accountCandidate = transaction('account-only', '2026-08-10', -60_000, {
      merchantName: 'No Merchant History',
      categoryRef: null,
      accountRef: 'low-account',
    });
    const accountHistory = history('account-history', 5, -10_000, {
      merchantName: 'Other Merchant',
      categoryRef: 'other-category',
      accountRef: 'low-account',
    });
    expect(
      evaluate([...accountHistory, ...ordinaryHousehold, accountCandidate])
        .publication.occurrences
    ).toHaveLength(0);
  });

  it('applies source classification before current and baseline construction', () => {
    const transferCategory = 'transfer-category';
    const incomeCategory = 'income-category';
    const refundCategory = 'refund-category';
    const excludedCategory = 'excluded-category';
    const policy = enabledPolicy({
      sourceClassification: {
        transferCategoryRefs: [transferCategory],
        incomeCategoryRefs: [incomeCategory],
        refundCategoryRefs: [refundCategory],
        excludedCategoryRefs: [excludedCategory],
      },
    });
    const facts = [
      transaction('pending', '2026-08-10', -500_000, { isPending: true }),
      transaction('transfer', '2026-08-10', -500_000, {
        categoryRef: transferCategory,
      }),
      transaction('income', '2026-08-10', 500_000, {
        categoryRef: incomeCategory,
      }),
      transaction('refund', '2026-08-10', 500_000, {
        categoryRef: refundCategory,
      }),
      transaction('credit', '2026-08-10', 500_000),
      transaction('recurring', '2026-08-10', -500_000, {
        recurringRef: 'invented-mortgage',
      }),
      transaction('excluded', '2026-08-10', -500_000, {
        categoryRef: excludedCategory,
      }),
    ];
    const result = evaluate(facts, { policy });

    expect(result.publication.occurrences).toHaveLength(0);
    expect(result.publication.exclusionSummary).toMatchObject({
      pending_excluded: 1,
      transfer_excluded: 1,
      income_excluded: 1,
      refund_excluded: 1,
      unclassified_credit_excluded: 1,
      known_recurring_excluded: 1,
      policy_excluded: 1,
    });
  });

  it('suppresses approved merchants and structured expected/suppressed scopes', () => {
    const approvedKey = deriveMerchantKeyV1(IDENTITY_KEY, 'Approved Merchant');
    const policy = enabledPolicy({
      largeTransaction: {
        approvedMerchantKeys: [approvedKey],
        expectedScopes: [
          { kind: 'category', sourceRef: 'tuition-category' },
          { kind: 'transaction', sourceRef: 'expected-tax' },
        ],
        suppressedScopes: [
          { kind: 'account', sourceRef: 'suppressed-account' },
        ],
      },
    });
    const facts = [
      transaction('approved', '2026-08-10', -300_000, {
        merchantName: ' approved   merchant ',
      }),
      transaction('tuition', '2026-08-10', -300_000, {
        categoryRef: 'tuition-category',
      }),
      transaction('expected-tax', '2026-08-10', -300_000),
      transaction('suppressed', '2026-08-10', -300_000, {
        accountRef: 'suppressed-account',
      }),
      transaction('mortgage', '2026-08-10', -300_000, {
        recurringRef: 'invented-mortgage',
      }),
    ];
    const result = evaluate(facts, { policy });

    expect(result.publication.occurrences).toHaveLength(0);
    expect(result.publication.exclusionSummary).toMatchObject({
      approved_merchant_excluded: 1,
      expected_scope_excluded: 2,
      suppressed_scope_excluded: 1,
      known_recurring_excluded: 1,
    });
  });

  it('waits for pending transactions and opens exactly one occurrence when posted', () => {
    const pending = transaction('pending-posted', '2026-08-10', -120_000, {
      isPending: true,
    });
    expect(evaluate([pending]).publication.occurrences).toHaveLength(0);

    const posted = { ...pending, isPending: false };
    const postedResult = evaluate([posted], { sourceSequence: 2 });
    expect(postedResult.publication.occurrences).toHaveLength(1);
    expect(postedResult.publication.occurrences[0]!.detail.entity.sourceRef).toBe(
      posted.sourceRef
    );
  });

  it('supersedes or resolves corrected source lineage without mutating the old occurrence', () => {
    const original = transaction('corrected', '2026-08-10', -120_000);
    const first = evaluate([original]);
    const firstPublication = first.publication.occurrences[0]!;
    const previous = {
      transactionSourceRef: original.sourceRef,
      sourceRevisionRef: firstPublication.sourceRevisionRef!,
      amountMinor: 120_000,
      classification: 'postedSpend' as const,
      detail: firstPublication.detail,
    };

    const corrected = { ...original, amountMinor: -130_000 };
    const successor = evaluate([corrected], {
      sourceSequence: 2,
      previousOccurrences: [previous],
    });
    const replacement = successor.publication.occurrences[0]!;
    expect(replacement.detail.insightId).toBe(firstPublication.detail.insightId);
    expect(replacement.detail.occurrenceId).not.toBe(
      firstPublication.detail.occurrenceId
    );
    expect(replacement.detail.deliveryRevision).toBe(1);
    expect(successor.publication.transitions).toEqual([
      {
        occurrenceId: firstPublication.detail.occurrenceId,
        state: 'superseded',
        reasonCode: 'correction_superseded',
        replacementOccurrenceId: replacement.detail.occurrenceId,
        occurredAt: COMPLETED_AT,
      },
    ]);

    const refundPolicy = enabledPolicy({
      sourceClassification: { refundCategoryRefs: ['refund-category'] },
    });
    const refund = {
      ...original,
      amountMinor: 120_000,
      categoryRef: 'refund-category',
    };
    const resolved = evaluate([refund], {
      policy: refundPolicy,
      sourceSequence: 2,
      previousOccurrences: [previous],
    });
    expect(resolved.publication.occurrences).toHaveLength(0);
    expect(resolved.publication.transitions[0]).toMatchObject({
      occurrenceId: firstPublication.detail.occurrenceId,
      state: 'resolved',
      reasonCode: 'correction_resolved',
      replacementOccurrenceId: null,
    });
  });

  it('reserves bounded publication capacity for qualifying correction successors', () => {
    const policy = enabledPolicy({
      largeTransaction: { publicationLimit: 1 },
    });
    const original = transaction('corrected-cap', '2026-08-01', -120_000);
    const first = evaluate([original], { policy });
    const prior = first.publication.occurrences[0]!;
    const corrected = { ...original, amountMinor: -121_000 };
    const newer = transaction('newer-cap', '2026-08-10', -500_000);
    const next = evaluate([corrected, newer], {
      policy,
      sourceSequence: 2,
      previousOccurrences: [
        {
          transactionSourceRef: original.sourceRef,
          sourceRevisionRef: prior.sourceRevisionRef!,
          amountMinor: 120_000,
          classification: 'postedSpend',
          detail: prior.detail,
        },
      ],
    });

    expect(next.publication.occurrences).toHaveLength(1);
    expect(next.publication.occurrences[0]!.detail.entity.sourceRef).toBe(
      corrected.sourceRef
    );
    expect(next.publication.transitions[0]).toMatchObject({
      state: 'superseded',
      replacementOccurrenceId:
        next.publication.occurrences[0]!.detail.occurrenceId,
    });
    expect(next.omittedQualifiedCount).toBe(1);
  });

  it('publishes every required correction closure or fails before returning a partial set', () => {
    const originals = Array.from({ length: 3 }, (_, index) =>
      transaction(
        `closure-${index}`,
        `2026-08-0${index + 1}`,
        -(120_000 + index)
      )
    );
    const policy = enabledPolicy();
    const first = evaluate(originals, { policy });
    const previousOccurrences = first.publication.occurrences.map(
      (publication) => ({
        transactionSourceRef: publication.detail.entity.sourceRef,
        sourceRevisionRef: publication.sourceRevisionRef!,
        amountMinor: publication.detail.observedValue!.amountMinor,
        classification: 'postedSpend' as const,
        detail: publication.detail,
      })
    );
    const closed = evaluate([], {
      policy,
      sourceSequence: 2,
      previousOccurrences,
    });
    expect(closed.publication.transitions).toHaveLength(3);
    expect(
      closed.publication.transitions.every(
        (transition) => transition.state === 'resolved'
      )
    ).toBe(true);

    const constrained = enabledPolicy({
      largeTransaction: { lifecycleTransitionLimit: 2 },
    });
    expect(() =>
      evaluate([], {
        policy: constrained,
        sourceSequence: 2,
        previousOccurrences,
      })
    ).toThrow('lifecycle transitions exceed');
  });

  it('increments a material non-correction revision in place and leaves reevaluations stable', () => {
    const original = transaction('material-revision', '2026-08-10', -120_000);
    const first = evaluate([original]);
    const prior = first.publication.occurrences[0]!;
    const previous = {
      transactionSourceRef: original.sourceRef,
      sourceRevisionRef: prior.sourceRevisionRef!,
      amountMinor: 120_000,
      classification: 'postedSpend' as const,
      detail: prior.detail,
      changeKind: 'evidence' as const,
    };
    const revised = evaluate([{ ...original, amountMinor: -121_000 }], {
      sourceSequence: 2,
      previousOccurrences: [previous],
    });
    const detail = revised.publication.occurrences[0]!.detail;
    expect(detail.occurrenceId).toBe(prior.detail.occurrenceId);
    expect(detail.deliveryRevision).toBe(2);
    expect(detail.reasonCodes).toContain('material_source_change');
    expect(revised.publication.transitions).toEqual([]);

    const replay = evaluate([original], {
      previousOccurrences: [
        {
          ...previous,
          changeKind: 'reevaluation',
        },
      ],
    });
    expect(replay.publication.occurrences[0]!.detail).toEqual(prior.detail);
  });

  it('reports zero-MAD safeguards and handles the contract amount extreme exactly', () => {
    const repeated = history('zero-mad', 5, -10_000);
    const zeroMad = evaluate([
      ...repeated,
      transaction('zero-mad-candidate', '2026-08-10', -30_000),
    ]);
    const zeroDetail = occurrenceFor(zeroMad, 'zero-mad-candidate');
    expect(zeroDetail.reasonCodes).toContain('zero_mad_minimum_spread');
    expect(zeroDetail.comparisons[0]).toMatchObject({
      medianMinor: 10_000,
      dispersionMinor: 0,
    });

    const extreme = evaluate([
      ...history('extreme-history', 5, -1),
      transaction('extreme', '2026-08-10', -MAX_AMOUNT_MINOR_V1),
    ]);
    const extremeDetail = occurrenceFor(extreme, 'extreme');
    expect(extremeDetail.observedValue?.amountMinor).toBe(MAX_AMOUNT_MINOR_V1);
    expect(
      extremeDetail.comparisons.every(
        (comparison) =>
          comparison.ratioBasisPoints === null ||
          comparison.ratioBasisPoints <= 1_000_000
      )
    ).toBe(true);
    expect(() => parseInsightOccurrenceDetailV1(extremeDetail)).not.toThrow();
  });

  it('distinguishes stale, partial, and unavailable input without publishing alerts', () => {
    const fact = transaction('freshness', '2026-08-10', -120_000);
    expect(
      evaluate([fact], {
        completedAt: '2026-08-12T16:00:01Z',
      })
    ).toMatchObject({
      state: 'stale',
      reasonCodes: ['source_stale'],
      publication: { occurrences: [], transitions: [] },
    });
    expect(
      evaluate([fact], { sourceCompleteness: 'partial' })
    ).toMatchObject({
      state: 'partial',
      reasonCodes: ['source_partial'],
      publication: { occurrences: [], transitions: [] },
    });
    expect(
      evaluate([fact], { sourceCompleteness: 'unavailable' })
    ).toMatchObject({
      state: 'unavailable',
      reasonCodes: ['source_unavailable'],
      publication: { occurrences: [], transitions: [] },
    });
  });

  it('is invariant to page order, window partitioning, and repeated evaluation', () => {
    const facts = [
      ...twoDimensionHistory(),
      transaction('invariant', '2026-08-10', -60_000, {
        merchantName: 'Adaptive Merchant',
        categoryRef: 'adaptive-category',
        accountRef: 'ordinary-account',
      }),
    ];
    const expected = evaluate(facts);
    for (let seed = 1; seed <= 20; seed += 1) {
      const pages = partition(shuffle(facts, seed), (seed % 4) + 1);
      const replay = evaluate(pages.flat());
      expect(replay).toEqual(expected);
    }
    expect(evaluate(facts)).toEqual(expected);
  });

  it('bounds publication deterministically and reports omitted qualified results', () => {
    const facts = Array.from({ length: 8 }, (_, index) =>
      transaction(
        `bounded-${index}`,
        `2026-08-${String(index + 1).padStart(2, '0')}`,
        -(120_000 + index)
      )
    );
    const policy = enabledPolicy({
      largeTransaction: { publicationLimit: 3 },
    });
    const result = evaluate(facts, { policy });

    expect(result.publication.occurrences).toHaveLength(3);
    expect(
      result.publication.occurrences.map(
        (publication) => publication.detail.entity.sourceRef
      )
    ).toEqual(['bounded-7', 'bounded-6', 'bounded-5']);
    expect(result.omittedQualifiedCount).toBe(5);
    expect(result.publication.exclusionSummary).toMatchObject({
      qualified_output_omitted: 5,
    });
  });

  it('uses locale-independent code-unit ordering for bounded ties', () => {
    const policy = enabledPolicy({
      largeTransaction: { publicationLimit: 1 },
    });
    const tied = [
      transaction('a-tie', '2026-08-10', -120_000),
      transaction('A-tie', '2026-08-10', -120_000),
    ];
    expect(
      evaluate(tied, { policy }).publication.occurrences[0]!.detail.entity
        .sourceRef
    ).toBe('A-tie');
  });

  it('uses inclusive exact arithmetic for robust comparison gates', () => {
    const comparison = compareRobustlyV1(20_000, [10_000, 10_000, 10_000], {
      robustDeviationMultiplierMilli: 3_000,
      minimumSpreadMinor: 10_000,
      empiricalPercentileGateBasisPoints: 10_000,
      ratioGateBasisPoints: 20_000,
    });
    expect(comparison).toMatchObject({
      expectedUpperMinor: 20_000,
      empiricalPercentileBasisPoints: 10_000,
      ratioBasisPoints: 20_000,
      robustGateMet: true,
      percentileGateMet: true,
      ratioGateMet: true,
      triggered: true,
    });
    expect(
      compareRobustlyV1(30_000, [10_000, 20_000], {
        robustDeviationMultiplierMilli: 1_000,
        minimumSpreadMinor: 0,
        empiricalPercentileGateBasisPoints: 10_000,
        ratioGateBasisPoints: 20_000,
      })
    ).toMatchObject({
      medianMinor: 15_000,
      scaledMadMinor: 7_413,
      ratioBasisPoints: 20_000,
    });
  });

  it('rejects anything other than the complete promoted projection assigned by T2', () => {
    const fact = transaction('projection-fence', '2026-08-10', -120_000);
    const policy = enabledPolicy();
    const source = sourceRequest(2, 1);
    const assignment: AssignedEvaluationV1 = {
      identity: {
        householdScope: 'invented-household',
        connectorRef: source.connectorRef,
        sourceGeneration: source.sourceGeneration,
        detectorSetVersion: policy.detectorSetVersion,
        policyVersion: policy.policyVersion,
      },
      sourceSequence: 1,
      evaluationSequence: 1,
      acceptedAt: '2026-08-10T15:59:00Z',
    };
    expect(() =>
      evaluateLargeTransactionsV1({
        projection: {
          transactions: [fact],
          recurring: [],
          categories: [],
          accounts: [],
          tags: [],
        },
        source,
        assignment,
        policy,
        identityKey: IDENTITY_KEY,
        sourceCompleteness: 'complete',
        completedAt: COMPLETED_AT,
      })
    ).toThrow('complete promoted projection');
  });
});

interface EvaluateOptions {
  readonly policy?: FinanceInsightPolicySnapshotV1;
  readonly sourceSequence?: number;
  readonly sourceCompleteness?: LargeTransactionEvaluationInputV1['sourceCompleteness'];
  readonly completedAt?: string;
  readonly previousOccurrences?: LargeTransactionEvaluationInputV1['previousOccurrences'];
}

function evaluate(
  transactions: readonly TransactionSourceFactV1[],
  options: EvaluateOptions = {}
) {
  const policy = options.policy ?? enabledPolicy();
  const sourceSequence = options.sourceSequence ?? 1;
  const source = sourceRequest(transactions.length, sourceSequence);
  const assignment: AssignedEvaluationV1 = {
    identity: {
      householdScope: 'invented-household',
      connectorRef: source.connectorRef,
      sourceGeneration: source.sourceGeneration,
      detectorSetVersion: policy.detectorSetVersion,
      policyVersion: policy.policyVersion,
    },
    sourceSequence,
    evaluationSequence: sourceSequence,
    acceptedAt: '2026-08-10T15:59:00Z',
  };
  const projection: SourceProjectionV1 = {
    transactions: [...transactions],
    recurring: [],
    categories: [],
    accounts: [],
    tags: [],
  };
  return evaluateLargeTransactionsV1({
    projection,
    source,
    assignment,
    policy,
    identityKey: IDENTITY_KEY,
    sourceCompleteness: options.sourceCompleteness ?? 'complete',
    completedAt: options.completedAt ?? COMPLETED_AT,
    previousOccurrences: options.previousOccurrences,
  });
}

interface PolicyOverrides {
  readonly sourceClassification?: Partial<
    FinanceInsightPolicySnapshotV1['sourceClassification']
  >;
  readonly largeTransaction?: Partial<
    FinanceInsightPolicySnapshotV1['largeTransaction']
  >;
}

function enabledPolicy(
  overrides: PolicyOverrides = {}
): FinanceInsightPolicySnapshotV1 {
  const candidate = createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: '2026-08-10T15:00:00Z',
    currency: 'USD',
    timezone: 'America/New_York',
  });
  return parseFinanceInsightPolicySnapshotV1({
    ...structuredClone(candidate),
    featureGates: {
      ...structuredClone(candidate.featureGates),
      largeTransactionAnalysis: true,
    },
    sourceClassification: {
      ...structuredClone(candidate.sourceClassification),
      ...overrides.sourceClassification,
    },
    largeTransaction: {
      ...structuredClone(candidate.largeTransaction),
      ...overrides.largeTransaction,
    },
  });
}

function sourceRequest(
  transactionCount: number,
  sourceSequence: number
): SourceGenerationCreateRequestV1 {
  const sourceAsOf = '2026-08-10T15:30:00Z';
  const itemCounts = {
    transaction: transactionCount,
    recurring: 0,
    category: 0,
    account: 0,
    tag: 0,
  } as const;
  const kinds = Object.keys(itemCounts) as Array<keyof typeof itemCounts>;
  return parseSourceGenerationCreateRequestV1({
    contractVersion: '1.0',
    connectorRef: 'invented-connector',
    sourceGeneration: `invented-generation-${sourceSequence}`,
    sourceSequence,
    sourceAsOf,
    coverageStart: '2025-01-01',
    coverageEnd: '2026-08-10',
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    capturedConstituents: kinds.map((kind) => ({
      kind,
      generationRef: `invented-${kind}-${sourceSequence}`,
      sourceAsOf,
      itemCount: itemCounts[kind],
      digest: DIGEST,
    })),
    manifest: kinds.map((kind) => ({
      kind,
      batchCount: itemCounts[kind] === 0 ? 0 : Math.ceil(itemCounts[kind] / 250),
      itemCount: itemCounts[kind],
      digest: DIGEST,
    })),
    idempotencyKey: `invented-generation-${sourceSequence}-idempotency`,
  });
}

interface TransactionOverrides {
  readonly merchantName?: string;
  readonly categoryRef?: string | null;
  readonly accountRef?: string | null;
  readonly isPending?: boolean;
  readonly recurringRef?: string | null;
  readonly tagRefs?: readonly string[];
}

function transaction(
  sourceRef: string,
  occurredOn: string,
  amountMinor: number,
  overrides: TransactionOverrides = {}
): TransactionSourceFactV1 {
  return {
    sourceRef,
    occurredOn,
    amountMinor,
    merchantName: overrides.merchantName ?? 'Shared Merchant',
    categoryRef:
      overrides.categoryRef === undefined ? 'shared-category' : overrides.categoryRef,
    accountRef:
      overrides.accountRef === undefined ? 'shared-account' : overrides.accountRef,
    isPending: overrides.isPending ?? false,
    recurringRef: overrides.recurringRef ?? null,
    tagRefs: [...(overrides.tagRefs ?? [])],
  };
}

interface HistoryOverrides extends TransactionOverrides {
  readonly uniqueDimensions?: boolean;
}

function history(
  prefix: string,
  count: number,
  amountMinor: number,
  overrides: HistoryOverrides = {}
): TransactionSourceFactV1[] {
  return Array.from({ length: count }, (_, index) =>
    transaction(
      `${prefix}-${index}`,
      `2026-07-${String(index + 1).padStart(2, '0')}`,
      amountMinor,
      {
        ...overrides,
        merchantName: overrides.uniqueDimensions
          ? `${prefix} merchant ${index}`
          : overrides.merchantName,
        categoryRef: overrides.uniqueDimensions
          ? `${prefix}-category-${index}`
          : overrides.categoryRef,
        accountRef: overrides.uniqueDimensions
          ? `${prefix}-account-${index}`
          : overrides.accountRef,
      }
    )
  );
}

function twoDimensionHistory(): TransactionSourceFactV1[] {
  return [
    ...history('adaptive-history', 5, -5_000, {
      merchantName: 'adaptive merchant',
      categoryRef: 'adaptive-category',
      accountRef: 'other-account',
    }),
    ...history('ordinary-account', 5, -15_000, {
      merchantName: 'ordinary account merchant',
      categoryRef: 'ordinary-account-category',
      accountRef: 'ordinary-account',
    }),
    ...history('ordinary-household', 5, -15_000, {
      uniqueDimensions: true,
    }),
  ];
}

function occurrenceFor(
  result: ReturnType<typeof evaluate>,
  sourceRef: string
) {
  const publication = result.publication.occurrences.find(
    (item) => item.detail.entity.sourceRef === sourceRef
  );
  expect(publication, `missing occurrence for ${sourceRef}`).toBeDefined();
  return publication!.detail;
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function partition<T>(values: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    pages.push(values.slice(index, index + size));
  }
  return pages;
}
