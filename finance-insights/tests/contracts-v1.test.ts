import { describe, expect, it } from 'vitest';
import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  MAX_AMOUNT_MINOR_V1,
  defaultOccurrenceListQueryV1,
  fallbackTargetForV1,
  parseExternalTargetV1,
  parseInsightOccurrenceDetailV1,
  parseInsightOccurrenceSummaryV1,
  parseOccurrenceActionRequestV1,
  parseOccurrenceListQueryV1,
  parseSourceFactBatchV1,
  parseSourceGenerationCreateRequestV1,
  parseEvaluationResultV1,
  parseSourceGenerationResultV1,
} from '../src/contracts/v1.js';
import { cloneFixture, loadFixture } from './fixtures.js';

describe('finance insight v1 contract fixtures', () => {
  it('round-trips every invented shared fixture without type or field drift', async () => {
    const source = await loadFixture('source-generation-create');
    const batch = await loadFixture('transaction-batch');
    const detail = await loadFixture('occurrence-detail');
    const action = await loadFixture('suppress-action');

    expect(
      JSON.parse(JSON.stringify(parseSourceGenerationCreateRequestV1(source)))
    ).toEqual(source);
    expect(JSON.parse(JSON.stringify(parseSourceFactBatchV1(batch)))).toEqual(batch);
    expect(
      JSON.parse(JSON.stringify(parseInsightOccurrenceDetailV1(detail)))
    ).toEqual(detail);
    expect(JSON.parse(JSON.stringify(parseOccurrenceActionRequestV1(action)))).toEqual(
      action
    );
  });

  it('uses one detail DTO whose summary projection remains valid', async () => {
    const detail = parseInsightOccurrenceDetailV1(
      await loadFixture('occurrence-detail')
    );
    const {
      ruleResults: _ruleResults,
      baseline: _baseline,
      comparisons: _comparisons,
      contributors: _contributors,
      exclusions: _exclusions,
      evidence: _evidence,
      lifecycleHistory: _history,
      suppression: _suppression,
      availableActions: _actions,
      ...summary
    } = detail;

    expect(parseInsightOccurrenceSummaryV1(summary).occurrenceId).toBe(
      detail.occurrenceId
    );
  });

  it('rejects unknown fields at top level and in nested values', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInsightOccurrenceDetailV1({ ...detail, rawUpstream: {} })
    ).toThrow('Unrecognized key');

    const nested = cloneFixture(detail);
    (
      (nested.provenance as Record<string, unknown>)
    ).providerResponse = 'not allowed';
    expect(() => parseInsightOccurrenceDetailV1(nested)).toThrow(
      'provenance: Unrecognized key'
    );
  });

  it('keeps zero, null, unavailable, and insufficient baseline distinct', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    const insufficient = cloneFixture(detail);
    insufficient.analysisState = 'insufficientBaseline';
    insufficient.sourceLifecycle = null;
    insufficient.resolutionReason = null;
    insufficient.supersededByOccurrenceId = null;
    insufficient.observedValue = { currency: 'USD', amountMinor: 0 };
    insufficient.expectedRange = null;
    insufficient.absoluteDelta = null;
    insufficient.percentageDeltaBasisPoints = null;
    insufficient.resolvedAt = null;
    insufficient.baselineSufficiency = 'insufficient';
    insufficient.targets = [];
    insufficient.availableActions = [];
    insufficient.lifecycleHistory = [
      {
        sequence: 1,
        state: 'analyzing',
        reasonCode: null,
        occurredAt: '2026-08-10T15:05:00Z',
        replacementOccurrenceId: null,
      },
      {
        sequence: 2,
        state: 'insufficientBaseline',
        reasonCode: 'seasonal_baseline_insufficient',
        occurredAt: '2026-08-10T15:05:01Z',
        replacementOccurrenceId: null,
      },
    ];

    const parsed = parseInsightOccurrenceDetailV1(insufficient);
    expect(parsed.observedValue?.amountMinor).toBe(0);
    expect(parsed.expectedRange).toBeNull();
    expect(parsed.analysisState).toBe('insufficientBaseline');
  });

  it('enforces analysis and source lifecycle combinations', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        analysisState: 'analyzing',
        sourceLifecycle: 'open',
      })
    ).toThrow('must be present exactly when analysisState is qualified');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        sourceLifecycle: 'resolved',
        resolutionReason: null,
        resolvedAt: null,
      })
    ).toThrow('requires a reason and resolvedAt');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        sourceLifecycle: 'superseded',
        resolutionReason: 'correction_superseded',
        resolvedAt: '2026-08-10T15:06:00Z',
        supersededByOccurrenceId: null,
      })
    ).toThrow('requires reason, replacement, and resolvedAt');
  });

  it('accepts every independent confidence and baseline sufficiency pairing', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    const explicitLargeTransaction = {
      ...detail,
      kind: 'largeTransaction',
      entity: {
        kind: 'transaction',
        sourceRef: 'demo-transaction-trailside-v1',
        displayName: 'Trailside Cycles Demo',
        identityQuality: 'stableSource',
      },
      reasonCodes: [
        ...(detail.reasonCodes as string[]),
        'explicit_amount_rule_exceeded',
      ],
    };
    for (const confidence of ['low', 'medium', 'high']) {
      for (const baselineSufficiency of [
        'insufficient',
        'limited',
        'sufficient',
      ]) {
        expect(
          parseInsightOccurrenceDetailV1({
            ...explicitLargeTransaction,
            confidence,
            baselineSufficiency,
          })
        ).toMatchObject({ confidence, baselineSufficiency });
      }
    }
  });

  it('accepts every analysis state only with its permitted lifecycle shape', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    for (const analysisState of [
      'analyzing',
      'insufficientBaseline',
      'unavailable',
    ]) {
      const reasonCode =
        analysisState === 'insufficientBaseline'
          ? 'seasonal_baseline_insufficient'
          : analysisState === 'unavailable'
            ? 'source_unavailable'
            : null;
      expect(
        parseInsightOccurrenceDetailV1({
          ...detail,
          analysisState,
          sourceLifecycle: null,
          availableActions: [],
          lifecycleHistory: [
            {
              sequence: 1,
              state: 'analyzing',
              reasonCode: null,
              occurredAt: '2026-08-10T15:05:00Z',
              replacementOccurrenceId: null,
            },
            ...(analysisState === 'analyzing'
              ? []
              : [
                  {
                    sequence: 2,
                    state: analysisState,
                    reasonCode,
                    occurredAt: '2026-08-10T15:05:01Z',
                    replacementOccurrenceId: null,
                  },
                ]),
          ],
        }).analysisState
      ).toBe(analysisState);
    }
    for (const sourceLifecycle of ['open', 'resolved', 'superseded']) {
      const lifecycle =
        sourceLifecycle === 'open'
          ? {
              sourceLifecycle,
              resolutionReason: null,
              resolvedAt: null,
              supersededByOccurrenceId: null,
            }
          : sourceLifecycle === 'resolved'
            ? {
                sourceLifecycle,
                resolutionReason: 'correction_resolved',
                resolvedAt: '2026-08-10T15:06:00Z',
                supersededByOccurrenceId: null,
              }
            : {
                sourceLifecycle,
                resolutionReason: 'correction_superseded',
                resolvedAt: '2026-08-10T15:06:00Z',
                supersededByOccurrenceId:
                  'occurrence-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              };
      expect(
        parseInsightOccurrenceDetailV1({
          ...detail,
          analysisState: 'qualified',
          ...lifecycle,
          updatedAt:
            sourceLifecycle === 'open'
              ? detail.updatedAt
              : '2026-08-10T15:06:00Z',
          availableActions:
            sourceLifecycle === 'open'
              ? (detail.availableActions as unknown[])
              : [],
          lifecycleHistory:
            sourceLifecycle === 'open'
              ? (detail.lifecycleHistory as unknown[])
              : [
                  ...(detail.lifecycleHistory as unknown[]),
                  {
                    sequence: 3,
                    state: sourceLifecycle,
                    reasonCode:
                      sourceLifecycle === 'resolved'
                        ? 'correction_resolved'
                        : 'correction_superseded',
                    occurredAt: '2026-08-10T15:06:00Z',
                    replacementOccurrenceId:
                      sourceLifecycle === 'superseded'
                        ? 'occurrence-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
                        : null,
                  },
                ],
        }).sourceLifecycle
      ).toBe(sourceLifecycle);
    }
  });

  it('rejects kind/entity mismatches, stale fresh assertions, and contradictory history', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        entity: {
          kind: 'category',
          sourceRef: 'demo-category-v1',
          displayName: 'Demo Category',
          identityQuality: 'stableSource',
        },
      })
    ).toThrow('must be recurring for recurringAmountChange');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        freshness: {
          ...(detail.freshness as Record<string, unknown>),
          sourceAsOf: '2026-01-01T00:00:00Z',
        },
        provenance: {
          ...(detail.provenance as Record<string, unknown>),
          sourceAsOf: '2026-01-01T00:00:00Z',
        },
      })
    ).toThrow('within maxAgeHours');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        lifecycleHistory: [
          ...(detail.lifecycleHistory as unknown[]),
          {
            sequence: 3,
            state: 'resolved',
            reasonCode: 'correction_resolved',
            occurredAt: '2026-08-10T15:06:00Z',
            replacementOccurrenceId: null,
          },
        ],
      })
    ).toThrow('terminal state must match');
    const superseded = {
      ...detail,
      sourceLifecycle: 'superseded',
      resolutionReason: 'correction_superseded',
      resolvedAt: '2026-08-10T15:06:00Z',
      updatedAt: '2026-08-10T15:06:00Z',
      supersededByOccurrenceId:
        'occurrence-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      availableActions: [],
      lifecycleHistory: [
        ...(detail.lifecycleHistory as unknown[]),
        {
          sequence: 3,
          state: 'superseded',
          reasonCode: 'correction_superseded',
          occurredAt: '2026-08-10T15:06:00Z',
          replacementOccurrenceId:
            'occurrence-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        },
      ],
    };
    expect(() => parseInsightOccurrenceDetailV1(superseded)).toThrow(
      'terminal resolution metadata must match'
    );
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...superseded,
        lifecycleHistory: [
          ...(detail.lifecycleHistory as unknown[]),
          {
            sequence: 3,
            state: 'superseded',
            reasonCode: 'correction_superseded',
            occurredAt: '2026-01-01T00:00:00Z',
            replacementOccurrenceId:
              'occurrence-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        ],
      })
    ).toThrow('preceding lifecycle event');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        kind: 'largeTransaction',
        entity: {
          kind: 'transaction',
          sourceRef: 'demo-transaction-v1',
          displayName: 'Demo Transaction',
          identityQuality: 'stableSource',
        },
        baselineSufficiency: 'insufficient',
        reasonCodes: ['adaptive_baseline_agreement'],
      })
    ).toThrow('qualified adaptive insight');
  });

  it('enforces nonnegative dispersion and one currency throughout detail evidence', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    const negativeDispersion = cloneFixture(detail);
    (
      negativeDispersion.baseline as Record<string, unknown>
    ).dispersionMinor = -1;
    expect(() => parseInsightOccurrenceDetailV1(negativeDispersion)).toThrow(
      'dispersionMinor'
    );

    const baselineCurrency = cloneFixture(detail);
    (
      (baselineCurrency.baseline as Record<string, unknown>)
        .expectedRange as Record<string, unknown>
    ).currency = 'EUR';
    expect(() => parseInsightOccurrenceDetailV1(baselineCurrency)).toThrow(
      'must match every monetary value currency'
    );

    const comparisonCurrency = cloneFixture(detail);
    (
      (
        comparisonCurrency.comparisons as Record<string, unknown>[]
      )[0]!.value as Record<string, unknown>
    ).currency = 'EUR';
    expect(() => parseInsightOccurrenceDetailV1(comparisonCurrency)).toThrow(
      'must match every monetary value currency'
    );

    const contributorCurrency = cloneFixture(detail);
    (
      (
        contributorCurrency.contributors as Record<string, unknown>[]
      )[0]!.amount as Record<string, unknown>
    ).currency = 'EUR';
    expect(() => parseInsightOccurrenceDetailV1(contributorCurrency)).toThrow(
      'must match every monetary value currency'
    );
  });

  it('enforces exact minor-unit, date, and UTC timestamp boundaries', async () => {
    const batch = (await loadFixture('transaction-batch')) as Record<
      string,
      unknown
    >;
    const maximum = cloneFixture(batch);
    (maximum.facts as Record<string, unknown>[])[0]!.amountMinor =
      MAX_AMOUNT_MINOR_V1;
    expect(parseSourceFactBatchV1(maximum).facts[0]!.amountMinor).toBe(
      MAX_AMOUNT_MINOR_V1
    );

    const overflow = cloneFixture(maximum);
    (overflow.facts as Record<string, unknown>[])[0]!.amountMinor =
      MAX_AMOUNT_MINOR_V1 + 1;
    expect(() => parseSourceFactBatchV1(overflow)).toThrow(
      'Too big: expected number to be'
    );

    const invalidDate = cloneFixture(batch);
    (invalidDate.facts as Record<string, unknown>[])[0]!.occurredOn =
      '2026-02-30';
    expect(() => parseSourceFactBatchV1(invalidDate)).toThrow(
      'valid ISO 8601 calendar date'
    );
    const maximumMerchant = cloneFixture(batch);
    (
      maximumMerchant.facts as Record<string, unknown>[]
    )[0]!.merchantName = 'M'.repeat(160);
    expect(parseSourceFactBatchV1(maximumMerchant).facts[0]!.merchantName).toHaveLength(
      160
    );
    const controlMerchant = cloneFixture(batch);
    (
      controlMerchant.facts as Record<string, unknown>[]
    )[0]!.merchantName = 'Demo\u0000Merchant';
    expect(() => parseSourceFactBatchV1(controlMerchant)).toThrow(
      'control characters'
    );
    const c1ControlMerchant = cloneFixture(batch);
    (
      c1ControlMerchant.facts as Record<string, unknown>[]
    )[0]!.merchantName = 'Demo\u0085Merchant';
    expect(() => parseSourceFactBatchV1(c1ControlMerchant)).toThrow(
      'control characters'
    );

    const source = (await loadFixture('source-generation-create')) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseSourceGenerationCreateRequestV1({
        ...source,
        sourceAsOf: '2026-08-10T15:00:00-04:00',
      })
    ).toThrow('ending in Z');
    for (const sourceAsOf of [
      '2024-02-30T00:00:00Z',
      '2024-01-01T24:00:00Z',
    ]) {
      expect(() =>
        parseSourceGenerationCreateRequestV1({
          ...(source as Record<string, unknown>),
          sourceAsOf,
        })
      ).toThrow('valid UTC ISO 8601 timestamp');
    }
  });

  it('enforces complete publication manifests and monotonic source identity', async () => {
    const source = (await loadFixture('source-generation-create')) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseSourceGenerationCreateRequestV1({
        ...source,
        sourceSequence: 0,
      })
    ).toThrow('expected number to be >0');

    const duplicateKind = cloneFixture(source);
    (
      duplicateKind.manifest as Record<string, unknown>[]
    )[4]!.kind = 'transaction';
    expect(() => parseSourceGenerationCreateRequestV1(duplicateKind)).toThrow(
      'exactly one entry for every source fact kind'
    );

    const mismatchedCount = cloneFixture(source);
    (
      mismatchedCount.manifest as Record<string, unknown>[]
    )[0]!.itemCount = 2;
    expect(() => parseSourceGenerationCreateRequestV1(mismatchedCount)).toThrow(
      'must match the captured constituent item count'
    );

    const overLimit = cloneFixture(source);
    (
      overLimit.capturedConstituents as Record<string, unknown>[]
    )[0]!.itemCount = 50_001;
    (overLimit.manifest as Record<string, unknown>[])[0]!.itemCount = 50_001;
    expect(() => parseSourceGenerationCreateRequestV1(overLimit)).toThrow(
      'exceeds the transaction generation limit'
    );
    const impossibleBatchCount = cloneFixture(source);
    (
      impossibleBatchCount.capturedConstituents as Record<string, unknown>[]
    )[0]!.itemCount = 251;
    (
      impossibleBatchCount.manifest as Record<string, unknown>[]
    )[0]!.itemCount = 251;
    (
      impossibleBatchCount.manifest as Record<string, unknown>[]
    )[0]!.batchCount = 1;
    expect(() =>
      parseSourceGenerationCreateRequestV1(impossibleBatchCount)
    ).toThrow('cannot hold itemCount within 250-item batches');
    expect(() =>
      parseSourceGenerationCreateRequestV1({
        ...source,
        sourceAsOf: '2026-08-10T15:04:00Z',
      })
    ).toThrow('earliest captured constituent sourceAsOf');
  });

  it('enforces source generation and evaluation result state combinations', () => {
    const generationIdentity = {
      contractVersion: '1.0',
      connectorRef: 'demo-connector-v1',
      sourceGeneration: 'demo-publication-v1',
      sourceSequence: 1,
    };
    expect(
      parseSourceGenerationResultV1({
        ...generationIdentity,
        state: 'staging',
        detectorSetVersion: null,
        policyVersion: null,
      }).state
    ).toBe('staging');
    expect(() =>
      parseSourceGenerationResultV1({
        ...generationIdentity,
        state: 'staging',
        detectorSetVersion: 'detectors-v1',
        policyVersion: 1,
      })
    ).toThrow('Invalid source generation result');

    const evaluationIdentity = {
      householdScope: 'demo-household-v1',
      connectorRef: 'demo-connector-v1',
      sourceGeneration: 'demo-publication-v1',
      detectorSetVersion: 'detectors-v1',
      policyVersion: 1,
    };
    const evaluation = {
      contractVersion: '1.0',
      identity: evaluationIdentity,
      sourceSequence: 1,
      evaluationSequence: 1,
      acceptedAt: '2026-08-10T15:00:00.9Z',
    };
    expect(() =>
      parseEvaluationResultV1({
        ...evaluation,
        state: 'completed',
        completedAt: null,
      })
    ).toThrow('Invalid evaluation result');
    expect(() =>
      parseEvaluationResultV1({
        ...evaluation,
        state: 'completed',
        completedAt: '2026-08-10T15:00:00Z',
      })
    ).toThrow('must be on or after acceptedAt');
  });

  it('rejects duplicate facts and short idempotency keys', async () => {
    const batch = (await loadFixture('transaction-batch')) as Record<
      string,
      unknown
    >;
    const duplicate = cloneFixture(batch);
    duplicate.facts = [
      ...(duplicate.facts as unknown[]),
      ...(duplicate.facts as unknown[]),
    ];
    expect(() => parseSourceFactBatchV1(duplicate)).toThrow(
      'unique source references'
    );
    expect(() =>
      parseSourceFactBatchV1({ ...batch, idempotencyKey: 'too-short' })
    ).toThrow('expected string to have >=16 characters');
  });

  it('allows only typed target descriptors and supplies typed root fallbacks', () => {
    const transaction = parseExternalTargetV1({
      system: 'monarch',
      targetKind: 'transaction',
      sourceRef: 'demo-transaction-v1',
    });
    expect(fallbackTargetForV1(transaction)).toEqual({
      system: 'monarch',
      targetKind: 'safeRoot',
      root: 'transactions',
    });
    expect(
      fallbackTargetForV1({
        system: 'owl',
        targetKind: 'document',
        sourceRef: 'demo-document-v1',
      })
    ).toBeNull();
    expect(() =>
      parseExternalTargetV1({
        system: 'monarch',
        targetKind: 'transaction',
        sourceRef: 'demo-transaction-v1',
        url: 'https://example.invalid/not-accepted',
      })
    ).toThrow('Invalid external target');
    expect(() =>
      parseExternalTargetV1({
        system: 'monarch',
        targetKind: 'reportFilter',
        reportKind: 'spending',
        period: { start: '2026-08-01', end: '2026-08-10' },
        categorySourceRef: 'demo-category-v1',
        merchantKey:
          'merchant-v1_MA7tNq3wBGNLc3rAt-1ggnuPXkD7D9De-Zlgq2MFdPM',
      })
    ).toThrow('not both');

    const allowlisted = [
      transaction,
      {
        system: 'monarch',
        targetKind: 'recurring',
        sourceRef: 'demo-recurring-v1',
      },
      {
        system: 'monarch',
        targetKind: 'reportFilter',
        reportKind: 'spending',
        period: { start: '2026-08-01', end: '2026-08-10' },
        categorySourceRef: null,
        merchantKey:
          'merchant-v1_MA7tNq3wBGNLc3rAt-1ggnuPXkD7D9De-Zlgq2MFdPM',
      },
      {
        system: 'monarch',
        targetKind: 'safeRoot',
        root: 'reports',
      },
      {
        system: 'owl',
        targetKind: 'document',
        sourceRef: 'demo-document-v1',
      },
    ];
    expect(allowlisted.map(parseExternalTargetV1)).toEqual(allowlisted);
  });

  it('requires undo for active timed suppression and prohibits a competing suppress action', async () => {
    const detail = (await loadFixture('occurrence-detail')) as Record<
      string,
      unknown
    >;
    const active = {
      state: 'active',
      suppressionId: 'demo-suppression-v1',
      scope: 'entity',
      durationDays: 90,
      operator: 'fixedLocalOperator',
      createdAt: '2026-08-10T15:06:00Z',
      expiresAt: '2026-11-08T15:06:00Z',
      undoneAt: null,
    };
    expect(
      parseInsightOccurrenceDetailV1({
        ...detail,
        suppression: active,
        availableActions: ['expected', 'notUseful', 'undoSuppression'],
      }).suppression.state
    ).toBe('active');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        suppression: active,
        availableActions: ['expected', 'notUseful'],
      })
    ).toThrow('must include undoSuppression');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        suppression: active,
        availableActions: ['undoSuppression', 'suppress180Days'],
      })
    ).toThrow('must not offer another suppression');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        suppression: {
          ...active,
          state: 'none',
          suppressionId: null,
        },
        availableActions: [
          'expected',
          'notUseful',
          'suppress30Days',
          'suppress90Days',
          'suppress180Days',
        ],
      })
    ).toThrow('must be null when state is none');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        suppression: {
          ...active,
          state: 'expired',
          undoneAt: '2026-08-11T15:06:00Z',
        },
        availableActions: [
          'expected',
          'notUseful',
          'suppress30Days',
          'suppress90Days',
          'suppress180Days',
        ],
      })
    ).toThrow('must be null for an expired suppression');
    expect(() =>
      parseInsightOccurrenceDetailV1({
        ...detail,
        suppression: {
          ...active,
          durationDays: 30,
          expiresAt: '2026-08-10T15:07:00Z',
        },
        availableActions: ['expected', 'notUseful', 'undoSuppression'],
      })
    ).toThrow('selected durationDays');
  });

  it('bounds filters, rejects duplicate enums, and supplies the approved defaults', () => {
    expect(defaultOccurrenceListQueryV1()).toEqual({
      kind: [],
      sourceLifecycle: ['open'],
      analysisState: ['qualified'],
      severity: [],
      baselineSufficiency: [],
      connectorRef: null,
      updatedAfter: null,
      limit: 50,
      cursor: null,
    });
    expect(() =>
      parseOccurrenceListQueryV1({
        ...defaultOccurrenceListQueryV1(),
        severity: ['high', 'high'],
      })
    ).toThrow('unique values');
    expect(() =>
      parseOccurrenceListQueryV1({
        ...defaultOccurrenceListQueryV1(),
        limit: 101,
      })
    ).toThrow('expected number to be <=100');
  });

  it('pins the public contract version', () => {
    expect(FINANCE_INSIGHTS_CONTRACT_VERSION).toBe('1.0');
  });
});
