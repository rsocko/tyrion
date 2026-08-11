import { describe, expect, it } from 'vitest';
import {
  INSIGHT_ERROR_MESSAGES_V1,
  INSIGHT_ERROR_STATUS_V1,
  createInsightErrorV1,
  parseInsightOccurrenceDetailV1,
  parseInsightErrorResponseV1,
  parseOccurrenceActionRequestV1,
  type InsightErrorCodeV1,
} from '../src/contracts/v1.js';
import {
  createCandidatePolicySnapshotV1,
  createNextPolicySnapshotV1,
  notificationEligibilityV1,
  parseFinanceInsightPolicySnapshotV1,
} from '../src/policy/v1.js';
import { cloneFixture, loadFixture } from './fixtures.js';

describe('structured action and sanitized error contracts', () => {
  it('allows exactly 30, 90, and 180 day confirmed suppressions', async () => {
    const action = (await loadFixture('suppress-action')) as Record<
      string,
      unknown
    >;
    for (const durationDays of [30, 90, 180]) {
      expect(
        parseOccurrenceActionRequestV1({ ...action, durationDays }).action
      ).toBe('suppress');
    }
    for (const durationDays of [0, 29, 31, 365]) {
      expect(() =>
        parseOccurrenceActionRequestV1({ ...action, durationDays })
      ).toThrow();
    }
    expect(() =>
      parseOccurrenceActionRequestV1({ ...action, confirm: false })
    ).toThrow();
    expect(() =>
      parseOccurrenceActionRequestV1({ ...action, permanent: true })
    ).toThrow('Unrecognized key');
  });

  it('never accepts free-form action notes or invented permission fields', async () => {
    const action = (await loadFixture('suppress-action')) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseOccurrenceActionRequestV1({
        ...action,
        note: 'free form is not part of this contract',
      })
    ).toThrow('Unrecognized key');
    expect(() =>
      parseOccurrenceActionRequestV1({
        ...action,
        permission: 'administrator',
      })
    ).toThrow('Unrecognized key');
  });

  it('accepts only the four structured action union members', async () => {
    const suppress = (await loadFixture('suppress-action')) as Record<
      string,
      unknown
    >;
    const shared = {
      contractVersion: suppress.contractVersion,
      occurrenceId: suppress.occurrenceId,
      expectedDeliveryRevision: suppress.expectedDeliveryRevision,
      expectedPolicyVersion: suppress.expectedPolicyVersion,
      idempotencyKey: 'demo-structured-action-v1',
    };
    expect(
      parseOccurrenceActionRequestV1({
        ...shared,
        action: 'expected',
        reason: 'knownHouseholdExpense',
      }).action
    ).toBe('expected');
    expect(
      parseOccurrenceActionRequestV1({
        ...shared,
        action: 'notUseful',
        reason: 'notActionable',
      }).action
    ).toBe('notUseful');
    expect(
      parseOccurrenceActionRequestV1({
        ...shared,
        action: 'undoSuppression',
        suppressionId: 'demo-suppression-v1',
        confirm: true,
      }).action
    ).toBe('undoSuppression');
    expect(() =>
      parseOccurrenceActionRequestV1({
        ...shared,
        action: 'dismiss',
      })
    ).toThrow('Invalid occurrence action request');
  });

  it('maps every stable error code to one exact sanitized status and message', () => {
    for (const code of Object.keys(
      INSIGHT_ERROR_MESSAGES_V1
    ) as InsightErrorCodeV1[]) {
      const descriptor =
        code === 'evaluation_in_progress'
          ? createInsightErrorV1(code, 30)
          : createInsightErrorV1(code);
      expect(descriptor).toEqual({
        status: INSIGHT_ERROR_STATUS_V1[code],
        body: {
          contractVersion: '1.0',
          error: {
            code,
            message: INSIGHT_ERROR_MESSAGES_V1[code],
          },
        },
        retryAfterSeconds: code === 'evaluation_in_progress' ? 30 : null,
      });
      expect(parseInsightErrorResponseV1(descriptor.body)).toEqual(descriptor.body);
    }
  });

  it('rejects mismatched messages and bounds Retry-After without accepting details', async () => {
    const fixture = (await loadFixture('source-unavailable-error')) as Record<
      string,
      unknown
    >;
    expect(parseInsightErrorResponseV1(fixture)).toEqual(fixture);
    expect(() =>
      parseInsightErrorResponseV1({
        ...fixture,
        error: {
          ...(fixture.error as Record<string, unknown>),
          message: 'private upstream exception text',
        },
      })
    ).toThrow('Invalid insight error response');
    expect(() => createInsightErrorV1('evaluation_in_progress', 0)).toThrow(
      '1 to 300'
    );
    expect(() => createInsightErrorV1('evaluation_in_progress', 301)).toThrow(
      '1 to 300'
    );
    expect(() => createInsightErrorV1('invalid_request', 10)).toThrow(
      'only for evaluation_in_progress'
    );
  });
});

describe('immutable versioned candidate policy', () => {
  const options = {
    policyVersion: 1,
    effectiveAt: '2026-08-10T15:00:00Z',
    currency: 'USD',
    timezone: 'America/New_York',
  };

  it('encodes every approved v1 default behind disabled feature gates', () => {
    const policy = createCandidatePolicySnapshotV1(options);
    expect(policy.featureGates).toEqual({
      recurringAmountAnalysis: false,
      recurringAmountNotifications: false,
      largeTransactionAnalysis: false,
      varianceAnalysis: false,
      immediateLargeTransactionNotifications: false,
      monthlyMoverDigestNotifications: false,
      confirmedActions: false,
    });
    expect(policy.recurringAmount).toMatchObject({
      absoluteGateMinor: 7_000,
      relativeGateBasisPoints: 2_500,
      alertDirection: 'increaseOnly',
      adjacentMonthWindow: 1,
      historyMonths: 37,
      minimumSeasonalYears: 2,
    });
    expect(policy.largeTransaction).toMatchObject({
      explicitRuleMinor: 100_000,
      adaptiveMeaningfulDollarFloorMinor: 15_000,
      adaptiveMinimumAgreement: 2,
      eligibleDimensions: ['merchant', 'category', 'account', 'household'],
      historyWindowDays: 365,
      minimumBaselineSampleCount: 5,
      robustDeviationMultiplierMilli: 3_000,
      minimumSpreadMinor: 1_000,
      empiricalPercentileGateBasisPoints: 9_000,
      ratioGateBasisPoints: 20_000,
      highSeverityAmountMinor: 250_000,
      publicationLimit: 50,
      lifecycleTransitionLimit: 100,
      approvedMerchantKeys: [],
      expectedScopes: [],
      suppressedScopes: [],
    });
    expect(policy.variance).toMatchObject({
      absoluteGateMinor: 15_000,
      relativeGateBasisPoints: 3_000,
      persistentOccurrenceLimit: 10,
      digestMemberLimit: 10,
      contributorLimit: 10,
      notifyingMinimumConfidence: 'high',
    });
    expect(policy.freshness.newAlertMaxAgeHours).toBe(48);
    expect(policy.delivery).toEqual({
      largeTransaction: 'immediate',
      monthlyDigestDay: 2,
      monthlyDigestLocalHour: 9,
      monthlyDigestLocalMinute: 0,
      mediumConfidenceMoversNotify: false,
    });
    expect(policy.suppression).toEqual({
      operator: 'fixedLocalOperator',
      allowedDurationsDays: [30, 90, 180],
      permanentAllowed: false,
      undoRequired: true,
    });
  });

  it('deep-freezes parsed snapshots and rejects unknown policy values', () => {
    const policy = createCandidatePolicySnapshotV1(options);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.recurringAmount)).toBe(true);
    expect(Object.isFrozen(policy.largeTransaction.expectedScopes)).toBe(true);
    expect(() =>
      parseFinanceInsightPolicySnapshotV1({ ...policy, retroactive: true })
    ).toThrow('Unrecognized key');
    expect(() => {
      (
        policy.featureGates as {
          recurringAmountAnalysis: boolean;
        }
      ).recurringAmountAnalysis = true;
    }).toThrow(TypeError);
  });

  it('requires monotonic policy versions and future effective times', () => {
    const current = createCandidatePolicySnapshotV1(options);
    const nextInput = {
      ...cloneFixture(current),
      policyVersion: 2,
      effectiveAt: '2026-08-11T15:00:00Z',
    };
    expect(createNextPolicySnapshotV1(current, nextInput).policyVersion).toBe(2);
    expect(() =>
      createNextPolicySnapshotV1(current, { ...nextInput, policyVersion: 3 })
    ).toThrow('exactly one');
    expect(() =>
      createNextPolicySnapshotV1(current, {
        ...nextInput,
        effectiveAt: current.effectiveAt,
      })
    ).toThrow('effectiveAt must increase');

    const fractional = createCandidatePolicySnapshotV1({
      ...options,
      effectiveAt: '2026-08-10T15:00:00.9Z',
    });
    expect(() =>
      createNextPolicySnapshotV1(fractional, {
        ...cloneFixture(fractional),
        policyVersion: 2,
        effectiveAt: '2026-08-10T15:00:00Z',
      })
    ).toThrow('effectiveAt must increase');
    expect(() =>
      createCandidatePolicySnapshotV1({
        ...options,
        effectiveAt: '2026-08-10T15:00:00.000000001Z',
      })
    ).toThrow('millisecond precision');
  });

  it('notifies only gated recurring increases with a usable baseline', async () => {
    const recurring = parseInsightOccurrenceDetailV1(
      await loadFixture('occurrence-detail')
    );
    const policy = createCandidatePolicySnapshotV1(options);
    const enabled = parseFinanceInsightPolicySnapshotV1({
      ...cloneFixture(policy),
      featureGates: {
        ...cloneFixture(policy.featureGates),
        recurringAmountNotifications: true,
      },
    });
    expect(notificationEligibilityV1(recurring, enabled)).toBe(true);
    expect(
      notificationEligibilityV1(
        parseInsightOccurrenceDetailV1({
          ...recurring,
          reasonCodes: [
            ...recurring.reasonCodes,
            'recurring_decrease_analysis_only',
          ],
        }),
        enabled
      )
    ).toBe(false);
  });

  it('keeps medium-confidence movers visible but non-notifying', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    const mover = parseInsightOccurrenceDetailV1({
      ...detail,
      kind: 'categoryVariance',
      confidence: 'medium',
      entity: {
        kind: 'category',
        sourceRef: 'demo-category-recreation-v1',
        displayName: 'Demo Recreation',
        identityQuality: 'stableSource',
      },
    });
    const policy = createCandidatePolicySnapshotV1(options);
    const enabled = parseFinanceInsightPolicySnapshotV1({
      ...cloneFixture(policy),
      featureGates: {
        ...cloneFixture(policy.featureGates),
        monthlyMoverDigestNotifications: true,
      },
    });
    expect(notificationEligibilityV1(mover, enabled)).toBe(false);
    expect(
      notificationEligibilityV1(
        parseInsightOccurrenceDetailV1({ ...mover, confidence: 'high' }),
        enabled
      )
    ).toBe(true);
    expect(
      notificationEligibilityV1(
        parseInsightOccurrenceDetailV1({
          ...mover,
          confidence: 'high',
          freshness: {
            ...mover.freshness,
            state: 'stale',
            warningReason: 'source_stale',
          },
        }),
        enabled
      )
    ).toBe(false);
  });
});
