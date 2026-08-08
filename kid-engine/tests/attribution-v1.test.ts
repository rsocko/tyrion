import { describe, expect, it } from 'vitest';
import {
  AttributionEvaluationError,
  attributeTransactionV1,
  createUnavailableAttributionResultV1,
} from '../src/attribution-v1.js';
import type {
  AttributionInputV1,
  PolicySnapshotV1,
} from '../src/contracts/v1.js';
import { inputFixture, policyFixture } from './fixtures.js';

const evaluatedAt = '2026-08-08T12:03:00Z';

describe('v1 deterministic attribution', () => {
  it('preserves a manual correction ahead of every automated rule', () => {
    const input: AttributionInputV1 = {
      ...inputFixture,
      transaction: {
        ...inputFixture.transaction,
        instrumentFingerprint: 'fingerprint-alpha',
      },
      existingManualDecision: {
        action: 'assign-kid',
        kidId: 'kid-beta',
        actorId: 'actor-demo',
        decidedAt: '2026-08-08T12:02:00Z',
        explanation: 'Household operator assigned this transaction.',
      },
    };
    const result = attributeTransactionV1(input, policyFixture, { evaluatedAt });
    expect(result).toMatchObject({
      status: 'attributed',
      kidId: 'kid-beta',
      confidence: 'definite',
      method: 'manual',
      review: { status: 'resolved', reasons: [] },
      provenance: { decisionSource: 'manual', ruleIds: [] },
    });
  });

  it('auto-assigns a definite card rule with rule provenance', () => {
    const result = attributeTransactionV1(
      {
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          instrumentFingerprint: 'fingerprint-alpha',
        },
      },
      policyFixture,
      { evaluatedAt }
    );
    expect(result).toMatchObject({
      status: 'attributed',
      kidId: 'kid-alpha',
      method: 'card-rule',
      review: { status: 'not-required', reasons: [] },
      provenance: { ruleIds: ['rule-card-alpha'], policyVersion: 1 },
    });
  });

  it('returns a pending conflict independent of rule order', () => {
    const conflictingPolicy: PolicySnapshotV1 = {
      ...policyFixture,
      cardRules: [
        {
          id: 'rule-card-beta',
          kidId: 'kid-beta',
          instrumentFingerprint: 'fingerprint-alpha',
          confidence: 'definite',
          enabled: true,
        },
        policyFixture.cardRules[0],
      ],
    };
    const result = attributeTransactionV1(
      {
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          instrumentFingerprint: 'fingerprint-alpha',
        },
      },
      conflictingPolicy,
      { evaluatedAt }
    );
    expect(result).toMatchObject({
      status: 'pending',
      kidId: null,
      review: { reasons: ['card-rule-conflict'] },
      provenance: {
        ruleIds: ['rule-card-alpha', 'rule-card-beta'],
      },
    });
  });

  it('queues likely merchant matches for review', () => {
    const result = attributeTransactionV1(inputFixture, policyFixture, {
      evaluatedAt,
    });
    expect(result).toMatchObject({
      status: 'pending',
      kidId: 'kid-beta',
      confidence: 'likely',
      method: 'merchant-rule',
      review: { reasons: ['low-confidence'] },
    });
  });

  it('queues tied historical evidence instead of choosing by array order', () => {
    const input: AttributionInputV1 = {
      ...inputFixture,
      transaction: { ...inputFixture.transaction, merchantName: 'History Only' },
      historicalAttributions: [
        {
          normalizedMerchant: 'HISTORY ONLY',
          kidId: 'kid-beta',
          assignmentCount: 4,
        },
        {
          normalizedMerchant: 'HISTORY ONLY',
          kidId: 'kid-alpha',
          assignmentCount: 4,
        },
      ],
    };
    const result = attributeTransactionV1(input, policyFixture, { evaluatedAt });
    expect(result.review.reasons).toEqual(['historical-attribution-tie']);
    expect(result.kidId).toBeNull();
  });

  it('produces a pending fallback so sync can complete when attribution is unavailable', () => {
    const result = createUnavailableAttributionResultV1(
      inputFixture,
      'engine-unavailable',
      evaluatedAt,
      1
    );
    expect(result).toMatchObject({
      status: 'pending',
      method: 'unavailable',
      review: { reasons: ['engine-unavailable'] },
      provenance: { decisionSource: 'fallback', policyVersion: 1 },
    });
  });

  it('still preserves a manual decision when automated attribution is unavailable', () => {
    const result = createUnavailableAttributionResultV1(
      {
        ...inputFixture,
        existingManualDecision: {
          action: 'parent-expense',
          kidId: null,
          actorId: 'actor-demo',
          decidedAt: '2026-08-08T12:02:00Z',
          explanation: 'Household operator marked this as a parent expense.',
        },
      },
      'policy-unavailable',
      evaluatedAt
    );
    expect(result).toMatchObject({
      status: 'unassigned',
      method: 'manual',
      review: { status: 'resolved', reasons: [] },
    });
  });

  it('rejects cross-household policy use', () => {
    expect(() =>
      attributeTransactionV1(
        { ...inputFixture, householdId: 'household-other' },
        policyFixture,
        { evaluatedAt }
      )
    ).toThrowError(AttributionEvaluationError);
  });

  it('rejects impossible evaluation timestamps', () => {
    expect(() =>
      attributeTransactionV1(inputFixture, policyFixture, {
        evaluatedAt: '2026-02-30T12:00:00Z',
      })
    ).toThrowError(AttributionEvaluationError);
  });
});
