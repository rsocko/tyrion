import { createHmac } from 'node:crypto';
import { canonicalizeV1, type CanonicalJsonValue } from '../core/canonical.js';

export function deriveAutomationRunIdV1(
  key: Uint8Array,
  jobKind: 'duplicateTransactions' | 'connectorHealth',
  connectorRef: string,
  scheduledFor: string
): string {
  return derive(key, 'run', {
    namespace: 'finance-automation-run-v1',
    jobKind,
    connectorRef,
    scheduledFor: canonicalAutomationTimestampV1(scheduledFor),
  });
}

export function canonicalAutomationTimestampV1(value: string): string {
  return new Date(value).toISOString();
}

export function deriveDuplicateSignalIdV1(
  key: Uint8Array,
  connectorRef: string,
  sourceRefs: readonly [string, string]
): string {
  return derive(key, 'signal', {
    namespace: 'finance-automation-signal-v1',
    kind: 'duplicateTransaction',
    connectorRef,
    sourceRefs: [...sourceRefs].sort(),
  });
}

export function deriveConnectorHealthSignalIdV1(
  key: Uint8Array,
  connectorRef: string
): string {
  return derive(key, 'signal', {
    namespace: 'finance-automation-signal-v1',
    kind: 'connectorHealth',
    connectorRef,
  });
}

export function automationDeliveryKeyV1(signalId: string): string {
  return `finance-automation:${signalId}`;
}

function derive(
  key: Uint8Array,
  prefix: 'run' | 'signal',
  value: CanonicalJsonValue
): string {
  if (key.byteLength < 32) {
    throw new RangeError('Automation identity keys must contain at least 32 bytes');
  }
  const digest = createHmac('sha256', key)
    .update(canonicalizeV1(value))
    .digest('base64url');
  return `${prefix}-v1_${digest}`;
}
