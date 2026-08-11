import type {
  ConnectorHealthJobRequestV1,
  DuplicateTransactionJobRequestV1,
  FinanceAutomationJobRequestV1,
} from './contracts-v1.js';
import { canonicalAutomationTimestampV1 } from './identity-v1.js';

export function normalizeFinanceAutomationJobRequestV1(
  request: FinanceAutomationJobRequestV1
): FinanceAutomationJobRequestV1 {
  return request.jobKind === 'duplicateTransactions'
    ? normalizeDuplicateAutomationJobRequestV1(request)
    : normalizeConnectorHealthJobRequestV1(request);
}

export function normalizeDuplicateAutomationJobRequestV1(
  request: DuplicateTransactionJobRequestV1
): DuplicateTransactionJobRequestV1 {
  const classification = request.insightPolicy.sourceClassification;
  const largeTransaction = request.insightPolicy.largeTransaction;
  return {
    ...request,
    scheduledFor: canonicalAutomationTimestampV1(request.scheduledFor),
    evaluatedAt: canonicalAutomationTimestampV1(request.evaluatedAt),
    source: {
      ...request.source,
      sourceAsOf: canonicalAutomationTimestampV1(request.source.sourceAsOf),
      capturedConstituents: request.source.capturedConstituents
        .map((constituent) => ({
          ...constituent,
          sourceAsOf: canonicalAutomationTimestampV1(constituent.sourceAsOf),
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
      manifest: [...request.source.manifest].sort((left, right) =>
        left.kind.localeCompare(right.kind)
      ),
    },
    transactions: request.transactions
      .map((transaction) => ({
        ...transaction,
        tagRefs: [...transaction.tagRefs].sort(),
      }))
      .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef)),
    suppressedPairs: [...request.suppressedPairs].sort((left, right) =>
      `${left.sourceRefs.join('\0')}\0${left.reason}`.localeCompare(
        `${right.sourceRefs.join('\0')}\0${right.reason}`
      )
    ),
    insightPolicy: {
      ...request.insightPolicy,
      effectiveAt: canonicalAutomationTimestampV1(
        request.insightPolicy.effectiveAt
      ),
      sourceClassification: {
        ...classification,
        transferCategoryRefs: [...classification.transferCategoryRefs].sort(),
        transferTagRefs: [...classification.transferTagRefs].sort(),
        incomeCategoryRefs: [...classification.incomeCategoryRefs].sort(),
        incomeTagRefs: [...classification.incomeTagRefs].sort(),
        refundCategoryRefs: [...classification.refundCategoryRefs].sort(),
        refundTagRefs: [...classification.refundTagRefs].sort(),
        excludedCategoryRefs: [...classification.excludedCategoryRefs].sort(),
        excludedTagRefs: [...classification.excludedTagRefs].sort(),
      },
      largeTransaction: {
        ...largeTransaction,
        approvedMerchantKeys: [...largeTransaction.approvedMerchantKeys].sort(),
        expectedScopes: [...largeTransaction.expectedScopes].sort(compareScope),
        suppressedScopes: [...largeTransaction.suppressedScopes].sort(compareScope),
      },
    },
  };
}

export function normalizeConnectorHealthJobRequestV1(
  request: ConnectorHealthJobRequestV1
): ConnectorHealthJobRequestV1 {
  return {
    ...request,
    scheduledFor: canonicalAutomationTimestampV1(request.scheduledFor),
    evaluatedAt: canonicalAutomationTimestampV1(request.evaluatedAt),
    observation: {
      ...request.observation,
      observedAt: canonicalAutomationTimestampV1(request.observation.observedAt),
      lastSuccessfulSyncAt:
        request.observation.lastSuccessfulSyncAt === null
          ? null
          : canonicalAutomationTimestampV1(
              request.observation.lastSuccessfulSyncAt
            ),
    },
  };
}

function compareScope(
  left: { readonly kind: string; readonly sourceRef: string },
  right: { readonly kind: string; readonly sourceRef: string }
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.sourceRef.localeCompare(right.sourceRef)
  );
}
