import { createHash } from 'node:crypto';
import {
  DOCUMENT_EXPECTATION_CONTRACT_VERSION_V1,
  parseDocumentExpectationSignalsV1,
  type AccountSourceFactV1,
  type DocumentExpectationSignalV1,
  type DocumentExpectationSignalsV1,
  type RecurringSourceFactV1,
} from '../contracts/v1.js';
import { canonicalizeV1 } from '../core/canonical.js';

const ADVISORY_SOURCE_CONFIDENCE_V1 = 0.6;

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
  identityNamespace: Uint8Array
): DocumentExpectationSignalsV1 {
  if (identityNamespace.byteLength < 16) {
    throw new RangeError('Identity namespaces must contain at least 16 bytes');
  }

  const accountSignals = input.accounts
    .filter((account) => account.accountType !== 'cash')
    .map((account) =>
      accountSignal(
        input.connectorRef,
        account,
        identityNamespace
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
      recurringSignal(
        input.connectorRef,
        recurring.sourceRef,
        recurring.active,
        identityNamespace
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

function accountSignal(
  connectorRef: string,
  account: AccountSourceFactV1,
  identityNamespace: Uint8Array
): DocumentExpectationSignalV1 {
  return {
    seriesRef: deriveSeriesRef(
      identityNamespace,
      connectorRef,
      'account',
      account.sourceRef
    ),
    kind: 'accountStatementCandidate',
    active: account.active,
    displayHint:
      account.displayName ?? `${capitalize(account.accountType)} account`,
    cadence: null,
    nextExpectedDate: null,
    confidence: ADVISORY_SOURCE_CONFIDENCE_V1,
    basis: [
      account.active
        ? 'active_non_cash_account'
        : 'inactive_non_cash_account',
    ],
    ...(account.displayName ? { accountName: account.displayName } : {}),
    ...(account.institutionName
      ? { institutionName: account.institutionName }
      : {}),
    accountType: account.accountType,
    ...(account.accountLastFour
      ? { accountLastFour: account.accountLastFour }
      : {}),
  };
}

function recurringSignal(
  connectorRef: string,
  sourceRef: string,
  active: boolean,
  identityNamespace: Uint8Array
): DocumentExpectationSignalV1 {
  return {
    seriesRef: deriveSeriesRef(
      identityNamespace,
      connectorRef,
      'recurring',
      sourceRef
    ),
    kind: 'recurringDocumentCandidate',
    active,
    displayHint: 'Recurring expense',
    cadence: null,
    nextExpectedDate: null,
    confidence: ADVISORY_SOURCE_CONFIDENCE_V1,
    basis: [
      active
        ? 'active_recurring_obligation'
        : 'inactive_recurring_obligation',
    ],
  };
}

function deriveSeriesRef(
  identityNamespace: Uint8Array,
  connectorRef: string,
  sourceKind: 'account' | 'recurring',
  sourceRef: string
): string {
  const digest = createHash('sha256')
    .update(identityNamespace)
    .update('\0')
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
