import { describe, expect, it } from 'vitest';
import {
  parsePayeePatternProjectionV1,
  projectPayeePatternsV1,
  MAX_PAYEE_PATTERNS_V1,
  type RecurringSourceFactV1,
  type TransactionSourceFactV1,
} from '../src/index.js';

const IDENTITY_NAMESPACE = Buffer.from(
  'invented-payee-pattern-identity-namespace-v1',
  'utf8'
);

function transaction(
  sourceRef: string,
  occurredOn: string,
  merchantName: string,
  amountMinor: number,
  recurringRef: string | null = null
): TransactionSourceFactV1 {
  return {
    sourceRef,
    occurredOn,
    amountMinor,
    merchantName,
    categoryRef: null,
    accountRef: null,
    isPending: false,
    recurringRef,
    tagRefs: [],
  };
}

const TRANSACTIONS: TransactionSourceFactV1[] = [
  transaction('utility-1', '2026-05-01', 'Invented Utility', -10_000, 'utility'),
  transaction('utility-2', '2026-06-01', 'Invented Utility', -10_025, 'utility'),
  transaction('utility-3', '2026-07-01', 'Invented Utility', -9_990, 'utility'),
  transaction('grocer-1', '2026-05-02', 'Invented Grocer', -4_000),
  transaction('grocer-2', '2026-05-09', 'Invented Grocer', -5_000),
  transaction('grocer-3', '2026-05-16', 'Invented Grocer', -3_000),
  transaction('dentist-1', '2026-02-01', 'Invented Dentist', -12_000),
  transaction('dentist-2', '2026-06-15', 'Invented Dentist', -8_000),
  transaction('cafe-1', '2026-07-15', 'Invented Cafe', -900),
  { ...transaction('pending-only', '2026-07-20', 'Pending Merchant', -500), isPending: true },
];

const RECURRING: RecurringSourceFactV1[] = [
  {
    sourceRef: 'utility',
    displayName: 'Invented Utility',
    amountMinor: -10_000,
    cadence: 'monthly',
    nextDate: '2026-08-01',
    categoryRef: null,
    accountRef: null,
    active: true,
  },
];

describe('PayeePatternProjectionV1', () => {
  it('classifies all posted payees with bounded explainable evidence', () => {
    const result = projection('generation-1');

    expect(result).toEqual(parsePayeePatternProjectionV1(result));
    expect(result.payees).toHaveLength(4);
    expect(result.payees.map((payee) => payee.payeeRef)).toEqual(
      [...result.payees.map((payee) => payee.payeeRef)].sort()
    );
    expect(
      result.payees.find((payee) => payee.displayName === 'Invented Utility')
    ).toMatchObject({
      activity: 'active',
      classification: 'recurring-fixed',
      observationCount: 3,
      intervalEvidence: {
        sampleCount: 2,
        medianDays: 31,
        minimumDays: 30,
        maximumDays: 31,
      },
      confidence: 0.95,
      basis: ['monarch_confirmed_recurring', 'bounded_amount_variation'],
      provenance: { transactionHistory: true, monarchRecurring: true },
      monarchConfirmedRecurring: { active: true, cadence: 'monthly' },
    });
    expect(
      result.payees.find((payee) => payee.displayName === 'Invented Grocer')
        ?.classification
    ).toBe('regular');
    expect(
      result.payees.find((payee) => payee.displayName === 'Invented Dentist')
        ?.classification
    ).toBe('infrequent');
    expect(
      result.payees.find((payee) => payee.displayName === 'Invented Cafe')
        ?.classification
    ).toBe('single-observation');
  });

  it('keeps identity stable across generations and contains no transaction or amount data', () => {
    const first = projection('generation-1');
    const second = projection('generation-2');

    expect(first.payees.map((payee) => payee.payeeRef)).toEqual(
      second.payees.map((payee) => payee.payeeRef)
    );
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      'utility-1',
      'amountMinor',
      'sourceRef',
      'recurringRef',
      'categoryRef',
      'accountRef',
      '-10000',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('Pending Merchant');
  });

  it('does not turn recurring financial evidence into document expectation', () => {
    const result = projection('generation-1');

    expect(result).not.toHaveProperty('signals');
    expect(result.payees[0]).not.toHaveProperty('cadence');
    expect(result.payees[0]).not.toHaveProperty('nextExpectedDate');
    expect(JSON.stringify(result)).not.toContain('document');
  });

  it('uses recurring references before display names and does not invent lifecycle state', () => {
    const transactions = [
      transaction('renamed-1', '2026-06-01', 'Renamed Utility', -10_000, 'utility'),
      transaction('renamed-2', '2026-07-01', 'Renamed Utility', -10_000, 'utility'),
      transaction('missing-1', '2026-06-01', 'Missing Stream', -2_000, 'missing'),
      transaction('missing-2', '2026-07-01', 'Missing Stream', -2_000, 'missing'),
    ];
    const result = projectPayeePatternsV1(
      {
        connectorRef: 'invented-connector',
        sourceGeneration: 'generation-recurring-identity',
        sourceAsOf: '2026-07-31T12:00:00Z',
        completeness: 'complete',
        transactions,
        recurring: [{ ...RECURRING[0]!, displayName: 'Old Utility Name', active: false }],
      },
      IDENTITY_NAMESPACE
    );

    expect(
      result.payees.find((payee) => payee.displayName === 'Renamed Utility')
        ?.monarchConfirmedRecurring
    ).toEqual({ active: false, cadence: 'monthly' });
    expect(
      result.payees.find((payee) => payee.displayName === 'Missing Stream')
        ?.monarchConfirmedRecurring
    ).toEqual({ active: null, cadence: 'unknown' });
  });

  it('deterministically bounds high-cardinality projections and marks them partial', () => {
    const transactions = Array.from(
      { length: MAX_PAYEE_PATTERNS_V1 + 1 },
      (_, index) =>
        transaction(
          `transaction-${index}`,
          '2026-07-01',
          `Invented Payee ${index}`,
          -100
        )
    );
    const first = projectPayeePatternsV1(
      {
        connectorRef: 'invented-connector',
        sourceGeneration: 'generation-large',
        sourceAsOf: '2026-07-31T12:00:00Z',
        completeness: 'complete',
        transactions,
        recurring: [],
      },
      IDENTITY_NAMESPACE
    );
    const reversed = projectPayeePatternsV1(
      {
        connectorRef: 'invented-connector',
        sourceGeneration: 'generation-large',
        sourceAsOf: '2026-07-31T12:00:00Z',
        completeness: 'complete',
        transactions: [...transactions].reverse(),
        recurring: [],
      },
      IDENTITY_NAMESPACE
    );

    expect(first.completeness).toBe('partial');
    expect(first.payees).toHaveLength(MAX_PAYEE_PATTERNS_V1);
    expect(reversed).toEqual(first);
  });

  it('rejects malformed provenance and duplicate identities', () => {
    const result = projection('generation-1');
    const recurring = result.payees.find(
      (payee) => payee.monarchConfirmedRecurring !== null
    )!;
    expect(() =>
      parsePayeePatternProjectionV1({
        ...result,
        payees: result.payees.map((payee) =>
          payee === recurring
            ? {
                ...payee,
                provenance: { ...payee.provenance, monarchRecurring: false },
              }
            : payee
        ),
      })
    ).toThrow('must match recurring evidence availability');
    expect(() =>
      parsePayeePatternProjectionV1({
        ...result,
        payees: [result.payees[0], result.payees[0]],
      })
    ).toThrow('ascending deterministic order');
  });
});

function projection(sourceGeneration: string) {
  return projectPayeePatternsV1(
    {
      connectorRef: 'invented-connector',
      sourceGeneration,
      sourceAsOf: '2026-07-31T12:00:00Z',
      completeness: 'complete',
      transactions: TRANSACTIONS,
      recurring: RECURRING,
    },
    IDENTITY_NAMESPACE
  );
}
