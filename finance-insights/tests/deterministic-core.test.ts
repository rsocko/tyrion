import { describe, expect, it } from 'vitest';
import {
  canonicalDigestV1,
  canonicalizeV1,
  deriveInsightIdV1,
  deriveMerchantKeyV1,
  deriveOccurrenceIdV1,
  deriveSourceRevisionRefV1,
  evaluateMaterialChangeV1,
  nextDeliveryRevisionV1,
  normalizeIdentityTextV1,
  sourceActivityKeyV1,
  sourceNotificationIdV1,
} from '../src/core/index.js';
import {
  evaluationKeyV1,
  parseEvaluationRequestV1,
} from '../src/contracts/v1.js';

describe('deterministic canonicalization and identity', () => {
  const key = Buffer.alloc(32, 7);

  it('canonicalizes object keys while retaining array order and null', () => {
    expect(canonicalizeV1({ z: 0, a: [null, 2, 1] })).toBe(
      '{"a":[null,2,1],"z":0}'
    );
    expect(canonicalDigestV1({ b: 2, a: 1 })).toBe(
      canonicalDigestV1({ a: 1, b: 2 })
    );
    expect(() => canonicalizeV1({ invalid: Number.NaN })).toThrow(
      'finite safe integers'
    );
    expect(() => canonicalizeV1({ invalid: 1.5 })).toThrow(
      'finite safe integers'
    );
  });

  it('normalizes merchant identity deterministically without locale drift', () => {
    expect(normalizeIdentityTextV1('  DEMO   Market  ')).toBe('demo market');
    expect(deriveMerchantKeyV1(key, 'DEMO Market')).toBe(
      deriveMerchantKeyV1(key, ' demo   market ')
    );
    expect(deriveMerchantKeyV1(key, 'M'.repeat(160))).toMatch(
      /^merchant-v1_[A-Za-z0-9_-]{43}$/
    );
    expect(() => deriveMerchantKeyV1(key, 'Demo\u0000Market')).toThrow(
      'control characters'
    );
    expect(() => deriveMerchantKeyV1(key, 'Demo\u0085Market')).toThrow(
      'control characters'
    );
  });

  it('keeps identity stable across input object order and separates namespaces', () => {
    const insight = deriveInsightIdV1(key, {
      householdScope: 'demo-household-v1',
      kind: 'recurringAmountChange',
      entityKind: 'recurring',
      entitySourceRef: 'demo-recurring-electric-v1',
    });
    const revision = deriveSourceRevisionRefV1(key, {
      sourceKind: 'recurring',
      sourceRef: 'demo-recurring-electric-v1',
      materialFact: { classification: 'knownRecurring', amountMinor: 28640 },
      predecessorRevisionRef: null,
    });
    expect(insight).toBe(
      'insight-v1_VFpCYH8m1N-WEMONPGO5FS_SIFq2RTVor6DXwphV-1Q'
    );
    expect(revision).toBe(
      'revision-v1_YzUeFs7O4GgYrvgOUU1GLh0KIp_3tVNMcHdfykm2UMw'
    );
    expect(
      deriveOccurrenceIdV1(key, insight, {
        kind: 'recurringAmountChange',
        billingPeriod: '2026-07',
        sourceRevisionRef: revision,
      })
    ).toBe('occurrence-v1_LWrUx-lNUiYwXByUG0Nv_QNvSvbHsKmQA0PyLB3K-rU');
    expect(insight).not.toContain('demo-recurring-electric-v1');
    expect(revision).not.toBe(insight);
    expect(() =>
      deriveOccurrenceIdV1(key, insight, {
        kind: 'recurringAmountChange',
        billingPeriod: '2026-13',
        sourceRevisionRef: revision,
      })
    ).toThrow('occurrence discriminator');
  });

  it('requires a server-held identity key of at least 32 bytes', () => {
    expect(() =>
      deriveInsightIdV1(Buffer.alloc(31), {
        householdScope: 'demo-household-v1',
        kind: 'largeTransaction',
        entityKind: 'transaction',
        entitySourceRef: 'demo-transaction-v1',
      })
    ).toThrow('at least 32 bytes');
    expect(() =>
      deriveInsightIdV1(key, {
        householdScope: 'not allowed whitespace',
        kind: 'largeTransaction',
        entityKind: 'transaction',
        entitySourceRef: 'demo-transaction-v1',
      })
    ).toThrow('unsupported characters');
  });

  it('distinguishes correction lineage from material non-correction changes', () => {
    const unchanged = evaluateMaterialChangeV1({
      previousAmountMinor: 20_000,
      nextAmountMinor: 20_999,
      previousClassification: 'postedSpend',
      nextClassification: 'postedSpend',
      amountBoundaryMinor: 1_000,
      changeKind: 'reevaluation',
    });
    expect(unchanged).toEqual({
      lineage: 'unchanged',
      incrementDeliveryRevision: false,
      createSuccessorOccurrence: false,
      resurfaceEligible: false,
    });
    expect(nextDeliveryRevisionV1(4, unchanged)).toBe(4);

    const material = evaluateMaterialChangeV1({
      previousAmountMinor: 20_000,
      nextAmountMinor: 21_000,
      previousClassification: 'postedSpend',
      nextClassification: 'postedSpend',
      amountBoundaryMinor: 1_000,
      changeKind: 'evidence',
    });
    expect(material.lineage).toBe('materialRevision');
    expect(nextDeliveryRevisionV1(4, material)).toBe(5);
    expect(material.resurfaceEligible).toBe(true);

    const correction = evaluateMaterialChangeV1({
      previousAmountMinor: 20_000,
      nextAmountMinor: 18_000,
      previousClassification: 'postedSpend',
      nextClassification: 'refund',
      amountBoundaryMinor: 1_000,
      changeKind: 'correction',
    });
    expect(correction).toEqual({
      lineage: 'correction',
      incrementDeliveryRevision: false,
      createSuccessorOccurrence: true,
      resurfaceEligible: true,
    });
    expect(() =>
      evaluateMaterialChangeV1({
        previousAmountMinor: Number.MAX_SAFE_INTEGER,
        nextAmountMinor: 1,
        previousClassification: 'postedSpend',
        nextClassification: 'postedSpend',
        amountBoundaryMinor: 1_000,
        changeKind: 'evidence',
      })
    ).toThrow('previous material amount');
    expect(() =>
      nextDeliveryRevisionV1(Number.MAX_SAFE_INTEGER, material)
    ).toThrow('safe integer limit');
  });

  it('builds stable Mission Control delivery identity without randomness', () => {
    const occurrence =
      'occurrence-v1_LWrUx-lNUiYwXByUG0Nv_QNvSvbHsKmQA0PyLB3K-rU';
    expect(sourceNotificationIdV1('demo-connector-v1', occurrence)).toBe(
      `finance-insight:demo-connector-v1:${occurrence}`
    );
    expect(sourceActivityKeyV1(occurrence, 3)).toBe(`${occurrence}:3`);
  });

  it('keeps evaluation idempotency identity separate and version-fenced', () => {
    const request = parseEvaluationRequestV1({
      contractVersion: '1.0',
      connectorRef: 'demo-connector-v1',
      sourceGeneration: 'demo-publication-v1',
      detectorSetVersion: 'detectors-v1',
      expectedPolicyVersion: 2,
      idempotencyKey: 'demo-evaluation-idempotency-v1',
    });
    expect(request.expectedPolicyVersion).toBe(2);
    expect(
      evaluationKeyV1({
        householdScope: 'demo-household-v1',
        connectorRef: request.connectorRef,
        sourceGeneration: request.sourceGeneration,
        detectorSetVersion: request.detectorSetVersion,
        policyVersion: request.expectedPolicyVersion,
      })
    ).toBe(
      '["demo-household-v1","demo-connector-v1","demo-publication-v1","detectors-v1",2]'
    );
    expect(
      evaluationKeyV1({
        householdScope: 'demo-household-v1',
        connectorRef: 'a:b',
        sourceGeneration: 'c',
        detectorSetVersion: 'detectors-v1',
        policyVersion: 2,
      })
    ).not.toBe(
      evaluationKeyV1({
        householdScope: 'demo-household-v1',
        connectorRef: 'a',
        sourceGeneration: 'b:c',
        detectorSetVersion: 'detectors-v1',
        policyVersion: 2,
      })
    );
  });
});
