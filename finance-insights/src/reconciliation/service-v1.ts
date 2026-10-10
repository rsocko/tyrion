import {
  type BillMatchCandidateV1,
  type BillMatchRequestV1,
  type BillMatchResponseV1,
  type BillMatchSignalV1,
  parseBillMatchResponseV1,
} from './contracts-v1.js';

export interface BillMatchTransactionV1 {
  transactionRef: string;
  occurredOn: string;
  amountMinor: number;
  merchantName: string;
  accountRef: string;
  pending: boolean;
}

export const BILL_MATCH_MINIMUM_SCORE_BASIS_POINTS_V1 = 7_000;
export const BILL_MATCH_AMBIGUITY_GAP_BASIS_POINTS_V1 = 500;

export function defaultBillAmountToleranceMinorV1(amountMinor: number): number {
  return Math.max(100, Math.round(amountMinor * 0.02));
}

export function rankBillMatchCandidatesV1(
  request: BillMatchRequestV1,
  transactions: readonly BillMatchTransactionV1[]
): BillMatchResponseV1 {
  const amountTolerance =
    request.amountToleranceMinor ??
    defaultBillAmountToleranceMinorV1(request.amountMinor);
  const rankedCandidates = transactions
    .map((transaction) => scoreCandidate(request, transaction, amountTolerance))
    .filter((candidate) => candidate.scoreBasisPoints > 0)
    .sort(compareCandidates);
  const candidates = rankedCandidates.slice(0, request.candidateLimit);
  const first = rankedCandidates[0];
  const second = rankedCandidates[1];

  if (
    !first ||
    first.scoreBasisPoints < BILL_MATCH_MINIMUM_SCORE_BASIS_POINTS_V1
  ) {
    return response(request, 'noMatch', 'unmatched', null, candidates);
  }
  if (
    second &&
    second.scoreBasisPoints >= BILL_MATCH_MINIMUM_SCORE_BASIS_POINTS_V1 &&
    first.scoreBasisPoints - second.scoreBasisPoints <
      BILL_MATCH_AMBIGUITY_GAP_BASIS_POINTS_V1
  ) {
    return response(request, 'ambiguous', 'ambiguous', null, candidates);
  }
  return response(
    request,
    'matched',
    first.transactionState === 'pending' ? 'pending' : 'paid',
    first.transactionRef,
    candidates
  );
}

function scoreCandidate(
  request: BillMatchRequestV1,
  transaction: BillMatchTransactionV1,
  amountTolerance: number
): BillMatchCandidateV1 {
  const amountDelta = Math.abs(
    Math.abs(transaction.amountMinor) - request.amountMinor
  );
  const amountContribution =
    amountDelta === 0
      ? 5_500
      : amountTolerance > 0 && amountDelta <= amountTolerance
        ? Math.max(
            1,
            Math.round(5_500 * (1 - amountDelta / (amountTolerance + 1)))
          )
        : 0;
  const dateDelta = calendarDayDelta(request.dueDate, transaction.occurredOn);
  const dateContribution =
    dateDelta === 0
      ? 2_500
      : request.dateWindowDays > 0 && dateDelta <= request.dateWindowDays
        ? Math.max(
            1,
            Math.round(
              2_500 * (1 - dateDelta / (request.dateWindowDays + 1))
            )
          )
        : 0;
  const payeeSimilarity = tokenSimilarity(
    request.payeeName,
    transaction.merchantName
  );
  const payeeContribution = Math.round(1_500 * payeeSimilarity);
  const accountContribution =
    request.accountRef === undefined
      ? 500
      : request.accountRef === transaction.accountRef
        ? 500
        : 0;
  const scoreBasisPoints =
    amountContribution +
    dateContribution +
    payeeContribution +
    accountContribution;

  return {
    transactionRef: transaction.transactionRef,
    transactionDate: transaction.occurredOn,
    transactionState: transaction.pending ? 'pending' : 'posted',
    scoreBasisPoints,
    confidence:
      scoreBasisPoints >= 9_000
        ? 'high'
        : scoreBasisPoints >= BILL_MATCH_MINIMUM_SCORE_BASIS_POINTS_V1
          ? 'medium'
          : 'low',
    signals: [
      signal('amount', amountContribution, 5_500, amountDelta === 0),
      signal('date', dateContribution, 2_500, dateDelta === 0),
      signal('payee', payeeContribution, 1_500, payeeSimilarity === 1),
      request.accountRef === undefined
        ? {
            kind: 'account',
            strength: 'notProvided',
            contributionBasisPoints: accountContribution,
          }
        : signal(
            'account',
            accountContribution,
            500,
            request.accountRef === transaction.accountRef
          ),
    ],
  };
}

function response(
  request: BillMatchRequestV1,
  matchStatus: BillMatchResponseV1['matchStatus'],
  paymentStatus: BillMatchResponseV1['paymentStatus'],
  selectedTransactionRef: string | null,
  candidates: readonly BillMatchCandidateV1[]
): BillMatchResponseV1 {
  return parseBillMatchResponseV1({
    contractVersion: request.contractVersion,
    billRef: request.billRef,
    matchStatus,
    paymentStatus,
    selectedTransactionRef,
    candidates,
  });
}

function signal(
  kind: BillMatchSignalV1['kind'],
  contributionBasisPoints: number,
  maximum: number,
  exact: boolean
): BillMatchSignalV1 {
  return {
    kind,
    strength: exact
      ? 'exact'
      : contributionBasisPoints === 0
        ? 'none'
        : contributionBasisPoints >= maximum * 0.7
          ? 'strong'
          : 'partial',
    contributionBasisPoints,
  };
}

function compareCandidates(
  left: BillMatchCandidateV1,
  right: BillMatchCandidateV1
): number {
  return (
    right.scoreBasisPoints - left.scoreBasisPoints ||
    left.transactionDate.localeCompare(right.transactionDate) ||
    left.transactionRef.localeCompare(right.transactionRef)
  );
}

function calendarDayDelta(left: string, right: string): number {
  return Math.abs(
    (Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) /
      86_400_000
  );
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  if (leftTokens.join(' ') === rightTokens.join(' ')) return 1;
  const intersection = leftTokens.filter((token) => rightTokens.includes(token));
  const union = new Set([...leftTokens, ...rightTokens]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

function normalizedTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize('NFKD')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    ),
  ].sort();
}
