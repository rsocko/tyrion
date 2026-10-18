import {
  defaultBillAmountToleranceMinorV1,
  rankBillMatchCandidatesV1,
  type BillMatchTransactionV1,
} from './service-v1.js';
import {
  type BillMatchRequestV2,
  type BillMatchResponseV2,
  type BillMatchSearchContextV2,
  parseBillMatchResponseV2,
} from './contracts-v2.js';

export interface BillMatchTransactionV2 extends BillMatchTransactionV1 {
  payee: string;
  accountDisplayName: string;
  accountLastFour: string | null;
}

export function rankBillMatchCandidatesV2(
  request: BillMatchRequestV2,
  transactions: readonly BillMatchTransactionV2[],
  searchContext: Omit<BillMatchSearchContextV2, 'amountToleranceMinor'>
): BillMatchResponseV2 {
  const anchorDate = request.dueDate ?? request.billDate;
  if (!anchorDate) {
    throw new Error('validated v2 request must have a date anchor');
  }
  const amountToleranceMinor =
    request.amountToleranceMinor ??
    defaultBillAmountToleranceMinorV1(request.expectedAmountMinor);
  const v1Result = rankBillMatchCandidatesV1(
    {
      contractVersion: '1.0',
      billRef: request.billRef,
      amountMinor: request.expectedAmountMinor,
      currency: request.currency,
      dueDate: anchorDate,
      payeeName: request.payee,
      dateWindowDays: request.dateWindowDays,
      amountToleranceMinor,
      candidateLimit: request.candidateLimit,
    },
    transactions
  );
  const transactionsByRef = new Map(
    transactions.map((transaction) => [transaction.transactionRef, transaction])
  );
  const candidates = v1Result.candidates.map((candidate, index) => {
    const transaction = transactionsByRef.get(candidate.transactionRef);
    if (!transaction) {
      throw new Error('ranked transaction detail is unavailable');
    }
    const next = v1Result.candidates[index + 1];
    const receiptAssociation = request.receiptEvidence
      ? {
          status:
            request.receiptEvidence.transactionRef === candidate.transactionRef
              ? ('linked' as const)
              : ('differentTransaction' as const),
          observedAt: request.receiptEvidence.observedAt,
        }
      : undefined;
    return {
      rank: index + 1,
      transactionRef: candidate.transactionRef,
      transactionDate: candidate.transactionDate,
      transactionState: candidate.transactionState,
      payee: transaction.payee,
      amountMinor: Math.abs(transaction.amountMinor),
      currency: request.currency,
      accountDisplayName: transaction.accountDisplayName,
      accountLastFour: transaction.accountLastFour,
      scoreBasisPoints: candidate.scoreBasisPoints,
      confidence: candidate.confidence,
      scoreGapBasisPoints: next
        ? candidate.scoreBasisPoints - next.scoreBasisPoints
        : null,
      signals: candidate.signals,
      ...(receiptAssociation ? { receiptAssociation } : {}),
    };
  });

  return parseBillMatchResponseV2({
    contractVersion: '2.0',
    requestRef: request.requestRef,
    billRef: request.billRef,
    matchStatus: v1Result.matchStatus,
    paymentStatus: v1Result.paymentStatus,
    selectedTransactionRef: v1Result.selectedTransactionRef,
    candidates,
    searchContext: {
      ...searchContext,
      amountToleranceMinor,
    },
  });
}
