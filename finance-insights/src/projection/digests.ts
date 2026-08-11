import type {
  SourceFactBatchV1,
  SourceFactKindV1,
  SourceGenerationCreateRequestV1,
  SourceManifestEntryV1,
} from '../contracts/source-v1.js';
import {
  canonicalDigestV1,
  type CanonicalJsonValue,
} from '../core/canonical.js';

export const SOURCE_FACT_KIND_ORDER_V1: readonly SourceFactKindV1[] = Object.freeze([
  'transaction',
  'recurring',
  'category',
  'account',
  'tag',
]);

export function sourceBatchDigestV1(batch: SourceFactBatchV1): string {
  return canonicalDigestV1(batch.facts as CanonicalJsonValue);
}

export function sourceManifestKindDigestV1(
  kind: SourceFactKindV1,
  batches: readonly SourceFactBatchV1[]
): string {
  const facts: CanonicalJsonValue[] = [];
  const ordered = batches
    .filter((batch) => batch.kind === kind)
    .sort((left, right) => left.batchIndex - right.batchIndex);
  for (const batch of ordered) {
    for (const fact of batch.facts) facts.push(fact as CanonicalJsonValue);
  }
  return canonicalDigestV1(facts);
}

export function sourceManifestDigestV1(
  manifest: readonly SourceManifestEntryV1[]
): string {
  const order = new Map(
    SOURCE_FACT_KIND_ORDER_V1.map((kind, index) => [kind, index])
  );
  return canonicalDigestV1(
    [...manifest].sort(
      (left, right) => order.get(left.kind)! - order.get(right.kind)!
    ) as CanonicalJsonValue
  );
}

export function sourceGenerationInputDigestV1(
  request: SourceGenerationCreateRequestV1
): string {
  return canonicalDigestV1(request as CanonicalJsonValue);
}
