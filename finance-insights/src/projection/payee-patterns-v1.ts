import { createHash } from 'node:crypto';
import {
  MAX_PAYEE_PATTERNS_V1,
  PAYEE_PATTERN_CONTRACT_VERSION_V1,
  parsePayeePatternProjectionV1,
  type PayeeFinancialClassificationV1,
  type PayeePatternProjectionV1,
  type PayeePatternV1,
  type RecurringSourceFactV1,
  type TransactionSourceFactV1,
} from '../contracts/v1.js';
import { canonicalizeV1 } from '../core/canonical.js';

export interface PayeePatternProjectionInputV1 {
  connectorRef: string;
  sourceGeneration: string;
  sourceAsOf: string;
  completeness: 'complete' | 'partial';
  transactions: readonly TransactionSourceFactV1[];
  recurring: readonly RecurringSourceFactV1[];
}

interface PayeeEvidence {
  displayName: string;
  transactions: TransactionSourceFactV1[];
}

export function projectPayeePatternsV1(
  input: PayeePatternProjectionInputV1,
  identityNamespace: Uint8Array
): PayeePatternProjectionV1 {
  if (identityNamespace.byteLength < 16) {
    throw new RangeError('Identity namespaces must contain at least 16 bytes');
  }

  const recurringByName = new Map(
    [...input.recurring]
      .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))
      .map((item) => [canonicalPayeeName(item.displayName), item])
  );
  const recurringByRef = new Map(
    input.recurring.map((item) => [item.sourceRef, item])
  );
  const evidence = new Map<string, PayeeEvidence>();
  for (const transaction of input.transactions) {
    if (transaction.isPending) continue;
    const key = canonicalPayeeName(transaction.merchantName);
    const current = evidence.get(key);
    if (current) {
      current.transactions.push(transaction);
      if (transaction.merchantName < current.displayName) {
        current.displayName = transaction.merchantName;
      }
    } else {
      evidence.set(key, {
        displayName: transaction.merchantName,
        transactions: [transaction],
      });
    }
  }

  const sourceAsOfDate = input.sourceAsOf.slice(0, 10);
  const allPayees = [...evidence.entries()]
    .map(([key, value]) =>
      projectPayee(
        input.connectorRef,
        key,
        value,
        resolveRecurringEvidence(
          value.transactions,
          recurringByRef,
          recurringByName.get(key) ?? null
        ),
        sourceAsOfDate,
        identityNamespace
      )
    )
    .sort((left, right) =>
      left.payeeRef < right.payeeRef ? -1 : left.payeeRef > right.payeeRef ? 1 : 0
    );
  const payees = allPayees.slice(0, MAX_PAYEE_PATTERNS_V1);

  return parsePayeePatternProjectionV1({
    contractVersion: PAYEE_PATTERN_CONTRACT_VERSION_V1,
    connectorRef: input.connectorRef,
    sourceGeneration: input.sourceGeneration,
    sourceAsOf: input.sourceAsOf,
    completeness:
      input.completeness === 'partial' ||
      allPayees.length > MAX_PAYEE_PATTERNS_V1
        ? 'partial'
        : 'complete',
    payees,
  });
}

function projectPayee(
  connectorRef: string,
  canonicalName: string,
  evidence: PayeeEvidence,
  recurring: RecurringEvidence | null,
  sourceAsOfDate: string,
  identityNamespace: Uint8Array
): PayeePatternV1 {
  const transactions = evidence.transactions.sort((left, right) =>
    left.occurredOn.localeCompare(right.occurredOn)
  );
  const uniqueDates = [...new Set(transactions.map((item) => item.occurredOn))];
  const intervals = uniqueDates
    .slice(1)
    .map((date, index) => daysBetween(uniqueDates[index]!, date))
    .filter((days) => days > 0);
  const intervalEvidence =
    intervals.length === 0
      ? null
      : {
          sampleCount: intervals.length,
          medianDays: medianInteger(intervals),
          minimumDays: Math.min(...intervals),
          maximumDays: Math.max(...intervals),
        };
  const recurringEvidence = recurring;
  const amountMagnitudes = transactions.map((item) => Math.abs(item.amountMinor));
  const fixedAmounts =
    amountMagnitudes.length > 1 &&
    Math.max(...amountMagnitudes) - Math.min(...amountMagnitudes) <=
      Math.max(100, Math.round(medianInteger(amountMagnitudes) * 0.05));
  const classification = classify(
    transactions.length,
    intervalEvidence,
    recurringEvidence !== null,
    fixedAmounts
  );
  const inactiveThreshold = intervalEvidence
    ? Math.max(90, intervalEvidence.medianDays * 2)
    : 90;
  const ageDays = daysBetween(uniqueDates.at(-1)!, sourceAsOfDate);
  const activity =
    ageDays < 0 ? 'unknown' : ageDays <= inactiveThreshold ? 'active' : 'inactive';
  const basis = classificationBasis(
    classification,
    recurringEvidence !== null,
    fixedAmounts
  );

  return {
    payeeRef: derivePayeeRef(
      identityNamespace,
      connectorRef,
      canonicalName
    ),
    displayName: evidence.displayName,
    activity,
    classification,
    observationCount: transactions.length,
    observationWindow: {
      firstObservedOn: uniqueDates[0]!,
      lastObservedOn: uniqueDates.at(-1)!,
    },
    intervalEvidence,
    confidence: confidence(classification, transactions.length, recurringEvidence !== null),
    basis,
    provenance: {
      transactionHistory: true,
      monarchRecurring: recurringEvidence !== null,
    },
    monarchConfirmedRecurring: recurringEvidence
      ? {
          active: recurringEvidence.active,
          cadence: recurringEvidence.cadence,
        }
      : null,
  };
}

type RecurringEvidence = {
  active: boolean | null;
  cadence: RecurringSourceFactV1['cadence'];
};

function resolveRecurringEvidence(
  transactions: readonly TransactionSourceFactV1[],
  recurringByRef: ReadonlyMap<string, RecurringSourceFactV1>,
  nameMatch: RecurringSourceFactV1 | null
): RecurringEvidence | null {
  const recurringRefs = [
    ...new Set(
      transactions
        .map((transaction) => transaction.recurringRef)
        .filter((reference): reference is string => reference !== null)
    ),
  ].sort();
  for (const recurringRef of recurringRefs) {
    const exact = recurringByRef.get(recurringRef);
    if (exact) return exact;
  }
  if (nameMatch) return nameMatch;
  return recurringRefs.length > 0
    ? { active: null, cadence: 'unknown' }
    : null;
}

function classify(
  count: number,
  interval: PayeePatternV1['intervalEvidence'],
  monarchRecurring: boolean,
  fixedAmounts: boolean
): PayeeFinancialClassificationV1 {
  if (monarchRecurring) {
    return fixedAmounts ? 'recurring-fixed' : 'recurring-variable';
  }
  if (count === 1) return 'single-observation';
  if (!interval) return 'unknown';
  const spread = interval.maximumDays - interval.minimumDays;
  if (
    count >= 3 &&
    spread <= Math.max(7, Math.round(interval.medianDays * 0.35))
  ) {
    return 'regular';
  }
  if (interval.medianDays >= 60) return 'infrequent';
  return 'unknown';
}

function classificationBasis(
  classification: PayeeFinancialClassificationV1,
  monarchRecurring: boolean,
  fixedAmounts: boolean
): string[] {
  if (monarchRecurring) {
    return [
      'monarch_confirmed_recurring',
      fixedAmounts ? 'bounded_amount_variation' : 'variable_amount_history',
    ];
  }
  const basis: Record<PayeeFinancialClassificationV1, string> = {
    'recurring-fixed': 'monarch_confirmed_recurring',
    'recurring-variable': 'monarch_confirmed_recurring',
    regular: 'consistent_observation_intervals',
    infrequent: 'long_observation_intervals',
    'single-observation': 'single_historical_observation',
    unknown: 'insufficient_pattern_evidence',
  };
  return [basis[classification]];
}

function confidence(
  classification: PayeeFinancialClassificationV1,
  count: number,
  monarchRecurring: boolean
): number {
  if (monarchRecurring) return 0.95;
  if (classification === 'regular') return Math.min(0.9, 0.6 + count * 0.05);
  if (classification === 'infrequent') return Math.min(0.75, 0.45 + count * 0.05);
  if (classification === 'single-observation') return 0.35;
  return Math.min(0.5, 0.25 + count * 0.05);
}

function canonicalPayeeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function derivePayeeRef(
  identityNamespace: Uint8Array,
  connectorRef: string,
  canonicalName: string
): string {
  const digest = createHash('sha256')
    .update(identityNamespace)
    .update('\0')
    .update(
      canonicalizeV1([
        'mission-control-owl',
        'payee-patterns',
        'v1',
        connectorRef,
        canonicalName,
      ])
    )
    .digest('base64url');
  return `payee-v1_${digest}`;
}

function daysBetween(left: string, right: string): number {
  return Math.round(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) /
      86_400_000
  );
}

function medianInteger(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
