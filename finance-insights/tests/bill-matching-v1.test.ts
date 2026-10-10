import { describe, expect, it } from 'vitest';
import {
  parseBillMatchRequestV1,
  parseBillMatchResponseV1,
  rankBillMatchCandidatesV1,
  type BillMatchRequestV1,
  type BillMatchTransactionV1,
} from '../src/reconciliation/index.js';

const request = (): BillMatchRequestV1 =>
  parseBillMatchRequestV1({
    contractVersion: '1.0',
    billRef: 'bill-invented-utility-2026-08',
    amountMinor: 12_345,
    currency: 'USD',
    dueDate: '2026-08-15',
    payeeName: 'Invented Utility Company',
    accountRef: 'account-invented-checking',
    dateWindowDays: 7,
    amountToleranceMinor: 250,
    candidateLimit: 5,
  });

const transaction = (
  overrides: Partial<BillMatchTransactionV1> = {}
): BillMatchTransactionV1 => ({
  transactionRef: 'transaction-invented-a',
  occurredOn: '2026-08-15',
  amountMinor: -12_345,
  merchantName: 'Invented Utility Company',
  accountRef: 'account-invented-checking',
  pending: false,
  ...overrides,
});

describe('bill matching v1', () => {
  it('selects an exact posted transaction as paid with explainable signals', () => {
    const result = rankBillMatchCandidatesV1(request(), [transaction()]);

    expect(result).toEqual({
      contractVersion: '1.0',
      billRef: 'bill-invented-utility-2026-08',
      matchStatus: 'matched',
      paymentStatus: 'paid',
      selectedTransactionRef: 'transaction-invented-a',
      candidates: [
        {
          transactionRef: 'transaction-invented-a',
          transactionDate: '2026-08-15',
          transactionState: 'posted',
          scoreBasisPoints: 10_000,
          confidence: 'high',
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
              strength: 'exact',
              contributionBasisPoints: 500,
            },
          ],
        },
      ],
    });
  });

  it('keeps a decisive pending transaction distinct from paid', () => {
    const result = rankBillMatchCandidatesV1(request(), [
      transaction({ pending: true }),
    ]);

    expect(result.matchStatus).toBe('matched');
    expect(result.paymentStatus).toBe('pending');
    expect(result.candidates[0]?.transactionState).toBe('pending');
  });

  it('reports ambiguity when two qualifying candidates are too close', () => {
    const result = rankBillMatchCandidatesV1(request(), [
      transaction(),
      transaction({
        transactionRef: 'transaction-invented-b',
        occurredOn: '2026-08-16',
      }),
    ]);

    expect(result.matchStatus).toBe('ambiguous');
    expect(result.paymentStatus).toBe('ambiguous');
    expect(result.selectedTransactionRef).toBeNull();
    expect(result.candidates.map((item) => item.transactionRef)).toEqual([
      'transaction-invented-a',
      'transaction-invented-b',
    ]);
  });

  it('does not let a one-candidate response limit suppress ambiguity', () => {
    const result = rankBillMatchCandidatesV1(
      { ...request(), candidateLimit: 1 },
      [
        transaction(),
        transaction({ transactionRef: 'transaction-invented-b' }),
      ]
    );

    expect(result.matchStatus).toBe('ambiguous');
    expect(result.paymentStatus).toBe('ambiguous');
    expect(result.selectedTransactionRef).toBeNull();
    expect(result.candidates).toHaveLength(1);
  });

  it('reports no match while retaining bounded low-confidence context', () => {
    const result = rankBillMatchCandidatesV1(request(), [
      transaction({
        amountMinor: -10_000,
        merchantName: 'Unrelated Merchant',
        occurredOn: '2026-08-01',
        accountRef: 'account-invented-other',
      }),
    ]);

    expect(result.matchStatus).toBe('noMatch');
    expect(result.paymentStatus).toBe('unmatched');
    expect(result.selectedTransactionRef).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });

  it('sorts equal scores by date then stable transaction reference', () => {
    const result = rankBillMatchCandidatesV1(
      { ...request(), candidateLimit: 2 },
      [
        transaction({
          transactionRef: 'transaction-invented-c',
          occurredOn: '2026-08-16',
        }),
        transaction({
          transactionRef: 'transaction-invented-b',
          occurredOn: '2026-08-14',
        }),
        transaction({
          transactionRef: 'transaction-invented-a',
          occurredOn: '2026-08-14',
        }),
      ]
    );

    expect(result.candidates.map((item) => item.transactionRef)).toEqual([
      'transaction-invented-a',
      'transaction-invented-b',
    ]);
  });

  it('defaults bounded lookup controls and rejects unknown or invalid input', () => {
    const parsed = parseBillMatchRequestV1({
      contractVersion: '1.0',
      billRef: 'bill-invented',
      amountMinor: 1,
      currency: 'USD',
      dueDate: '2026-08-15',
      payeeName: 'Invented Payee',
    });
    expect(parsed.dateWindowDays).toBe(7);
    expect(parsed.candidateLimit).toBe(5);

    expect(() =>
      parseBillMatchRequestV1({
        ...parsed,
        householdId: 'caller-controlled-household',
      })
    ).toThrow('Unrecognized key');
    expect(() =>
      parseBillMatchRequestV1({ ...parsed, amountMinor: -1 })
    ).toThrow('expected number to be >0');
    expect(() =>
      parseBillMatchResponseV1({
        contractVersion: '1.0',
        billRef: parsed.billRef,
        matchStatus: 'matched',
        paymentStatus: 'paid',
        selectedTransactionRef: null,
        candidates: [],
      })
    ).toThrow();
  });
});
