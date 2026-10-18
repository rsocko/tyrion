import { describe, expect, it } from 'vitest';
import {
  parseBillMatchRequestV2,
  parseBillMatchResponseV2,
  rankBillMatchCandidatesV2,
  type BillMatchRequestV2,
  type BillMatchTransactionV2,
} from '../src/reconciliation/index.js';

const request = (): BillMatchRequestV2 =>
  parseBillMatchRequestV2({
    contractVersion: '2.0',
    requestRef: 'payment-check-invented-1',
    billRef: 'bill-invented-utility-2026-08',
    payee: 'Invented Utility Company',
    expectedAmountMinor: 12_345,
    currency: 'USD',
    dueDate: '2026-08-15',
    accountScope: 'configuredEligible',
    dateWindowDays: 7,
    amountToleranceMinor: 250,
    candidateLimit: 5,
    receiptEvidence: {
      transactionRef: 'transaction-invented-a',
      observedAt: '2026-08-16T12:00:00.000Z',
    },
  });

const transaction = (
  overrides: Partial<BillMatchTransactionV2> = {}
): BillMatchTransactionV2 => ({
  transactionRef: 'transaction-invented-a',
  occurredOn: '2026-08-15',
  amountMinor: -12_345,
  merchantName: 'Invented Utility Company',
  payee: 'Invented Utility Company',
  accountRef: 'account-invented-checking',
  accountDisplayName: 'Invented Checking',
  accountLastFour: '4321',
  pending: false,
  ...overrides,
});

const searchContext = {
  anchorDate: '2026-08-15',
  windowStart: '2026-08-08',
  windowEnd: '2026-08-22',
  dateWindowDays: 7,
  sourceAsOf: '2026-08-16T12:01:00.000Z',
  searchedAt: '2026-08-16T12:01:01.000Z',
  eligibleAccountCount: 2,
  candidatePoolSize: 1,
} as const;

describe('bill matching v2', () => {
  it('returns actual decision-grade candidate values and search context', () => {
    const result = rankBillMatchCandidatesV2(
      request(),
      [transaction()],
      searchContext
    );

    expect(result).toEqual({
      contractVersion: '2.0',
      requestRef: 'payment-check-invented-1',
      billRef: 'bill-invented-utility-2026-08',
      matchStatus: 'matched',
      paymentStatus: 'paid',
      selectedTransactionRef: 'transaction-invented-a',
      candidates: [
        {
          rank: 1,
          transactionRef: 'transaction-invented-a',
          transactionDate: '2026-08-15',
          transactionState: 'posted',
          payee: 'Invented Utility Company',
          amountMinor: 12_345,
          currency: 'USD',
          accountDisplayName: 'Invented Checking',
          accountLastFour: '4321',
          scoreBasisPoints: 10_000,
          confidence: 'high',
          scoreGapBasisPoints: null,
          signals: [
            {
              kind: 'amount',
              strength: 'exact',
              contributionBasisPoints: 5_500,
            },
            {
              kind: 'date',
              strength: 'exact',
              contributionBasisPoints: 2_500,
            },
            {
              kind: 'payee',
              strength: 'exact',
              contributionBasisPoints: 1_500,
            },
            {
              kind: 'account',
              strength: 'notProvided',
              contributionBasisPoints: 500,
            },
          ],
          receiptAssociation: {
            status: 'linked',
            observedAt: '2026-08-16T12:00:00.000Z',
          },
        },
      ],
      searchContext: {
        ...searchContext,
        amountToleranceMinor: 250,
      },
    });
  });

  it('preserves ambiguity and reports ranking gaps without receipt proof', () => {
    const result = rankBillMatchCandidatesV2(
      { ...request(), receiptEvidence: undefined },
      [
        transaction(),
        transaction({
          transactionRef: 'transaction-invented-b',
          occurredOn: '2026-08-16',
        }),
      ],
      { ...searchContext, candidatePoolSize: 2 }
    );

    expect(result.matchStatus).toBe('ambiguous');
    expect(result.paymentStatus).toBe('ambiguous');
    expect(result.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(result.candidates[0]?.scoreGapBasisPoints).toBe(312);
    expect(result.candidates[1]?.scoreGapBasisPoints).toBeNull();
    expect(result.candidates[0]).not.toHaveProperty('receiptAssociation');
  });

  it('accepts billDate as the fallback anchor and rejects unsafe scope fields', () => {
    const parsed = parseBillMatchRequestV2({
      contractVersion: '2.0',
      requestRef: 'payment-check-invented-2',
      billRef: 'bill-invented',
      payee: 'Invented Payee',
      expectedAmountMinor: 100,
      currency: 'USD',
      billDate: '2026-08-01',
      accountScope: 'configuredEligible',
    });
    expect(parsed.billDate).toBe('2026-08-01');
    expect(parsed.dateWindowDays).toBe(7);

    expect(() =>
      parseBillMatchRequestV2({
        ...parsed,
        householdId: 'caller-controlled-household',
      })
    ).toThrow('Unrecognized key');
    expect(() =>
      parseBillMatchRequestV2({
        ...parsed,
        billDate: undefined,
      })
    ).toThrow('dueDate or billDate is required');
    expect(() =>
      parseBillMatchResponseV2({
        contractVersion: '2.0',
        requestRef: parsed.requestRef,
        billRef: parsed.billRef,
        matchStatus: 'matched',
        paymentStatus: 'paid',
        selectedTransactionRef: null,
        candidates: [],
        searchContext: {
          ...searchContext,
          amountToleranceMinor: 100,
        },
      })
    ).toThrow();
  });

  it('reports an uncapped derived tolerance for large valid amounts', () => {
    const largeRequest = parseBillMatchRequestV2({
      contractVersion: '2.0',
      requestRef: 'payment-check-invented-large',
      billRef: 'bill-invented-large',
      payee: 'Invented Large Payee',
      expectedAmountMinor: 100_000_000,
      currency: 'USD',
      dueDate: '2026-08-15',
      accountScope: 'configuredEligible',
    });
    const result = rankBillMatchCandidatesV2(
      largeRequest,
      [],
      { ...searchContext, candidatePoolSize: 0 }
    );

    expect(result.searchContext.amountToleranceMinor).toBe(2_000_000);
    expect(result.matchStatus).toBe('noMatch');
  });

  it('can decisively match a payment well after the due date', () => {
    const result = rankBillMatchCandidatesV2(
      { ...request(), receiptEvidence: undefined },
      [
        transaction({
          occurredOn: '2026-10-15',
        }),
      ],
      {
        ...searchContext,
        windowEnd: '2026-10-17',
      }
    );

    expect(result.matchStatus).toBe('matched');
    expect(result.paymentStatus).toBe('paid');
    expect(result.candidates[0]?.scoreBasisPoints).toBe(7_500);
    expect(
      result.candidates[0]?.signals.find((signal) => signal.kind === 'date')
    ).toEqual({
      kind: 'date',
      strength: 'none',
      contributionBasisPoints: 0,
    });
  });
});
