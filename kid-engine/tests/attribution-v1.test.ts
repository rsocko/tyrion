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
const accountRef = 'bridge-account-alpha';

describe('v1 deterministic attribution', () => {
  it('preserves a manual correction ahead of every automated rule', () => {
    const input: AttributionInputV1 = {
      ...inputFixture,
      transaction: {
        ...inputFixture.transaction,
        accountRef,
        merchantName: 'No explicit rule',
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

  it('uses a child account default after explicit rules', () => {
    const result = attributeTransactionV1(
      {
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          accountRef,
          merchantName: 'No explicit rule',
        },
      },
      policyFixture,
      { evaluatedAt }
    );
    expect(result).toMatchObject({
      status: 'attributed',
      kidId: 'kid-alpha',
      method: 'account-default',
      review: { status: 'not-required', reasons: [] },
      provenance: { ruleIds: [], policyVersion: 1 },
    });
  });

  it('lets a specific merchant rule override a child account default', () => {
    const result = attributeTransactionV1(
      {
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          accountRef,
        },
      },
      policyFixture,
      { evaluatedAt }
    );
    expect(result).toMatchObject({
      status: 'pending',
      kidId: 'kid-beta',
      method: 'merchant-rule',
      review: { reasons: ['low-confidence'] },
    });
  });

  it('resolves a parent/shared default without creating review work', () => {
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      accountDefaults: [
        { accountRef: 'bridge-account-shared', mode: 'parent-shared', kidId: null },
      ],
    };
    const result = attributeTransactionV1(
      {
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          merchantName: 'No explicit rule',
        },
      },
      policy,
      { evaluatedAt }
    );
    expect(result).toMatchObject({
      status: 'unassigned',
      kidId: null,
      confidence: 'definite',
      method: 'account-default',
      review: { status: 'not-required', reasons: [] },
    });
  });

  it('lets a specific merchant rule override a parent/shared default', () => {
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      accountDefaults: [
        { accountRef: 'bridge-account-shared', mode: 'parent-shared', kidId: null },
      ],
    };
    const result = attributeTransactionV1(inputFixture, policy, { evaluatedAt });
    expect(result).toMatchObject({
      status: 'pending',
      kidId: 'kid-beta',
      method: 'merchant-rule',
    });
  });

  it('lets an account-scoped parent/shared rule override a global kid rule', () => {
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      merchantRules: [
        policyFixture.merchantRules[0],
        {
          id: 'rule-shared-account-override',
          outcome: 'parent-shared',
          kidId: null,
          pattern: 'SYNTHETIC SHOP',
          businessEntityPattern: null,
          scope: 'accounts',
          accountRefs: ['bridge-account-shared'],
          confidence: 'definite',
          enabled: true,
        },
      ],
    };
    const result = attributeTransactionV1(inputFixture, policy, { evaluatedAt });
    expect(result).toMatchObject({
      status: 'unassigned',
      kidId: null,
      confidence: 'definite',
      method: 'merchant-rule',
      review: { status: 'not-required', reasons: [] },
      provenance: { ruleIds: ['rule-shared-account-override'] },
    });
  });

  it('supports an account-scoped rule that always routes a merchant to review', () => {
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      merchantRules: [
        {
          id: 'rule-review-account-override',
          outcome: 'review',
          kidId: null,
          pattern: 'SYNTHETIC SHOP',
          businessEntityPattern: null,
          scope: 'accounts',
          accountRefs: ['bridge-account-shared'],
          confidence: 'definite',
          enabled: true,
        },
      ],
    };
    const result = attributeTransactionV1(inputFixture, policy, { evaluatedAt });
    expect(result).toMatchObject({
      status: 'pending',
      kidId: null,
      method: 'merchant-rule',
      confidence: 'definite',
      review: { status: 'pending', reasons: ['merchant-rule-review'] },
    });
  });

  it('keeps same-specificity override disagreements reviewable', () => {
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      merchantRules: [
        {
          id: 'rule-account-kid',
          outcome: 'kid',
          kidId: 'kid-alpha',
          pattern: 'SYNTHETIC SHOP',
          businessEntityPattern: null,
          scope: 'accounts',
          accountRefs: ['bridge-account-shared'],
          confidence: 'definite',
          enabled: true,
        },
        {
          id: 'rule-account-parent',
          outcome: 'parent-shared',
          kidId: null,
          pattern: 'SYNTHETIC SHOP',
          businessEntityPattern: null,
          scope: 'accounts',
          accountRefs: ['bridge-account-shared'],
          confidence: 'definite',
          enabled: true,
        },
      ],
    };
    const result = attributeTransactionV1(inputFixture, policy, { evaluatedAt });
    expect(result).toMatchObject({
      status: 'pending',
      kidId: null,
      review: { reasons: ['merchant-rule-conflict'] },
      provenance: {
        ruleIds: ['rule-account-kid', 'rule-account-parent'],
      },
    });
  });

  it('uses an optional business-entity pattern as an additional discriminator', () => {
    const entityRule = {
      ...policyFixture.merchantRules[0],
      businessEntityPattern: 'HOLDINGS NORTH',
    };
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      merchantRules: [entityRule],
    };
    const withoutEntity = attributeTransactionV1(inputFixture, policy, {
      evaluatedAt,
    });
    expect(withoutEntity.review.reasons).toEqual(['no-match']);

    const withEntity = attributeTransactionV1(
      {
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          businessEntityName: 'Synthetic Holdings North LLC',
        },
      },
      policy,
      { evaluatedAt }
    );
    expect(withEntity).toMatchObject({
      kidId: 'kid-beta',
      method: 'merchant-rule',
      provenance: { ruleIds: ['rule-merchant-beta'] },
    });
  });

  it('uses history then no-match for a rule-based account', () => {
    const policy: PolicySnapshotV1 = {
      ...policyFixture,
      merchantRules: [],
      accountDefaults: [
        { accountRef: 'bridge-account-shared', mode: 'rule-based', kidId: null },
      ],
    };
    const historical = attributeTransactionV1(
      {
        ...inputFixture,
        historicalAttributions: [
          {
            normalizedMerchant: 'SYNTHETIC SHOP',
            kidId: 'kid-alpha',
            assignmentCount: 4,
          },
        ],
      },
      policy,
      { evaluatedAt }
    );
    expect(historical.method).toBe('historical-pattern');
    const unmatched = attributeTransactionV1(inputFixture, policy, { evaluatedAt });
    expect(unmatched).toMatchObject({
      status: 'unassigned',
      review: { status: 'pending', reasons: ['no-match'] },
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

  it('accepts likely attribution when policy does not require review', () => {
    const result = attributeTransactionV1(
      inputFixture,
      {
        ...policyFixture,
        exceptionPolicy: {
          ...policyFixture.exceptionPolicy,
          requireReviewForLikelyAttribution: false,
        },
      },
      { evaluatedAt }
    );
    expect(result).toMatchObject({
      status: 'attributed',
      kidId: 'kid-beta',
      confidence: 'likely',
      review: { status: 'not-required', reasons: [] },
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

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid fallback policy version %s',
    (policyVersion) => {
      expect(() =>
        createUnavailableAttributionResultV1(
          inputFixture,
          'policy-unavailable',
          evaluatedAt,
          policyVersion
        )
      ).toThrowError(AttributionEvaluationError);
    }
  );

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
