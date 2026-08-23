import { createHmac } from 'node:crypto';
import {
  DOCUMENT_EXPECTATION_CONTRACT_VERSION_V1,
  parseDocumentExpectationSignalsV1,
  type AccountSourceFactV1,
  type DocumentExpectationSignalV1,
  type DocumentExpectationSignalsV1,
  type RecurringSourceFactV1,
} from '../contracts/v1.js';
import { canonicalizeV1 } from '../core/canonical.js';

export interface DocumentExpectationProjectionInputV1 {
  connectorRef: string;
  sourceGeneration: string;
  sourceAsOf: string;
  completeness: 'complete' | 'partial';
  accounts: readonly AccountSourceFactV1[];
  recurring: readonly RecurringSourceFactV1[];
  knownOutgoingRecurringRefs: readonly string[];
}

export function projectDocumentExpectationSignalsV1(
  input: DocumentExpectationProjectionInputV1,
  identityKey: Uint8Array
): DocumentExpectationSignalsV1 {
  if (identityKey.byteLength < 32) {
    throw new RangeError('Identity keys must contain at least 32 bytes');
  }

  const accountSignals = input.accounts
    .filter((account) => account.accountType !== 'cash')
    .map((account) =>
      signal(
        input.connectorRef,
        'account',
        account.sourceRef,
        account.active,
        `${capitalize(account.accountType)} account`,
        'accountStatementCandidate',
        0.85,
        identityKey
      )
    );
  const knownOutgoingRecurringRefs = new Set(input.knownOutgoingRecurringRefs);
  const recurringSignals = input.recurring
    .filter(
      (recurring) =>
        recurring.amountMinor !== null
          ? recurring.amountMinor < 0
          : knownOutgoingRecurringRefs.has(recurring.sourceRef)
    )
    .map((recurring) =>
      signal(
        input.connectorRef,
        'recurring',
        recurring.sourceRef,
        recurring.active,
        recurring.displayName,
        'recurringDocumentCandidate',
        0.9,
        identityKey
      )
    );

  return parseDocumentExpectationSignalsV1({
    contractVersion: DOCUMENT_EXPECTATION_CONTRACT_VERSION_V1,
    connectorRef: input.connectorRef,
    sourceGeneration: input.sourceGeneration,
    sourceAsOf: input.sourceAsOf,
    completeness: input.completeness,
    signals: [...accountSignals, ...recurringSignals].sort((left, right) =>
      left.seriesRef < right.seriesRef ? -1 : left.seriesRef > right.seriesRef ? 1 : 0
    ),
  });
}

function signal(
  connectorRef: string,
  sourceKind: 'account' | 'recurring',
  sourceRef: string,
  active: boolean,
  displayHint: string,
  kind: DocumentExpectationSignalV1['kind'],
  confidence: number,
  identityKey: Uint8Array
): DocumentExpectationSignalV1 {
  const basis =
    sourceKind === 'account'
      ? active
        ? 'active_non_cash_account'
        : 'inactive_non_cash_account'
      : active
        ? 'active_recurring_obligation'
        : 'inactive_recurring_obligation';
  return {
    seriesRef: deriveSeriesRef(
      identityKey,
      connectorRef,
      sourceKind,
      sourceRef
    ),
    kind,
    active,
    displayHint,
    cadence: null,
    nextExpectedDate: null,
    confidence,
    basis: [basis],
  };
}

function deriveSeriesRef(
  identityKey: Uint8Array,
  connectorRef: string,
  sourceKind: 'account' | 'recurring',
  sourceRef: string
): string {
  const digest = createHmac('sha256', identityKey)
    .update(
      canonicalizeV1([
        'owl',
        'document-expectation-signals',
        'v1',
        connectorRef,
        sourceKind,
        sourceRef,
      ])
    )
    .digest('base64url');
  return `expectation-v1_${digest}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
