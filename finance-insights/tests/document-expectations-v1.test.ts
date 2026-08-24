import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_EXPECTATION_SIGNALS_V1,
  parseDocumentExpectationSignalsV1,
  projectDocumentExpectationSignalsV1,
  type AccountSourceFactV1,
  type RecurringSourceFactV1,
} from '../src/index.js';

const IDENTITY_KEY = Buffer.from(
  'invented-document-expectation-identity-key-v1',
  'utf8'
);
const ACCOUNTS: AccountSourceFactV1[] = [
  {
    sourceRef: 'same-bank-card-a',
    displayName: 'Invented Rewards Card',
    institutionName: 'Invented Bank',
    accountType: 'credit',
    accountLastFour: '1234',
    active: true,
  },
  {
    sourceRef: 'same-bank-card-b',
    displayName: 'Invented Travel Card',
    institutionName: 'Invented Bank',
    accountType: 'credit',
    active: true,
  },
  {
    sourceRef: 'closed-loan',
    displayName: 'Invented Auto Loan',
    accountType: 'loan',
    active: false,
  },
  {
    sourceRef: 'wallet-cash',
    accountType: 'cash',
    active: true,
  },
];
const RECURRING: RecurringSourceFactV1[] = [
  {
    sourceRef: 'utility-obligation',
    displayName: 'Invented Utility',
    amountMinor: -12_345,
    cadence: 'monthly',
    nextDate: '2026-09-01',
    categoryRef: 'utilities',
    accountRef: 'same-bank-card-a',
    active: true,
  },
  {
    sourceRef: 'closed-membership',
    displayName: 'Invented Membership',
    amountMinor: -2_500,
    cadence: 'monthly',
    nextDate: null,
    categoryRef: null,
    accountRef: null,
    active: false,
  },
  {
    sourceRef: 'amount-unavailable-obligation',
    displayName: 'Invented Archived Utility',
    amountMinor: null,
    cadence: 'unknown',
    nextDate: null,
    categoryRef: null,
    accountRef: null,
    active: false,
  },
  {
    sourceRef: 'payroll-income',
    displayName: 'Invented Payroll',
    amountMinor: 500_000,
    cadence: 'biweekly',
    nextDate: '2026-09-04',
    categoryRef: 'income',
    accountRef: 'same-bank-card-a',
    active: true,
  },
];

describe('DocumentExpectationSignalsV1', () => {
  it('projects bounded safe signals without claiming documents or cadence', () => {
    const result = projection('generation-1');

    expect(result).toEqual(parseDocumentExpectationSignalsV1(result));
    expect(result.contractVersion).toBe('1');
    expect(result.completeness).toBe('complete');
    expect(result.signals).toHaveLength(6);
    expect(result.signals.map((signal) => signal.seriesRef)).toEqual(
      [...result.signals.map((signal) => signal.seriesRef)].sort()
    );
    expect(new Set(result.signals.map((signal) => signal.seriesRef)).size).toBe(6);
    expect(
      result.signals.every(
        (signal) =>
          signal.cadence === null &&
          signal.nextExpectedDate === null &&
          /^expectation-v1_[A-Za-z0-9_-]{43}$/.test(signal.seriesRef)
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('same-bank-card');
    expect(JSON.stringify(result)).not.toContain('currentBalance');
    expect(JSON.stringify(result)).not.toContain('amountMinor');
    expect(JSON.stringify(result)).not.toContain('nextDate');
    expect(JSON.stringify(result)).not.toContain('wallet-cash');
    expect(JSON.stringify(result)).not.toContain('payroll-income');
    expect(JSON.stringify(result)).not.toContain('Invented Payroll');
    expect(JSON.stringify(result)).not.toContain('Invented Utility');
    expect(JSON.stringify(result)).not.toContain('Invented Membership');
  });

  it('keeps same-institution accounts distinct without treating them as document evidence', () => {
    const accounts = projection('generation-1').signals.filter(
      (signal) => signal.kind === 'accountStatementCandidate'
    );

    expect(accounts).toHaveLength(3);
    expect(new Set(accounts.map((signal) => signal.seriesRef)).size).toBe(3);
    expect(
      accounts
        .filter((signal) => signal.active)
        .every(
          (signal) =>
            signal.confidence === 0.6 &&
            signal.basis[0] === 'active_non_cash_account' &&
            signal.accountType === 'credit' &&
            signal.institutionName === 'Invented Bank'
        )
    ).toBe(true);
    expect(
      accounts.find((signal) => signal.accountName === 'Invented Rewards Card')
    ).toMatchObject({
      displayHint: 'Invented Rewards Card',
      accountLastFour: '1234',
    });
    expect(accounts.find((signal) => !signal.active)?.basis).toEqual([
      'inactive_non_cash_account',
    ]);
  });

  it('represents recurring deactivation without turning income into a bill', () => {
    const recurring = projection('generation-1').signals.filter(
      (signal) => signal.kind === 'recurringDocumentCandidate'
    );

    expect(recurring).toHaveLength(3);
    expect(recurring.find((signal) => signal.active)).toMatchObject({
      displayHint: 'Recurring expense',
      confidence: 0.6,
      basis: ['active_recurring_obligation'],
    });
    expect(recurring.filter((signal) => !signal.active)).toHaveLength(2);
    expect(recurring.find((signal) => !signal.active)).toMatchObject({
      displayHint: 'Recurring expense',
      confidence: 0.6,
      basis: ['inactive_recurring_obligation'],
    });
    expect(
      recurring.filter((signal) => !signal.active)
    ).toMatchObject({
      length: 2,
    });
    expect(
      recurring.every(
        (signal) =>
          !('accountName' in signal) &&
          !('institutionName' in signal) &&
          !('accountType' in signal) &&
          !('accountLastFour' in signal)
      )
    ).toBe(true);
  });

  it('keeps series identities stable across generations and scoped by connector', () => {
    const first = projection('generation-1');
    const second = projection('generation-2');
    const otherConnector = projectDocumentExpectationSignalsV1(
      {
        ...projectionInput('generation-2'),
        connectorRef: 'other-connector',
      },
      IDENTITY_KEY
    );

    expect(first.signals.map((signal) => signal.seriesRef)).toEqual(
      second.signals.map((signal) => signal.seriesRef)
    );
    expect(first.signals.map((signal) => signal.seriesRef)).not.toEqual(
      otherConnector.signals.map((signal) => signal.seriesRef)
    );

    const renamed = projectDocumentExpectationSignalsV1(
      {
        ...projectionInput('generation-2'),
        recurring: RECURRING.map((recurring) => ({
          ...recurring,
          displayName: `Renamed ${recurring.displayName}`,
        })),
      },
      IDENTITY_KEY
    );
    expect(renamed.signals).toEqual(second.signals);

    const renamedAccount = projectDocumentExpectationSignalsV1(
      {
        ...projectionInput('generation-2'),
        accounts: ACCOUNTS.map((account) => ({
          ...account,
          displayName: account.displayName
            ? `Renamed ${account.displayName}`
            : undefined,
        })),
      },
      IDENTITY_KEY
    );
    expect(renamedAccount.signals.map((signal) => signal.seriesRef)).toEqual(
      second.signals.map((signal) => signal.seriesRef)
    );
    expect(renamedAccount.signals).not.toEqual(second.signals);
  });

  it('accepts additive evidence reasons and rejects invalid response structure', () => {
    const response = projection('generation-1');
    expect(
      parseDocumentExpectationSignalsV1({
        ...response,
        signals: response.signals.map((signal, index) =>
          index === 0
            ? { ...signal, basis: [...signal.basis, 'future_advisory_reason'] }
            : signal
        ),
      }).signals[0]?.basis
    ).toEqual([
      response.signals[0]?.basis[0],
      'future_advisory_reason',
    ]);
    expect(() =>
      parseDocumentExpectationSignalsV1({
        ...response,
        rawAccountId: 'not-allowed',
      })
    ).toThrow('Unrecognized key');
    expect(() =>
      parseDocumentExpectationSignalsV1({
        ...response,
        signals: [response.signals[0], response.signals[0]],
      })
    ).toThrow('must be unique');
    expect(() =>
      parseDocumentExpectationSignalsV1({
        ...response,
        signals: Array.from(
          { length: MAX_DOCUMENT_EXPECTATION_SIGNALS_V1 + 1 },
          () => response.signals[0]
        ),
      })
    ).toThrow('Too big');
    expect(() =>
      parseDocumentExpectationSignalsV1({
        ...response,
        signals: response.signals.map((signal, index) =>
          index === 0
            ? { ...signal, basis: [...signal.basis, signal.basis[0]] }
            : signal
        ),
      })
    ).toThrow('must contain unique reason codes');
    const recurring = response.signals.find(
      (signal) => signal.kind === 'recurringDocumentCandidate'
    );
    expect(() =>
      parseDocumentExpectationSignalsV1({
        ...response,
        signals: response.signals.map((signal) =>
          signal === recurring ? { ...signal, accountName: 'Not allowed' } : signal
        ),
      })
    ).toThrow('Unrecognized key');
    const account = response.signals.find(
      (signal) => signal.kind === 'accountStatementCandidate'
    );
    expect(() =>
      parseDocumentExpectationSignalsV1({
        ...response,
        signals: response.signals.map((signal) =>
          signal === account ? { ...signal, accountLastFour: '12345' } : signal
        ),
      })
    ).toThrow('Too big');
  });
});

function projection(sourceGeneration: string) {
  return projectDocumentExpectationSignalsV1(
    projectionInput(sourceGeneration),
    IDENTITY_KEY
  );
}

function projectionInput(sourceGeneration: string) {
  return {
    connectorRef: 'service-connector',
    sourceGeneration,
    sourceAsOf: '2026-08-23T12:00:00Z',
    completeness: 'complete' as const,
    accounts: ACCOUNTS,
    recurring: RECURRING,
    knownOutgoingRecurringRefs: ['amount-unavailable-obligation'],
  };
}
