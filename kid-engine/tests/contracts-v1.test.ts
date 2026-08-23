import { describe, expect, it } from 'vitest';
import {
  ContractValidationError,
  TYRION_DOMAIN_CONTRACT_VERSION,
  createDefaultPolicyDraftV1,
  parseAttributionInputV1,
  parsePolicyActorV1,
  parsePolicySnapshotV1,
  parseReattributionApplyRequestV1,
  parseReattributionPreviewV1,
  parseReattributionPreviewRequestV1,
  policyDraftFromSnapshotV1,
} from '../src/contracts/v1.js';
import { inputFixture, policyDraftFixture, policyFixture } from './fixtures.js';

describe('v1 domain contract validation', () => {
  it('normalizes and accepts a complete policy snapshot', () => {
    const parsed = parsePolicySnapshotV1(policyFixture);
    expect(parsed).toEqual(policyFixture);
  });

  it('provides a strict empty draft and snapshot projection for configuration hosts', () => {
    expect(createDefaultPolicyDraftV1()).toMatchObject({
      timezone: 'UTC',
      currency: 'USD',
      kids: [],
      exceptionPolicy: { limitWarningPercent: 80 },
    });
    expect(policyDraftFromSnapshotV1(policyFixture)).toEqual(policyDraftFixture);
  });

  it('rejects unknown fields instead of accepting contract drift', () => {
    expect(() =>
      parsePolicySnapshotV1({ ...policyFixture, upstreamPayload: {} })
    ).toThrowError(ContractValidationError);
  });

  it('rejects rules that reference another or missing household kid', () => {
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        accountRules: [
          { ...policyFixture.accountRules[0], kidId: 'kid-not-configured' },
        ],
      })
    ).toThrow('references an unknown kid');
  });

  it('rejects account values that are not connector-generated opaque references', () => {
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        accountRules: [
          {
            ...policyFixture.accountRules[0],
            accountRef:
              'account-v1:!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
          },
        ],
      })
    ).toThrow('stable opaque connector-generated account reference');
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        accountRules: [
          {
            ...policyFixture.accountRules[0],
            accountRef: ` ${policyFixture.accountRules[0].accountRef}`,
          },
        ],
      })
    ).toThrow('stable opaque connector-generated account reference');
  });

  it('rejects duplicate limit periods and mismatched currencies', () => {
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        limits: [
          ...policyFixture.limits,
          { ...policyFixture.limits[0], amount: 50 },
        ],
      })
    ).toThrow('kid limit periods must be unique');
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        limits: [{ ...policyFixture.limits[0], currency: 'EUR' }],
      })
    ).toThrow('must match policy currency');
  });

  it('strictly validates exception and notification policy', () => {
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        exceptionPolicy: {
          ...policyFixture.exceptionPolicy,
          limitWarningPercent: 0,
        },
      })
    ).toThrow('between 1 and 100');
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        exceptionPolicy: {
          ...policyFixture.exceptionPolicy,
          notificationSignals: ['limit-warning', 'limit-warning'],
        },
      })
    ).toThrow('must be unique');
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        exceptionPolicy: {
          ...policyFixture.exceptionPolicy,
          notificationSignals: ['unsupported-signal'],
        },
      })
    ).toThrow('unsupported value');
  });

  it('rejects invalid timezone, currency, and timestamp values', () => {
    expect(() =>
      parsePolicySnapshotV1({ ...policyFixture, timezone: 'not-a-zone' })
    ).toThrow('IANA timezone');
    expect(() =>
      parsePolicySnapshotV1({ ...policyFixture, timezone: 'CST' })
    ).toThrow('IANA timezone');
    expect(() =>
      parsePolicySnapshotV1({ ...policyFixture, currency: '123' })
    ).toThrow('ISO 4217 currency');
    expect(() =>
      parsePolicySnapshotV1({
        ...policyFixture,
        updatedAt: '2026-02-30T12:00:00Z',
      })
    ).toThrow('valid ISO 8601 timestamp');
  });

  it('rejects inconsistent manual decision shapes', () => {
    expect(() =>
      parseAttributionInputV1({
        ...inputFixture,
        existingManualDecision: {
          action: 'parent-expense',
          kidId: 'kid-alpha',
          actorId: 'actor-demo',
          decidedAt: '2026-08-08T12:02:00Z',
          explanation: 'Reviewed by a household operator.',
        },
      })
    ).toThrow('action and kidId are inconsistent');
  });

  it('rejects reserved identifiers and invalid calendar dates', () => {
    expect(() =>
      parsePolicyActorV1({
        actorId: 'constructor',
        householdId: 'household-demo',
        permissions: ['policy:read'],
      })
    ).toThrow('reserved value');
    expect(() =>
      parseAttributionInputV1({
        ...inputFixture,
        transaction: {
          ...inputFixture.transaction,
          occurredOn: '2026-02-30',
        },
      })
    ).toThrow('calendar date');
  });

  it('requires bounded explicit re-attribution selection and confirmation', () => {
    expect(
      parseReattributionPreviewRequestV1({
        contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
        householdId: 'household-demo',
        expectedPolicyVersion: 1,
        sourceRefs: ['source-record-demo'],
      }).sourceRefs
    ).toEqual(['source-record-demo']);
    expect(() =>
      parseReattributionPreviewRequestV1({
        contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
        householdId: 'household-demo',
        expectedPolicyVersion: 1,
        sourceRefs: [],
      })
    ).toThrow('must not be empty');
    expect(() =>
      parseReattributionApplyRequestV1({
        contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: false,
      })
    ).toThrow('confirm must be true');
  });

  it('strictly validates persisted previews and nested attribution results', () => {
    const result = {
      contractVersion: '2.0',
      sourceRef: 'source-record-demo',
      status: 'pending',
      kidId: 'kid-beta',
      confidence: 'likely',
      method: 'merchant-rule',
      explanation: 'A configured merchant rule matched.',
      review: { status: 'pending', reasons: ['low-confidence'] },
      provenance: {
        decisionSource: 'automated',
        policyVersion: 1,
        engineVersion: '2.0.0',
        ruleIds: ['rule-merchant-beta'],
        evaluatedAt: '2026-08-08T12:03:00Z',
      },
    };
    expect(() =>
      parseReattributionPreviewV1({
        contractVersion: '2.0',
        previewId: 'preview-demo',
        householdId: 'household-demo',
        policyVersion: 1,
        createdAt: '2026-08-08T12:03:00Z',
        expiresAt: 'not-a-timestamp',
        items: [],
      })
    ).toThrow('expiresAt');
    expect(() =>
      parseReattributionPreviewV1({
        contractVersion: '2.0',
        previewId: 'preview-demo',
        householdId: 'household-demo',
        policyVersion: 1,
        createdAt: '2026-08-08T12:03:00Z',
        expiresAt: '2026-08-08T12:18:00Z',
        items: [
          {
            sourceRef: 'source-record-demo',
            previous: result,
            proposed: { ...result, unexpected: true },
            disposition: 'unchanged',
          },
        ],
      })
    ).toThrow('unexpected field');
    expect(() =>
      parseReattributionPreviewV1({
        contractVersion: '2.0',
        previewId: 'preview-demo',
        householdId: 'household-demo',
        policyVersion: 2,
        createdAt: '2026-08-08T12:03:00Z',
        expiresAt: '2026-08-08T12:18:00Z',
        items: [
          {
            sourceRef: 'source-record-demo',
            previous: result,
            proposed: result,
            disposition: 'unchanged',
          },
        ],
      })
    ).toThrow('proposed policy version is inconsistent');
  });
});
