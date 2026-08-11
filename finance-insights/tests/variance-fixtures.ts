import {
  classifyTransactionV1,
  createCandidatePolicySnapshotV1,
  deriveMerchantKeyV1,
  evaluateVarianceProjectionV1,
  parseFinanceInsightPolicySnapshotV1,
  type FinanceInsightPolicySnapshotV1,
  type SourceProjectionV1,
  type TransactionSourceFactV1,
  type VarianceEvaluationInputV1,
} from '../src/index.js';

export const VARIANCE_IDENTITY_KEY = Buffer.alloc(32, 24);

export function variancePolicy(
  overrides: Partial<FinanceInsightPolicySnapshotV1['variance']> = {},
  classification: Partial<
    FinanceInsightPolicySnapshotV1['sourceClassification']
  > = {}
): FinanceInsightPolicySnapshotV1 {
  const base = createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: '2026-01-01T00:00:00Z',
    currency: 'USD',
    timezone: 'America/New_York',
  });
  return parseFinanceInsightPolicySnapshotV1({
    ...base,
    featureGates: {
      ...base.featureGates,
      varianceAnalysis: true,
      monthlyMoverDigestNotifications: true,
      confirmedActions: true,
    },
    sourceClassification: {
      ...base.sourceClassification,
      ...classification,
    },
    variance: {
      ...base.variance,
      ...overrides,
    },
  });
}

export function transaction(
  sourceRef: string,
  occurredOn: string,
  amountMinor: number,
  options: Partial<TransactionSourceFactV1> = {}
): TransactionSourceFactV1 {
  return {
    sourceRef,
    occurredOn,
    amountMinor,
    merchantName: 'Invented Market',
    categoryRef: 'demo-category-main',
    accountRef: 'demo-account-main',
    isPending: false,
    recurringRef: null,
    tagRefs: [],
    ...options,
  };
}

export function projection(
  transactions: readonly TransactionSourceFactV1[],
  categoryRefs: readonly string[] = inferredCategoryRefs(transactions)
): SourceProjectionV1 {
  return {
    transactions,
    recurring: [],
    categories: categoryRefs.map((sourceRef) => ({
      sourceRef,
      displayName: displayNameForCategory(sourceRef),
      groupRef: 'demo-category-group',
      active: true,
    })),
    accounts: [
      {
        sourceRef: 'demo-account-main',
        accountType: 'checking',
        active: true,
      },
    ],
    tags: [
      { sourceRef: 'demo-tag-transfer', displayName: 'Transfer', active: true },
      { sourceRef: 'demo-tag-refund', displayName: 'Refund', active: true },
      { sourceRef: 'demo-tag-income', displayName: 'Income', active: true },
    ],
  };
}

export function varianceInput(
  transactions: readonly TransactionSourceFactV1[],
  options: {
    policy?: FinanceInsightPolicySnapshotV1;
    projection?: SourceProjectionV1;
    completedAt?: string;
    sourceAsOf?: string;
    coverageStart?: string;
    coverageEnd?: string;
    completeness?: 'complete' | 'partial' | 'unavailable';
    observationMonth?: string;
    classificationLineageOverrides?: Readonly<Record<string, string>>;
    previousOccurrences?: VarianceEvaluationInputV1['previousOccurrences'];
    previousDigest?: VarianceEvaluationInputV1['previousDigest'];
    merchantAlias?: boolean;
  } = {}
): VarianceEvaluationInputV1 {
  const policy = options.policy ?? variancePolicy();
  const sourceProjection = options.projection ?? projection(transactions);
  const completedAt = options.completedAt ?? '2026-08-11T14:00:00Z';
  const alias = options.merchantAlias
    ? [
        {
          normalizedMerchantKey: deriveMerchantKeyV1(
            VARIANCE_IDENTITY_KEY,
            'invented market'
          ),
          canonicalMerchantKey: deriveMerchantKeyV1(
            VARIANCE_IDENTITY_KEY,
            'invented market canonical'
          ),
          displayName: 'Invented Market',
          aliasVersion: 'merchant-alias-v1',
        },
      ]
    : [];
  const classificationLineages = [
    ...sourceProjection.categories.map((category) => ({
      entityKind: 'category' as const,
      entitySourceRef: category.sourceRef,
      lineage:
        options.classificationLineageOverrides?.[
          `category:${category.sourceRef}`
        ] ?? 'classification-lineage-v1',
    })),
    ...new Map(
      sourceProjection.transactions.map((fact) => {
        const normalizedMerchantKey = deriveMerchantKeyV1(
          VARIANCE_IDENTITY_KEY,
          fact.merchantName
        );
        const merchantAlias = alias.find(
          (item) => item.normalizedMerchantKey === normalizedMerchantKey
        );
        const entitySourceRef =
          merchantAlias?.canonicalMerchantKey ?? normalizedMerchantKey;
        return [
          entitySourceRef,
          {
            entityKind: 'merchant' as const,
            entitySourceRef,
            lineage:
              options.classificationLineageOverrides?.[
                `merchant:${entitySourceRef}`
              ] ?? 'classification-lineage-v1',
          },
        ];
      })
    ).values(),
  ];
  return {
    identityKey: VARIANCE_IDENTITY_KEY,
    householdScope: 'demo-household-v1',
    projection: sourceProjection,
    classifications: sourceProjection.transactions.map((fact) => ({
      sourceRef: fact.sourceRef,
      policyVersion: policy.policyVersion,
      ...classifyTransactionV1(fact, policy),
    })),
    classificationLineages,
    policy,
    source: {
      connectorRef: 'demo-connector-v1',
      sourceGeneration: 'demo-generation-v1',
      sourceAsOf: options.sourceAsOf ?? '2026-08-11T13:30:00Z',
      coverageStart: options.coverageStart ?? '2026-02-01',
      coverageEnd: options.coverageEnd ?? '2026-08-10',
      bridgeContractVersion: 'bridge-v1',
      completeness: options.completeness ?? 'complete',
    },
    evaluationStartedAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
    evaluationCompletedAt: completedAt,
    observationMonth: options.observationMonth,
    merchantAliases: alias,
    previousOccurrences: options.previousOccurrences ?? [],
    previousDigest: options.previousDigest ?? null,
  };
}

export function sixMonthSeries(
  baselineTotals: readonly number[],
  currentTotal: number,
  options: {
    categoryRef?: string;
    merchantName?: string;
    currentContributors?: number;
  } = {}
): TransactionSourceFactV1[] {
  if (baselineTotals.length !== 6) {
    throw new RangeError('sixMonthSeries requires six baseline totals');
  }
  const categoryRef = options.categoryRef ?? 'demo-category-main';
  const merchantName = options.merchantName ?? 'Invented Market';
  const months = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
  const result = baselineTotals
    .map((total, index) =>
      total === 0
        ? null
        : transaction(`demo-baseline-${categoryRef}-${index}`, `${months[index]}-05`, -total, {
            categoryRef,
            merchantName,
          })
    )
    .filter((item): item is TransactionSourceFactV1 => item !== null);
  const contributors = options.currentContributors ?? (currentTotal === 0 ? 0 : 1);
  for (let index = 0; index < contributors; index += 1) {
    const share =
      Math.floor(currentTotal / contributors) +
      (index < currentTotal % contributors ? 1 : 0);
    result.push(
      transaction(
        `demo-current-${categoryRef}-${index}`,
        `2026-08-${String(Math.min(10, index + 1)).padStart(2, '0')}`,
        -share,
        { categoryRef, merchantName }
      )
    );
  }
  return result;
}

export function categoryResult(
  input: VarianceEvaluationInputV1,
  categoryRef = 'demo-category-main'
) {
  return evaluateVarianceProjectionV1(input).series.find(
    (detail) =>
      detail.kind === 'categoryVariance' &&
      detail.entity.sourceRef === categoryRef
  );
}

function inferredCategoryRefs(
  transactions: readonly TransactionSourceFactV1[]
): string[] {
  return [
    ...new Set(
      transactions
        .map((item) => item.categoryRef)
        .filter((value): value is string => value !== null)
    ),
  ].sort();
}

function displayNameForCategory(sourceRef: string): string {
  return sourceRef
    .replace(/^demo-category-/, '')
    .split('-')
    .map((value) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`)
    .join(' ');
}
