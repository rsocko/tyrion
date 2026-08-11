import type { TransactionSourceFactV1 } from '../contracts/source-v1.js';
import type { FinanceInsightPolicySnapshotV1 } from '../policy/v1.js';

export type TransactionClassificationV1 =
  | 'postedSpend'
  | 'pending'
  | 'transfer'
  | 'income'
  | 'refund'
  | 'unclassifiedCredit'
  | 'knownRecurring'
  | 'policyExcluded';

export interface TransactionClassificationResultV1 {
  classification: TransactionClassificationV1;
  reasonCode:
    | 'pending_excluded'
    | 'transfer_excluded'
    | 'income_excluded'
    | 'refund_excluded'
    | 'unclassified_credit_excluded'
    | 'known_recurring_excluded'
    | 'policy_excluded'
    | null;
  classifierVersion: string;
}

const classificationSetCache = new WeakMap<
  FinanceInsightPolicySnapshotV1['sourceClassification'],
  {
    transferCategoryRefs: ReadonlySet<string>;
    transferTagRefs: ReadonlySet<string>;
    incomeCategoryRefs: ReadonlySet<string>;
    incomeTagRefs: ReadonlySet<string>;
    refundCategoryRefs: ReadonlySet<string>;
    refundTagRefs: ReadonlySet<string>;
    excludedCategoryRefs: ReadonlySet<string>;
    excludedTagRefs: ReadonlySet<string>;
  }
>();

export function classifyTransactionV1(
  fact: TransactionSourceFactV1,
  policy: FinanceInsightPolicySnapshotV1
): TransactionClassificationResultV1 {
  const classification = policy.sourceClassification;
  const sets = classificationSets(classification);
  if (fact.isPending) {
    return result('pending', 'pending_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      sets.transferCategoryRefs,
      sets.transferTagRefs
    )
  ) {
    return result('transfer', 'transfer_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      sets.incomeCategoryRefs,
      sets.incomeTagRefs
    )
  ) {
    return result('income', 'income_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      sets.refundCategoryRefs,
      sets.refundTagRefs
    )
  ) {
    return result('refund', 'refund_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      sets.excludedCategoryRefs,
      sets.excludedTagRefs
    )
  ) {
    return result(
      'policyExcluded',
      'policy_excluded',
      classification.classifierVersion
    );
  }
  if (fact.amountMinor >= 0) {
    return result(
      'unclassifiedCredit',
      'unclassified_credit_excluded',
      classification.classifierVersion
    );
  }
  if (fact.recurringRef !== null) {
    return result(
      'knownRecurring',
      'known_recurring_excluded',
      classification.classifierVersion
    );
  }
  return result('postedSpend', null, classification.classifierVersion);
}

function matchesConfiguredSet(
  fact: TransactionSourceFactV1,
  categoryRefs: ReadonlySet<string>,
  tagRefs: ReadonlySet<string>
): boolean {
  return (
    (fact.categoryRef !== null && categoryRefs.has(fact.categoryRef)) ||
    fact.tagRefs.some((tagRef) => tagRefs.has(tagRef))
  );
}

function classificationSets(
  classification: FinanceInsightPolicySnapshotV1['sourceClassification']
) {
  const cached = classificationSetCache.get(classification);
  if (cached) return cached;
  const sets = {
    transferCategoryRefs: new Set(classification.transferCategoryRefs),
    transferTagRefs: new Set(classification.transferTagRefs),
    incomeCategoryRefs: new Set(classification.incomeCategoryRefs),
    incomeTagRefs: new Set(classification.incomeTagRefs),
    refundCategoryRefs: new Set(classification.refundCategoryRefs),
    refundTagRefs: new Set(classification.refundTagRefs),
    excludedCategoryRefs: new Set(classification.excludedCategoryRefs),
    excludedTagRefs: new Set(classification.excludedTagRefs),
  };
  classificationSetCache.set(classification, sets);
  return sets;
}

function result(
  classification: TransactionClassificationV1,
  reasonCode: TransactionClassificationResultV1['reasonCode'],
  classifierVersion: string
): TransactionClassificationResultV1 {
  return { classification, reasonCode, classifierVersion };
}
