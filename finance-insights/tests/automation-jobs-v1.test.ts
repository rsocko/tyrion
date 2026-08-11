import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FinanceAutomationIdempotencyConflictError,
  FinanceAutomationJobServiceV1,
  FinanceAutomationSqliteStoreV1,
  createCandidateAutomationPolicyV1,
  createCandidatePolicySnapshotV1,
  parseFinanceAutomationJobRequestV1,
  parseFinanceAutomationPolicyV1,
  type ConnectorHealthJobRequestV1,
  type DuplicateTransactionJobRequestV1,
  type FinanceAutomationPolicyV1,
  type FinanceInsightPolicySnapshotV1,
  type SourceGenerationCreateRequestV1,
  type TransactionSourceFactV1,
} from '../src/index.js';

const IDENTITY_KEY = Buffer.alloc(32, 41);
const DIGEST = `sha256:${'0'.repeat(64)}`;
const directories: string[] = [];
const openStores = new Set<FinanceAutomationSqliteStoreV1>();

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable finance automation jobs v1', () => {
  it('persists one stable duplicate signal and makes exact replay delivery-free', async () => {
    const harness = createHarness();
    const request = duplicateRequest({
      transactions: [
        transaction('invented-a', '2026-08-10'),
        transaction('invented-b', '2026-08-10'),
      ],
    });

    const first = await harness.service.run(request);
    const replay = await harness.service.run(request);

    expect(first).toMatchObject({
      status: 'completed',
      candidateCount: 1,
      replayed: false,
      deliveries: [{ target: 'notification', action: 'create' }],
      signals: [
        {
          state: 'open',
          kind: 'duplicateTransaction',
          freshness: 'fresh',
          confidence: 'high',
          attention: 'actionable',
          reasonCodes: ['duplicate_exact_match'],
          relatedSourceRefs: ['invented-a', 'invented-b'],
          evidence: {
            sameAmount: true,
            sameMerchant: true,
            sameAccount: true,
            dateGapDays: 0,
          },
          provenance: {
            providerClass: 'monarchBridgeNormalized',
            sourceGeneration: 'invented-generation-1',
            sourceAsOf: '2026-08-10T12:00:00Z',
            detectorVersion: 'duplicate-transaction-detector-v1',
          },
        },
      ],
    });
    expect(replay.runId).toBe(first.runId);
    expect(replay.signals[0]?.signalId).toBe(first.signals[0]?.signalId);
    expect(replay).toMatchObject({
      replayed: true,
      deliveries: [
        {
          deliveryKey: first.deliveries[0]!.deliveryKey,
          version: 1,
          action: 'create',
        },
      ],
    });
    await acknowledge(harness.service, replay, '2026-08-10T12:06:00Z');
    expect((await harness.service.run(request)).deliveries).toEqual([]);
    closeStore(harness.store);
  });

  it('does not redeliver an unchanged duplicate signal on a later schedule', async () => {
    const harness = createHarness();
    const transactions = [
      transaction('repeat-a', '2026-08-10'),
      transaction('repeat-b', '2026-08-10'),
    ];
    const first = await harness.service.run(duplicateRequest({ transactions }));
    await acknowledge(harness.service, first, '2026-08-10T12:06:00Z');
    const next = await harness.service.run(
      duplicateRequest({
        transactions: [...transactions].reverse(),
        scheduledFor: '2026-08-10T13:05:00Z',
        evaluatedAt: '2026-08-10T13:05:00Z',
        sourceAsOf: '2026-08-10T12:00:00.000Z',
      })
    );

    expect(next.signals[0]?.signalId).toBe(first.signals[0]?.signalId);
    expect(next).toMatchObject({
      status: 'completed',
      replayed: false,
      deliveries: [],
    });
    closeStore(harness.store);
  });

  it('suppresses configured expected pairs, connector retries, and non-spend facts', async () => {
    const harness = createHarness();
    const request = duplicateRequest({
      transactions: [
        transaction('expected-a', '2026-08-10'),
        transaction('expected-b', '2026-08-10'),
        transaction('retry-a', '2026-08-10', { merchantName: 'Retry Merchant' }),
        transaction('retry-b', '2026-08-10', { merchantName: 'Retry Merchant' }),
        transaction('pending-a', '2026-08-10', {
          merchantName: 'Pending Merchant',
          isPending: true,
        }),
        transaction('pending-b', '2026-08-10', {
          merchantName: 'Pending Merchant',
          isPending: true,
        }),
      ],
      suppressedPairs: [
        {
          sourceRefs: ['expected-b', 'expected-a'],
          reason: 'expectedDuplicate',
        },
        {
          sourceRefs: ['retry-a', 'retry-b'],
          reason: 'connectorRetry',
        },
      ],
    });

    const result = await harness.service.run(request);

    expect(result.signals).toHaveLength(0);
    expect(result.exclusionSummary).toMatchObject({
      connector_retry_excluded: 1,
      expected_duplicate_excluded: 1,
      pending_excluded: 2,
    });
    closeStore(harness.store);
  });

  it('does not settle reliable duplicate attention from a stale generation', async () => {
    const harness = createHarness();
    const first = await harness.service.run(
      duplicateRequest({
        transactions: [
          transaction('stale-a', '2026-08-10'),
          transaction('stale-b', '2026-08-10'),
        ],
      })
    );
    const signalId = first.signals[0]!.signalId;
    await acknowledge(harness.service, first, '2026-08-10T12:06:00Z');
    const stale = await harness.service.run(
      duplicateRequest({
        scheduledFor: '2026-08-13T13:00:00Z',
        evaluatedAt: '2026-08-13T13:00:00Z',
        sourceAsOf: '2026-08-10T12:00:00Z',
        generation: 2,
        transactions: [transaction('other', '2026-08-13')],
      })
    );

    expect(stale).toMatchObject({
      status: 'skipped',
      skipReason: 'source_stale',
      signals: [],
      deliveries: [],
    });
    expect(harness.store.getSignal(signalId)?.state).toBe('open');
    closeStore(harness.store);
  });

  it('settles prior duplicate attention when a fresh generation removes the pair', async () => {
    const harness = createHarness();
    const first = await harness.service.run(
      duplicateRequest({
        transactions: [
          transaction('settle-a', '2026-08-10'),
          transaction('settle-b', '2026-08-10'),
        ],
      })
    );
    const signalId = first.signals[0]!.signalId;
    await acknowledge(harness.service, first, '2026-08-10T12:06:00Z');
    const recovered = await harness.service.run(
      duplicateRequest({
        scheduledFor: '2026-08-11T12:05:00Z',
        evaluatedAt: '2026-08-11T12:05:00Z',
        sourceAsOf: '2026-08-11T12:00:00Z',
        generation: 2,
        transactions: [transaction('settle-a', '2026-08-10')],
      })
    );

    expect(recovered).toMatchObject({
      status: 'completed',
      deliveries: [{ signalId, target: 'notification', action: 'settle' }],
      signals: [
        {
          signalId,
          state: 'settled',
          settledAt: '2026-08-11T12:05:00Z',
          reasonCodes: expect.arrayContaining(['condition_recovered']),
          provenance: {
            sourceGeneration: 'invented-generation-2',
            sourceAsOf: '2026-08-11T12:00:00Z',
          },
        },
      ],
    });
    closeStore(harness.store);
  });

  it('does not settle a duplicate that is outside a newer generation coverage window', async () => {
    const harness = createHarness();
    const first = await harness.service.run(
      duplicateRequest({
        transactions: [
          transaction('coverage-a', '2026-08-10'),
          transaction('coverage-b', '2026-08-10'),
        ],
      })
    );
    await acknowledge(harness.service, first, '2026-08-10T12:06:00Z');
    const signalId = first.signals[0]!.signalId;

    const reducedCoverage = await harness.service.run(
      duplicateRequest({
        generation: 2,
        scheduledFor: '2026-08-11T12:05:00Z',
        evaluatedAt: '2026-08-11T12:05:00Z',
        sourceAsOf: '2026-08-11T12:00:00Z',
        coverageStart: '2026-08-11',
        coverageEnd: '2026-08-31',
        transactions: [transaction('coverage-current', '2026-08-11')],
      })
    );

    expect(reducedCoverage).toMatchObject({
      status: 'completed',
      signals: [],
      deliveries: [],
    });
    expect(harness.store.getSignal(signalId)?.state).toBe('open');
    closeStore(harness.store);
  });

  it('retains a compensating settle when recovery races an unacknowledged create', async () => {
    const harness = createHarness();
    const first = await harness.service.run(
      duplicateRequest({
        transactions: [
          transaction('cancel-a', '2026-08-10'),
          transaction('cancel-b', '2026-08-10'),
        ],
      })
    );
    const recovered = await harness.service.run(
      duplicateRequest({
        generation: 2,
        scheduledFor: '2026-08-11T12:05:00Z',
        evaluatedAt: '2026-08-11T12:05:00Z',
        sourceAsOf: '2026-08-11T12:00:00Z',
        transactions: [transaction('cancel-a', '2026-08-10')],
      })
    );

    expect(recovered).toMatchObject({
      signals: [{ state: 'settled' }],
      deliveries: [{ version: 2, action: 'settle' }],
    });
    const staleAck = await harness.service.acknowledgeDeliveries({
      contractVersion: '1.0',
      acknowledgedAt: '2026-08-11T12:06:00Z',
      deliveries: [
        {
          deliveryKey: first.deliveries[0]!.deliveryKey,
          expectedVersion: first.deliveries[0]!.version,
        },
      ],
    });
    expect(staleAck.conflicts).toEqual([first.deliveries[0]!.deliveryKey]);
    closeStore(harness.store);
  });

  it('routes adjacent-date duplicate evidence to notification attention', async () => {
    const harness = createHarness();
    const result = await harness.service.run(
      duplicateRequest({
        transactions: [
          transaction('adjacent-a', '2026-08-09'),
          transaction('adjacent-b', '2026-08-10'),
        ],
      })
    );

    expect(result).toMatchObject({
      deliveries: [{ target: 'notification', action: 'create' }],
      signals: [
        {
          confidence: 'medium',
          attention: 'informational',
          reasonCodes: ['duplicate_adjacent_date_match'],
          evidence: { dateGapDays: 1 },
        },
      ],
    });
    closeStore(harness.store);
  });

  it('escalates health failures without advancing source freshness and settles on recovery', async () => {
    const harness = createHarness();
    const degraded = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T13:00:00Z',
        evaluatedAt: '2026-08-10T13:00:00Z',
        observedAt: '2026-08-10T12:59:00Z',
        state: 'degraded',
        lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
        consecutiveFailures: 1,
      })
    );
    const signalId = degraded.signals[0]!.signalId;
    await acknowledge(harness.service, degraded, '2026-08-10T13:01:00Z');
    const failed = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T14:00:00Z',
        evaluatedAt: '2026-08-10T14:00:00Z',
        observedAt: '2026-08-10T13:59:00Z',
        state: 'unavailable',
        lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
        consecutiveFailures: 3,
      })
    );
    await acknowledge(harness.service, failed, '2026-08-10T14:01:00Z');
    const outOfOrderRecovery = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T14:05:00Z',
        evaluatedAt: '2026-08-10T14:05:00Z',
        observedAt: '2026-08-10T13:30:00Z',
        state: 'connected',
        lastSuccessfulSyncAt: '2026-08-10T13:30:00Z',
        consecutiveFailures: 0,
      })
    );
    expect(outOfOrderRecovery).toMatchObject({
      status: 'ignored',
      skipReason: 'out_of_order_observation',
      deliveries: [],
    });
    expect(harness.store.getSignal(signalId)?.state).toBe('open');
    const recoveredRequest = healthRequest({
      scheduledFor: '2026-08-10T15:00:00Z',
      evaluatedAt: '2026-08-10T15:00:00Z',
      observedAt: '2026-08-10T14:59:00Z',
      state: 'connected',
      lastSuccessfulSyncAt: '2026-08-10T14:58:00Z',
      consecutiveFailures: 0,
    });
    const recovered = await harness.service.run(recoveredRequest);
    const recoveredReplay = await harness.service.run(recoveredRequest);

    expect(degraded).toMatchObject({
      sourceAsOf: '2026-08-10T12:00:00Z',
      deliveries: [{ target: 'notification', action: 'create' }],
      signals: [{ reasonCodes: ['connector_reported_degraded'] }],
    });
    expect(failed).toMatchObject({
      sourceAsOf: '2026-08-10T12:00:00Z',
      deliveries: [{ target: 'notification', action: 'update' }],
      signals: [
        {
          signalId,
          attention: 'actionable',
          reasonCodes: expect.arrayContaining([
            'connector_reported_unavailable',
            'connector_repeated_failures',
          ]),
          provenance: { sourceAsOf: '2026-08-10T12:00:00Z' },
        },
      ],
    });
    expect(harness.store.getSignal(signalId)?.state).toBe('settled');
    expect(recovered).toMatchObject({
      deliveries: [{ signalId, target: 'notification', action: 'settle' }],
      signals: [
        {
          state: 'settled',
          freshness: 'fresh',
          provenance: { sourceAsOf: '2026-08-10T14:58:00Z' },
        },
      ],
    });
    expect(recoveredReplay).toMatchObject({
      replayed: true,
      deliveries: [{ version: 3, action: 'settle' }],
    });
    await acknowledge(harness.service, recovered, '2026-08-10T15:01:00Z');
    expect((await harness.service.run(recoveredRequest)).deliveries).toEqual([]);
    closeStore(harness.store);
  });

  it('rejects a truncated complete duplicate source generation', () => {
    const complete = duplicateRequest({
      transactions: [
        transaction('complete-a', '2026-08-10'),
        transaction('complete-b', '2026-08-10'),
      ],
    });

    expect(() =>
      parseFinanceAutomationJobRequestV1({
        ...complete,
        transactions: [complete.transactions[0]],
      })
    ).toThrow(/every transaction declared by a complete source generation/);
  });

  it('ignores an older duplicate source sequence without settling newer attention', async () => {
    const harness = createHarness();
    const current = await harness.service.run(
      duplicateRequest({
        generation: 2,
        transactions: [
          transaction('ordered-a', '2026-08-10'),
          transaction('ordered-b', '2026-08-10'),
        ],
      })
    );
    await acknowledge(harness.service, current, '2026-08-10T12:06:00Z');
    const signalId = current.signals[0]!.signalId;

    const older = await harness.service.run(
      duplicateRequest({
        generation: 1,
        scheduledFor: '2026-08-10T13:05:00Z',
        evaluatedAt: '2026-08-10T13:05:00Z',
        transactions: [transaction('ordered-a', '2026-08-10')],
      })
    );

    expect(older).toMatchObject({
      status: 'ignored',
      skipReason: 'out_of_order_source_generation',
      candidateCount: 0,
      deliveries: [],
    });
    expect(harness.store.getSignal(signalId)?.state).toBe('open');
    closeStore(harness.store);
  });

  it('rebases unavailable health provenance to the persisted successful-sync watermark', async () => {
    const harness = createHarness();
    const healthy = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T12:05:00Z',
        evaluatedAt: '2026-08-10T12:05:00Z',
        observedAt: '2026-08-10T12:04:00Z',
        state: 'connected',
        lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
        consecutiveFailures: 0,
      })
    );
    expect(healthy.signals).toEqual([]);

    const unavailable = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T13:05:00Z',
        evaluatedAt: '2026-08-10T13:05:00Z',
        observedAt: '2026-08-10T13:04:00Z',
        state: 'unavailable',
        lastSuccessfulSyncAt: null,
        consecutiveFailures: 1,
      })
    );

    expect(unavailable).toMatchObject({
      sourceAsOf: '2026-08-10T12:00:00Z',
      signals: [
        {
          freshness: 'fresh',
          reasonCodes: ['connector_reported_unavailable'],
          provenance: { sourceAsOf: '2026-08-10T12:00:00Z' },
          evidence: { sourceAgeHours: 1 },
        },
      ],
    });
    closeStore(harness.store);
  });

  it('does not settle health attention from a conflicting equal-time observation', async () => {
    const harness = createHarness();
    const unhealthy = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T13:00:00Z',
        evaluatedAt: '2026-08-10T13:00:00Z',
        observedAt: '2026-08-10T12:59:00Z',
        state: 'degraded',
        lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
        consecutiveFailures: 1,
      })
    );
    await acknowledge(harness.service, unhealthy, '2026-08-10T13:01:00Z');
    const signalId = unhealthy.signals[0]!.signalId;

    const conflicting = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T14:00:00Z',
        evaluatedAt: '2026-08-10T14:00:00Z',
        observedAt: '2026-08-10T12:59:00Z',
        state: 'connected',
        lastSuccessfulSyncAt: '2026-08-10T12:58:00Z',
        consecutiveFailures: 0,
      })
    );

    expect(conflicting).toMatchObject({
      status: 'ignored',
      skipReason: 'out_of_order_observation',
      deliveries: [],
    });
    expect(harness.store.getSignal(signalId)?.state).toBe('open');
    closeStore(harness.store);
  });

  it('keeps a superseding outbox version pending until that version is acknowledged', async () => {
    const harness = createHarness();
    const firstRequest = healthRequest({
      scheduledFor: '2026-08-10T13:00:00Z',
      evaluatedAt: '2026-08-10T13:00:00Z',
      observedAt: '2026-08-10T12:59:00Z',
      state: 'degraded',
      lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
      consecutiveFailures: 1,
    });
    const first = await harness.service.run(firstRequest);
    const secondRequest = healthRequest({
      scheduledFor: '2026-08-10T14:00:00Z',
      evaluatedAt: '2026-08-10T14:00:00Z',
      observedAt: '2026-08-10T13:59:00Z',
      state: 'unavailable',
      lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
      consecutiveFailures: 3,
    });
    const second = await harness.service.run(secondRequest);

    expect(second.deliveries).toMatchObject([{ version: 2, action: 'create' }]);
    const staleReplay = await harness.service.run(firstRequest);
    expect(staleReplay).toMatchObject({
      replayed: true,
      signals: [
        {
          attention: 'informational',
          evidence: { reportedState: 'degraded' },
        },
      ],
      deliveries: [
        {
          version: 2,
          action: 'create',
          signal: {
            attention: 'actionable',
            evidence: { reportedState: 'unavailable' },
          },
        },
      ],
    });
    const staleAck = await harness.service.acknowledgeDeliveries({
      contractVersion: '1.0',
      acknowledgedAt: '2026-08-10T14:01:00Z',
      deliveries: [
        {
          deliveryKey: first.deliveries[0]!.deliveryKey,
          expectedVersion: first.deliveries[0]!.version,
        },
      ],
    });
    expect(staleAck).toMatchObject({
      acknowledged: [],
      conflicts: [first.deliveries[0]!.deliveryKey],
    });
    expect((await harness.service.run(secondRequest)).deliveries).toMatchObject([
      { version: 2, action: 'create' },
    ]);
    await acknowledge(harness.service, second, '2026-08-10T14:02:00Z');
    expect((await harness.service.run(secondRequest)).deliveries).toEqual([]);
    closeStore(harness.store);
  });

  it('rejects different input for the same stable scheduled run identity', async () => {
    const harness = createHarness();
    const first = healthRequest({
      scheduledFor: '2026-08-10T13:00:00Z',
      evaluatedAt: '2026-08-10T13:00:00Z',
      observedAt: '2026-08-10T12:59:00Z',
      state: 'degraded',
      lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
      consecutiveFailures: 1,
    });
    await harness.service.run(first);

    await expect(
      harness.service.run({
        ...first,
        observation: { ...first.observation, consecutiveFailures: 2 },
      })
    ).rejects.toBeInstanceOf(FinanceAutomationIdempotencyConflictError);
    closeStore(harness.store);
  });

  it('treats a later retry time as replay of the same durable scheduled input', async () => {
    const harness = createHarness();
    const request = healthRequest({
      scheduledFor: '2026-08-10T13:00:00Z',
      evaluatedAt: '2026-08-10T13:00:00Z',
      observedAt: '2026-08-10T12:59:00Z',
      state: 'degraded',
      lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
      consecutiveFailures: 1,
    });
    const first = await harness.service.run(request);
    const retry = await harness.service.run({
      ...request,
      evaluatedAt: '2026-08-10T13:05:00Z',
    });

    expect(retry).toMatchObject({
      runId: first.runId,
      completedAt: first.completedAt,
      replayed: true,
      deliveries: [{ version: 1, action: 'create' }],
    });
    closeStore(harness.store);
  });

  it('replays equivalent durable input ordering and UTC timestamp forms', async () => {
    const harness = createHarness();
    const request = duplicateRequest({
      transactions: [
        transaction('ordered-a', '2026-08-10', {
          tagRefs: ['invented-tag-b', 'invented-tag-a'],
        }),
        transaction('ordered-b', '2026-08-10'),
        transaction('ordered-c', '2026-08-10', {
          merchantName: 'Other Invented Merchant',
        }),
        transaction('ordered-d', '2026-08-10', {
          merchantName: 'Other Invented Merchant',
        }),
      ],
      suppressedPairs: [
        {
          sourceRefs: ['ordered-a', 'ordered-b'],
          reason: 'expectedDuplicate',
        },
        {
          sourceRefs: ['ordered-c', 'ordered-d'],
          reason: 'connectorRetry',
        },
      ],
    });
    const first = await harness.service.run(request);
    const replay = await harness.service.run({
      ...request,
      scheduledFor: '2026-08-10T12:05:00.000Z',
      source: {
        ...request.source,
        sourceAsOf: '2026-08-10T12:00:00.000Z',
        capturedConstituents: [...request.source.capturedConstituents]
          .reverse()
          .map((constituent) => ({
            ...constituent,
            sourceAsOf: '2026-08-10T12:00:00.000Z',
          })),
        manifest: [...request.source.manifest].reverse(),
      },
      transactions: [...request.transactions]
        .reverse()
        .map((item) => ({ ...item, tagRefs: [...item.tagRefs].reverse() })),
      suppressedPairs: [...request.suppressedPairs].reverse(),
      insightPolicy: {
        ...request.insightPolicy,
        effectiveAt: '2026-08-01T00:00:00.000Z',
      },
    });

    expect(replay).toMatchObject({
      runId: first.runId,
      replayed: true,
    });
    closeStore(harness.store);
  });

  it('accepts equivalent health timestamp forms at the same source watermark', async () => {
    const harness = createHarness();
    const first = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T13:00:00Z',
        evaluatedAt: '2026-08-10T14:00:00Z',
        observedAt: '2026-08-10T12:59:00Z',
        state: 'degraded',
        lastSuccessfulSyncAt: '2026-08-10T12:00:00Z',
        consecutiveFailures: 1,
      })
    );
    const equivalent = await harness.service.run(
      healthRequest({
        scheduledFor: '2026-08-10T13:30:00.000Z',
        evaluatedAt: '2026-08-10T14:00:00.000Z',
        observedAt: '2026-08-10T12:59:00.000Z',
        state: 'degraded',
        lastSuccessfulSyncAt: '2026-08-10T12:00:00.000Z',
        consecutiveFailures: 1,
      })
    );

    expect(equivalent).toMatchObject({
      status: 'completed',
      skipReason: null,
      replayed: false,
      deliveries: [{ version: 1, action: 'create' }],
    });
    expect(equivalent.signals[0]?.signalId).toBe(first.signals[0]?.signalId);
    closeStore(harness.store);
  });

  it('replays persisted run identity after a store restart', async () => {
    const harness = createHarness();
    const request = duplicateRequest({
      transactions: [
        transaction('restart-a', '2026-08-10'),
        transaction('restart-b', '2026-08-10'),
      ],
    });
    const first = await harness.service.run(request);
    closeStore(harness.store);
    const restartedStore = new FinanceAutomationSqliteStoreV1({
      path: harness.path,
    });
    openStores.add(restartedStore);
    const restartedService = new FinanceAutomationJobServiceV1({
      store: restartedStore,
      identityKey: IDENTITY_KEY,
    });

    const replay = await restartedService.run(request);

    expect(replay).toMatchObject({
      runId: first.runId,
      replayed: true,
      deliveries: [{ version: 1, action: 'create' }],
    });
    closeStore(restartedStore);
  });
});

function createHarness(): {
  path: string;
  store: FinanceAutomationSqliteStoreV1;
  service: FinanceAutomationJobServiceV1;
} {
  const directory = mkdtempSync(join(tmpdir(), 'tyrion-automation-'));
  directories.push(directory);
  const path = join(directory, 'state.sqlite');
  const store = new FinanceAutomationSqliteStoreV1({ path });
  openStores.add(store);
  return {
    path,
    store,
    service: new FinanceAutomationJobServiceV1({
      store,
      identityKey: IDENTITY_KEY,
    }),
  };
}

function closeStore(store: FinanceAutomationSqliteStoreV1): void {
  store.close();
  openStores.delete(store);
}

async function acknowledge(
  service: FinanceAutomationJobServiceV1,
  result: { deliveries: readonly { deliveryKey: string; version: number }[] },
  acknowledgedAt: string
): Promise<void> {
  if (result.deliveries.length === 0) return;
  const acknowledgement = await service.acknowledgeDeliveries({
    contractVersion: '1.0',
    acknowledgedAt,
    deliveries: result.deliveries.map((delivery) => ({
      deliveryKey: delivery.deliveryKey,
      expectedVersion: delivery.version,
    })),
  });
  expect(acknowledgement.conflicts).toEqual([]);
}

function duplicateRequest(options: {
  transactions: TransactionSourceFactV1[];
  suppressedPairs?: {
    sourceRefs: [string, string];
    reason: 'expectedDuplicate' | 'connectorRetry';
  }[];
  scheduledFor?: string;
  evaluatedAt?: string;
  sourceAsOf?: string;
  generation?: number;
  coverageStart?: string;
  coverageEnd?: string;
}): DuplicateTransactionJobRequestV1 {
  const sourceAsOf = options.sourceAsOf ?? '2026-08-10T12:00:00Z';
  const generation = options.generation ?? 1;
  return parseFinanceAutomationJobRequestV1({
    contractVersion: '1.0',
    jobKind: 'duplicateTransactions',
    connectorRef: 'invented-connector',
    scheduledFor: options.scheduledFor ?? '2026-08-10T12:05:00Z',
    evaluatedAt: options.evaluatedAt ?? '2026-08-10T12:05:00Z',
    sourceCompleteness: 'complete',
    source: sourceRequest(
      generation,
      sourceAsOf,
      options.transactions.length,
      options.coverageStart,
      options.coverageEnd
    ),
    transactions: options.transactions,
    suppressedPairs: options.suppressedPairs ?? [],
    insightPolicy: insightPolicy(generation),
    automationPolicy: automationPolicy(generation),
  }) as DuplicateTransactionJobRequestV1;
}

function healthRequest(options: {
  scheduledFor: string;
  evaluatedAt: string;
  observedAt: string;
  state: 'connected' | 'degraded' | 'unavailable';
  lastSuccessfulSyncAt: string | null;
  consecutiveFailures: number;
}): ConnectorHealthJobRequestV1 {
  return parseFinanceAutomationJobRequestV1({
    contractVersion: '1.0',
    jobKind: 'connectorHealth',
    connectorRef: 'invented-connector',
    scheduledFor: options.scheduledFor,
    evaluatedAt: options.evaluatedAt,
    observation: {
      observedAt: options.observedAt,
      state: options.state,
      lastSuccessfulSyncAt: options.lastSuccessfulSyncAt,
      consecutiveFailures: options.consecutiveFailures,
      bridgeContractVersion: 'bridge-v1',
    },
    automationPolicy: automationPolicy(1),
  }) as ConnectorHealthJobRequestV1;
}

function automationPolicy(policyVersion: number): FinanceAutomationPolicyV1 {
  const candidate = createCandidateAutomationPolicyV1(policyVersion);
  return parseFinanceAutomationPolicyV1({
    ...candidate,
    duplicateTransactions: {
      ...candidate.duplicateTransactions,
      enabled: true,
    },
    connectorHealth: {
      ...candidate.connectorHealth,
      enabled: true,
    },
  });
}

function insightPolicy(policyVersion: number): FinanceInsightPolicySnapshotV1 {
  return createCandidatePolicySnapshotV1({
    policyVersion,
    effectiveAt: `2026-08-${String(policyVersion).padStart(2, '0')}T00:00:00Z`,
    currency: 'USD',
    timezone: 'UTC',
  });
}

function sourceRequest(
  generation: number,
  sourceAsOf: string,
  transactionCount: number,
  coverageStart = '2026-08-01',
  coverageEnd = '2026-08-31'
): SourceGenerationCreateRequestV1 {
  const kinds = [
    'transaction',
    'recurring',
    'category',
    'account',
    'tag',
  ] as const;
  return {
    contractVersion: '1.0',
    connectorRef: 'invented-connector',
    sourceGeneration: `invented-generation-${generation}`,
    sourceSequence: generation,
    sourceAsOf,
    coverageStart,
    coverageEnd,
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    capturedConstituents: kinds.map((kind) => ({
      kind,
      generationRef: `invented-${kind}-generation-${generation}`,
      sourceAsOf,
      itemCount: kind === 'transaction' ? transactionCount : 0,
      digest: DIGEST,
    })),
    manifest: kinds.map((kind) => ({
      kind,
      batchCount: kind === 'transaction' && transactionCount > 0 ? 1 : 0,
      itemCount: kind === 'transaction' ? transactionCount : 0,
      digest: DIGEST,
    })),
    idempotencyKey: `invented-generation-key-${generation}`,
  };
}

function transaction(
  sourceRef: string,
  occurredOn: string,
  overrides: Partial<TransactionSourceFactV1> = {}
): TransactionSourceFactV1 {
  return {
    sourceRef,
    occurredOn,
    amountMinor: -12_345,
    merchantName: 'Invented Merchant',
    categoryRef: 'invented-category',
    accountRef: 'invented-account',
    isPending: false,
    recurringRef: null,
    tagRefs: [],
    ...overrides,
  };
}
