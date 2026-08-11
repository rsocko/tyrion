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

export function classifyTransactionV1(
  fact: TransactionSourceFactV1,
  policy: FinanceInsightPolicySnapshotV1
): TransactionClassificationResultV1 {
  const classification = policy.sourceClassification;
  if (fact.isPending) {
    return result('pending', 'pending_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      classification.transferCategoryRefs,
      classification.transferTagRefs
    )
  ) {
    return result('transfer', 'transfer_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      classification.incomeCategoryRefs,
      classification.incomeTagRefs
    )
  ) {
    return result('income', 'income_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      classification.refundCategoryRefs,
      classification.refundTagRefs
    )
  ) {
    return result('refund', 'refund_excluded', classification.classifierVersion);
  }
  if (
    matchesConfiguredSet(
      fact,
      classification.excludedCategoryRefs,
      classification.excludedTagRefs
    )
  ) {
    return result(
      'policyExcluded',
      'policy_excluded',
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
  if (fact.amountMinor >= 0) {
    return result(
      'unclassifiedCredit',
      'unclassified_credit_excluded',
      classification.classifierVersion
    );
  }
  return result('postedSpend', null, classification.classifierVersion);
}

function matchesConfiguredSet(
  fact: TransactionSourceFactV1,
  categoryRefs: readonly string[],
  tagRefs: readonly string[]
): boolean {
  return (
    (fact.categoryRef !== null && categoryRefs.includes(fact.categoryRef)) ||
    fact.tagRefs.some((tagRef) => tagRefs.includes(tagRef))
  );
}

function result(
  classification: TransactionClassificationV1,
  reasonCode: TransactionClassificationResultV1['reasonCode'],
  classifierVersion: string
): TransactionClassificationResultV1 {
  return { classification, reasonCode, classifierVersion };
}
