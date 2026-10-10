import { createHash } from 'node:crypto';

export function receiptOpaqueReferenceV1(
  kind: 'receipt' | 'transaction',
  namespace: Uint8Array,
  rawReference: string
): string {
  const digest = createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(rawReference)
    .digest('base64url');
  return `${kind}-v1_${digest}`;
}
