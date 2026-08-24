import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
  FinanceInsightLifecycleServiceV1,
  FinanceInsightSqliteStoreV1,
  FinanceInsightStoreError,
  canonicalDigestV1,
  createCandidatePolicySnapshotV1,
  evaluateRecurringAmountDetectorV1,
  parseFinanceInsightPolicySnapshotV1,
  parseInsightOccurrenceDetailV1,
  parseSourceFactBatchV1,
  parseSourceGenerationCreateRequestV1,
  sourceBatchDigestV1,
  sourceManifestDigestV1,
  sourceManifestKindDigestV1,
  type AssignedEvaluationV1,
  type EvaluationPublicationV1,
  type InsightOccurrenceDetailV1,
  type InsightOccurrenceSummaryV1,
  type SourceFactBatchV1,
  type SourceFactKindV1,
  type SourceGenerationCreateRequestV1,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

const temporaryDirectories: string[] = [];
const activeStores: FinanceInsightSqliteStoreV1[] = [];

afterEach(() => {
  for (const store of activeStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may have explicitly closed the store before reopening it.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite migrations and staged source publication', () => {
  it('publishes recurring detector output from only the promoted projection', async () => {
    const harness = await createHarness({
      policy: { recurringAmountAnalysis: true },
    });
    const recurringRef = 'demo-recurring-sequence-1';
    const recurringTransaction = (
      suffix: string,
      occurredOn: string,
      amountMinor: number
    ) => ({
      ...transactionFact(suffix, amountMinor, { recurringRef }),
      occurredOn,
      merchantName: 'Demo Utility',
    });
    const source = makePublication(1, '2026-08-10T15:00:00Z', [
      recurringTransaction('current', '2026-08-10', -28_640),
      recurringTransaction('2025-07', '2025-07-10', -20_000),
      recurringTransaction('2025-08', '2025-08-10', -20_000),
      recurringTransaction('2025-09', '2025-09-10', -20_000),
      recurringTransaction('2024-07', '2024-07-10', -20_000),
      recurringTransaction('2024-08', '2024-08-10', -20_000),
      recurringTransaction('2024-09', '2024-09-10', -20_000),
    ]);
    const committed = await publish(harness, source);
    const policy = (await harness.store.policies.current())!;
    const detector = await evaluateRecurringAmountDetectorV1({
      projectionLoader: harness.store,
      evidence: harness.store.documentEvidence,
      source: {
        connectorRef: source.request.connectorRef,
        sourceGeneration: source.request.sourceGeneration,
        sourceAsOf: source.request.sourceAsOf,
        coverageStart: source.request.coverageStart,
        coverageEnd: source.request.coverageEnd,
        currency: source.request.currency,
        bridgeContractVersion: source.request.bridgeContractVersion,
        completeness: 'complete',
      },
      assignment: committed.evaluation!.assignment,
      policy,
      identityNamespace: Buffer.alloc(32, 19),
      completedAt: harness.clock.value,
    });

    expect(detector.publication).not.toBeNull();
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      detector.terminalResult,
      detector.publication!
    );
    const occurrenceId = detector.analyses[0]!.occurrenceId!;
    expect(await harness.store.getOccurrenceDetail(occurrenceId)).toMatchObject({
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      observedValue: { amountMinor: 28_640 },
    });
    harness.store.close();
  });

  it('replays migrations and recovers a promoted projection after restart', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    const first = await publish(harness, publication);
    expect(first.generation.state).toBe('promoted');
    expect(first.evaluation?.state).toBe('queued');
    harness.store.close();

    const reopened = openStore(harness.path, harness.clock);
    expect(await reopened.loadCurrentProjection('demo-connector-v1')).toEqual(
      projectionFrom(publication.batches)
    );
    expect(
      await reopened.evaluations.find(first.evaluation!.assignment.identity)
    ).toEqual(first.evaluation);
    reopened.close();
  });

  it('accepts exact replay and rejects changed generation or idempotency input', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    const first = await harness.service.beginSourceGeneration(publication.request);
    expect(await harness.service.beginSourceGeneration(publication.request)).toEqual(
      first
    );
    await expectStoreError(
      harness.service.beginSourceGeneration({
        ...publication.request,
        sourceAsOf: '2026-08-10T14:59:00Z',
        capturedConstituents: publication.request.capturedConstituents.map(
          (item, index) => ({
            ...item,
            sourceAsOf:
              index === 0 ? '2026-08-10T14:59:00Z' : item.sourceAsOf,
          })
        ),
      }),
      'idempotency_conflict'
    );
    await expectStoreError(
      harness.service.beginSourceGeneration({
        ...publication.request,
        idempotencyKey: 'different-generation-idempotency-v1',
        currency: 'EUR',
      }),
      'source_generation_conflict'
    );
    harness.store.close();
  });

  it('rejects changed batch replay, source-reference overlap, gaps, and oversized batches', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    await harness.service.beginSourceGeneration(publication.request);
    const transaction = publication.batches[0]!;
    await harness.service.putSourceBatch(transaction);
    await harness.service.putSourceBatch(transaction);

    const changedFacts = transaction.kind === 'transaction'
      ? transaction.facts.map((fact) => ({ ...fact, amountMinor: -130_000 }))
      : [];
    const changed = parseSourceFactBatchV1({
      ...transaction,
      facts: changedFacts,
      digest: canonicalDigestV1(changedFacts),
    });
    await expectStoreError(
      harness.service.putSourceBatch(changed),
      'idempotency_conflict'
    );

    const overlappingFacts = transaction.facts;
    const overlap = parseSourceFactBatchV1({
      ...transaction,
      batchIndex: 1,
      idempotencyKey: 'overlapping-transaction-batch-v1',
      facts: overlappingFacts,
      digest: canonicalDigestV1(overlappingFacts),
    });
    const expanded = withManifestBatchCount(publication.request, 'transaction', 2);
    const overlapHarness = await createHarness();
    await overlapHarness.service.beginSourceGeneration(expanded);
    await overlapHarness.service.putSourceBatch({
      ...transaction,
      sourceGeneration: expanded.sourceGeneration,
      idempotencyKey: 'first-overlap-transaction-v1',
    });
    await expectStoreError(
      overlapHarness.service.putSourceBatch({
        ...overlap,
        sourceGeneration: expanded.sourceGeneration,
      }),
      'source_batch_conflict'
    );

    for (const batch of publication.batches.slice(1, -1)) {
      await harness.service.putSourceBatch(batch);
    }
    await expectStoreError(
      harness.service.commitSourceGeneration(
        publication.request.connectorRef,
        publication.commit
      ),
      'source_generation_conflict'
    );
    const oversized = {
      ...transaction,
      facts: Array.from({ length: 251 }, (_, index) => ({
        ...transaction.facts[0]!,
        sourceRef: `demo-oversized-${index}`,
      })),
    };
    expect(() => parseSourceFactBatchV1(oversized)).toThrow('Too big');
    harness.store.close();
    overlapHarness.store.close();
  });

  it('rolls back both pre-promotion and post-projection crashes and retries atomically', async () => {
    for (const failurePoint of [
      'beforePromotion',
      'afterProjection',
      'afterPromotion',
    ] as const) {
      let fail = true;
      const harness = await createHarness({
        testHook: (point) => {
          if (fail && point === failurePoint) throw new Error('invented crash');
        },
      });
      const publication = makePublication(1, '2026-08-10T15:00:00Z');
      await stage(harness, publication);
      await expect(
        harness.service.commitSourceGeneration(
          publication.request.connectorRef,
          publication.commit
        )
      ).rejects.toThrow('invented crash');
      expect(
        await harness.store.sourceGenerations.find(
          publication.request.connectorRef,
          publication.request.sourceGeneration
        )
      ).toMatchObject({ state: 'staging' });
      expect(await harness.store.loadCurrentProjection('demo-connector-v1')).toBeNull();
      fail = false;
      expect(
        (
          await harness.service.commitSourceGeneration(
            publication.request.connectorRef,
            publication.commit
          )
        ).generation.state
      ).toBe('promoted');
      expect(
        await harness.service.commitSourceGeneration(
          publication.request.connectorRef,
          publication.commit
        )
      ).toEqual(
        await harness.service.commitSourceGeneration(
          publication.request.connectorRef,
          publication.commit
        )
      );
      harness.store.close();
    }
  });

  it('rolls back repository operations inside the unit-of-work transaction', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    await expect(
      harness.store.transaction(async () => {
        await harness.service.beginSourceGeneration(publication.request);
        throw new Error('invented transaction abort');
      })
    ).rejects.toThrow('invented transaction abort');
    expect(
      await harness.store.sourceGenerations.find(
        publication.request.connectorRef,
        publication.request.sourceGeneration
      )
    ).toBeNull();
    harness.store.close();
  });

  it('serializes concurrent requests outside an async unit-of-work transaction', async () => {
    const harness = await createHarness();
    const rolledBack = makePublication(1, '2026-08-10T15:00:00Z');
    const independent = makePublication(2, '2026-08-10T15:01:00Z');
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseOuter!: () => void;
    const holdOuter = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    const outer = harness.store.transaction(async () => {
      await harness.service.beginSourceGeneration(rolledBack.request);
      signalEntered();
      await holdOuter;
      throw new Error('invented outer rollback');
    });
    await entered;
    let independentCompleted = false;
    const concurrent = harness.service
      .beginSourceGeneration(independent.request)
      .then((result) => {
        independentCompleted = true;
        return result;
      });
    await Promise.resolve();
    expect(independentCompleted).toBe(false);
    releaseOuter();
    await expect(outer).rejects.toThrow('invented outer rollback');
    expect((await concurrent).state).toBe('staging');
    expect(
      await harness.store.sourceGenerations.find(
        rolledBack.request.connectorRef,
        rolledBack.request.sourceGeneration
      )
    ).toBeNull();
    expect(
      await harness.store.sourceGenerations.find(
        independent.request.connectorRef,
        independent.request.sourceGeneration
      )
    ).toMatchObject({ state: 'staging' });
    harness.store.close();
  });

  it('keeps delayed lower sequences historical and prevents sequence reuse', async () => {
    const harness = await createHarness();
    const newer = makePublication(2, '2026-08-10T15:10:00Z');
    const older = makePublication(1, '2026-08-10T15:00:00Z');
    expect((await publish(harness, newer)).generation.state).toBe('promoted');
    const delayed = await publish(harness, older);
    expect(delayed.generation.state).toBe('historical');
    expect(delayed.evaluation).toBeNull();
    expect(
      (await harness.store.loadCurrentProjection('demo-connector-v1'))
        ?.transactions[0]?.sourceRef
    ).toBe('demo-transaction-sequence-2');
    expect(
      (
        await harness.store.loadProjection(
          'demo-connector-v1',
          older.request.sourceGeneration
        )
      )?.transactions[0]?.sourceRef
    ).toBe('demo-transaction-sequence-1');
    await expectStoreError(
      harness.service.beginSourceGeneration({
        ...older.request,
        sourceGeneration: 'demo-generation-sequence-reuse',
        idempotencyKey: 'sequence-reuse-idempotency-v1',
      }),
      'source_generation_conflict'
    );
    harness.store.close();
  });

  it('rejects promotion when the observed current generation changed', async () => {
    const harness = await createHarness();
    const older = makePublication(1, '2026-08-10T15:00:00Z');
    const newer = makePublication(2, '2026-08-10T15:10:00Z');
    await stage(harness, older);
    expect((await publish(harness, newer)).generation.state).toBe('promoted');

    await expectStoreError(
      harness.service.commitSourceGeneration(
        older.request.connectorRef,
        older.commit,
        null
      ),
      'source_generation_conflict'
    );
    expect(
      (await harness.store.findCurrentSourceGeneration(older.request.connectorRef))
        ?.request.sourceGeneration
    ).toBe(newer.request.sourceGeneration);
    harness.store.close();
  });

  it('selects the latest promoted generation across connector scope deterministically', async () => {
    const harness = await createHarness();
    expect(await harness.store.findLatestPromotedSourceGeneration()).toBeNull();

    const first = makePublicationForConnector(
      'connector-z',
      1,
      '2026-08-10T15:00:00Z'
    );
    await publish(harness, first);
    harness.clock.value = '2026-08-10T15:06:00Z';
    const tiedSecond = makePublicationForConnector(
      'connector-b',
      1,
      '2026-08-10T15:01:00Z'
    );
    const tiedWinner = makePublicationForConnector(
      'connector-a',
      1,
      '2026-08-10T15:02:00Z'
    );
    await publish(harness, tiedSecond);
    await publish(harness, tiedWinner);

    expect(
      (await harness.store.findLatestPromotedSourceGeneration())?.request
    ).toMatchObject({
      connectorRef: tiedWinner.request.connectorRef,
      sourceGeneration: tiedWinner.request.sourceGeneration,
    });
    harness.clock.value = '2026-08-10T15:07:00Z';
    const latest = makePublicationForConnector(
      'connector-z',
      2,
      '2026-08-10T15:03:00Z'
    );
    await publish(harness, latest);
    expect(
      (await harness.store.findLatestPromotedSourceGeneration())?.request
    ).toMatchObject({
      connectorRef: latest.request.connectorRef,
      sourceGeneration: latest.request.sourceGeneration,
    });
    harness.store.close();
  });

  it('freezes recurring obligation classification per committed generation', async () => {
    const harness = await createHarness();
    const recurring = (amountMinor: number | null, active: boolean) => [
      {
        sourceRef: 'stable-recurring-obligation',
        displayName: 'Demo Utility',
        amountMinor,
        cadence: 'unknown' as const,
        nextDate: null,
        categoryRef: null,
        accountRef: null,
        active,
      },
    ];
    const outgoing = makePublication(
      1,
      '2026-08-10T15:00:00Z',
      undefined,
      recurring(-28_640, true)
    );
    const unavailable = makePublication(
      2,
      '2026-08-10T15:10:00Z',
      undefined,
      recurring(null, false)
    );
    const income = makePublication(
      3,
      '2026-08-10T15:20:00Z',
      undefined,
      recurring(28_640, true)
    );

    await publish(harness, outgoing);
    await publish(harness, unavailable);
    await publish(harness, income);

    expect(
      await harness.store.loadRecurringObligationRefs(
        'demo-connector-v1',
        outgoing.request.sourceGeneration
      )
    ).toEqual(['stable-recurring-obligation']);
    expect(
      await harness.store.loadRecurringObligationRefs(
        'demo-connector-v1',
        unavailable.request.sourceGeneration
      )
    ).toEqual(['stable-recurring-obligation']);
    expect(
      await harness.store.loadRecurringObligationRefs(
        'demo-connector-v1',
        income.request.sourceGeneration
      )
    ).toEqual([]);
    harness.store.close();
  });

  it('reconstructs retained generation projections and obligation state on upgrade', async () => {
    const harness = await createHarness();
    const source = makePublication(
      1,
      '2026-08-10T15:00:00Z',
      undefined,
      [
        {
          sourceRef: 'legacy-recurring-obligation',
          displayName: 'Demo Utility',
          amountMinor: -28_640,
          cadence: 'monthly',
          nextDate: null,
          categoryRef: null,
          accountRef: null,
          active: true,
        },
      ]
    );
    await publish(harness, source);
    harness.store.close();

    const legacy = new Database(harness.path);
    legacy.exec(`
      DELETE FROM finance_insight_recurring_facts;
      DELETE FROM finance_insight_account_facts;
      DROP INDEX finance_insight_recurring_obligations_by_connector_source;
      DROP TABLE finance_insight_recurring_obligation_facts;
      DELETE FROM finance_insight_schema_migrations WHERE version = 7;
    `);
    legacy.close();

    const upgraded = openStore(harness.path, harness.clock);
    expect(
      (
        await upgraded.loadProjection(
          source.request.connectorRef,
          source.request.sourceGeneration
        )
      )?.recurring.map((fact) => fact.sourceRef)
    ).toEqual(['legacy-recurring-obligation']);
    expect(
      await upgraded.loadRecurringObligationRefs(
        source.request.connectorRef,
        source.request.sourceGeneration
      )
    ).toEqual(['legacy-recurring-obligation']);
    upgraded.close();
  });

  it('serializes concurrent source-sequence compare-and-swap conflicts', async () => {
    const harness = await createHarness();
    const first = makePublication(1, '2026-08-10T15:00:00Z');
    const second = makePublication(1, '2026-08-10T15:00:00Z');
    second.request = parseSourceGenerationCreateRequestV1({
      ...second.request,
      sourceGeneration: 'demo-concurrent-generation-v1',
      idempotencyKey: 'demo-concurrent-generation-idempotency',
    });
    const settled = await Promise.allSettled([
      harness.service.beginSourceGeneration(first.request),
      harness.service.beginSourceGeneration(second.request),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        descriptor: expect.objectContaining({
          body: expect.objectContaining({
            error: expect.objectContaining({
              code: 'source_generation_conflict',
            }),
          }),
        }),
      }),
    });
    harness.store.close();
  });

  it('requires exact manifest counts, canonical digests, and complete five-kind commit', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    await stage(harness, publication);
    await expectStoreError(
      harness.service.commitSourceGeneration(
        publication.request.connectorRef,
        {
          ...publication.commit,
          manifestDigest: `sha256:${'f'.repeat(64)}`,
        }
      ),
      'source_generation_conflict'
    );
    const mismatchHarness = await createHarness();
    const mismatched = {
      ...publication,
      request: parseSourceGenerationCreateRequestV1({
        ...publication.request,
        sourceGeneration: 'demo-manifest-mismatch-v1',
        idempotencyKey: 'demo-manifest-mismatch-idempotency',
        manifest: publication.request.manifest.map((entry) =>
          entry.kind === 'tag'
            ? { ...entry, digest: `sha256:${'9'.repeat(64)}` }
            : entry
        ),
      }),
    };
    mismatched.batches = publication.batches.map((batch) => ({
      ...batch,
      sourceGeneration: mismatched.request.sourceGeneration,
      idempotencyKey: `${batch.kind}-manifest-mismatch-v1`,
    })) as SourceFactBatchV1[];
    mismatched.commit = {
      ...publication.commit,
      sourceGeneration: mismatched.request.sourceGeneration,
      manifestDigest: sourceManifestDigestV1(mismatched.request.manifest),
      idempotencyKey: 'manifest-mismatch-commit-v1',
    };
    await stage(mismatchHarness, mismatched);
    await expectStoreError(
      mismatchHarness.service.commitSourceGeneration(
        mismatched.request.connectorRef,
        mismatched.commit
      ),
      'source_generation_conflict'
    );
    harness.store.close();
    mismatchHarness.store.close();
  });
});

describe('evaluation fences and occurrence lifecycle', () => {
  it('persists queued retry idempotency and recovers an expired claim with a new sequence', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, publication);
    const first = committed.evaluation!.assignment;
    const retryRequest = {
      contractVersion: '1.0' as const,
      connectorRef: publication.request.connectorRef,
      sourceGeneration: publication.request.sourceGeneration,
      detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-queued-retry-idempotency',
    };

    const queuedReplay = await harness.service.retryEvaluation(retryRequest);
    expect(queuedReplay.assignment.evaluationSequence).toBe(
      first.evaluationSequence
    );
    expect(await harness.service.retryEvaluation(retryRequest)).toEqual(
      queuedReplay
    );
    await harness.service.claimEvaluation(first);
    harness.clock.value = '2026-08-10T15:11:00Z';
    const recovered = await harness.service.retryEvaluation({
      ...retryRequest,
      idempotencyKey: 'demo-expired-claim-retry',
    });
    expect(recovered.assignment.evaluationSequence).toBe(
      first.evaluationSequence + 1
    );
    expect(await harness.service.retryEvaluation(retryRequest)).toMatchObject({
      assignment: { evaluationSequence: first.evaluationSequence },
      state: 'failed',
    });
    await expectStoreError(
      harness.service.completeEvaluation(first, {
        state: 'failed',
        completedAt: '2026-08-10T15:11:01Z',
      }),
      'stale_evaluation'
    );
    harness.store.close();
  });

  it('terminalizes a queued evaluation after its connector advances', async () => {
    const harness = await createHarness();
    const first = await publish(
      harness,
      makePublication(1, '2026-08-10T15:00:00Z')
    );
    const firstAssignment = first.evaluation!.assignment;
    await publish(harness, makePublication(2, '2026-08-10T15:01:00Z'));

    await expectStoreError(
      harness.service.claimEvaluation(firstAssignment),
      'stale_evaluation'
    );
    expect(
      await harness.store.evaluations.find(firstAssignment.identity)
    ).toMatchObject({
      state: 'failed',
    });
    harness.store.close();
  });

  it('assigns monotonic evaluation sequences and rejects delayed completion after retry', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, publication);
    const first = committed.evaluation!.assignment;
    await harness.service.completeEvaluation(first, {
      state: 'unavailable',
      completedAt: '2026-08-10T15:05:01Z',
    });
    harness.clock.value = '2026-08-10T15:06:00Z';
    const retried = await harness.service.retryEvaluation({
      contractVersion: '1.0',
      connectorRef: publication.request.connectorRef,
      sourceGeneration: publication.request.sourceGeneration,
      detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-evaluation-retry-idempotency',
    });
    expect(retried.assignment.evaluationSequence).toBe(
      first.evaluationSequence + 1
    );
    expect(
      (await harness.service.claimEvaluation(retried.assignment)).state
    ).toBe('evaluating');
    await expectStoreError(
      harness.service.claimEvaluation(retried.assignment),
      'evaluation_in_progress'
    );
    await expectStoreError(
      harness.service.completeEvaluation(first, {
        state: 'failed',
        completedAt: '2026-08-10T15:06:01Z',
      }),
      'stale_evaluation'
    );
    harness.store.close();
  });

  it('allows only one terminal result for concurrent evaluation completion', async () => {
    const harness = await createHarness();
    const source = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, source);
    const assignment = committed.evaluation!.assignment;
    const settled = await Promise.allSettled([
      harness.service.completeEvaluation(assignment, {
        state: 'unavailable',
        completedAt: '2026-08-10T15:05:01Z',
      }),
      harness.service.completeEvaluation(assignment, {
        state: 'failed',
        completedAt: '2026-08-10T15:05:02Z',
      }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      settled.find((result) => result.status === 'rejected')
    ).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        descriptor: expect.objectContaining({
          body: expect.objectContaining({
            error: expect.objectContaining({ code: 'stale_evaluation' }),
          }),
        }),
      }),
    });
    harness.store.close();
  });

  it('rejects completed evaluation state without an explicit publication', async () => {
    const harness = await createHarness();
    const source = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, source);
    await expectStoreError(
      harness.service.completeEvaluation(committed.evaluation!.assignment, {
        state: 'completed',
        summaries: [],
        completedAt: '2026-08-10T15:05:01Z',
      }),
      'invalid_request'
    );
    expect(
      await harness.store.evaluations.find(
        committed.evaluation!.assignment.identity
      )
    ).toMatchObject({ state: 'queued' });
    harness.store.close();
  });

  it('publishes one lifecycle result idempotently and rejects stale occurrence revisions', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, publication);
    const detail = await makeDetail(
      committed.evaluation!.assignment,
      publication.request
    );
    const terminal = completedResult(detail);
    const occurrencePublication = publicationFor(detail);
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      terminal,
      occurrencePublication
    );
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      terminal,
      occurrencePublication
    );
    expect(await harness.store.getOccurrenceDetail(detail.occurrenceId)).toMatchObject({
      occurrenceId: detail.occurrenceId,
      deliveryRevision: 1,
      sourceLifecycle: 'open',
    });
    await expectStoreError(
      harness.store.applyOccurrenceAction({
        contractVersion: '1.0',
        occurrenceId: detail.occurrenceId,
        expectedDeliveryRevision: 2,
        expectedPolicyVersion: 1,
        idempotencyKey: 'stale-occurrence-action-v1',
        action: 'notUseful',
        reason: 'notActionable',
      }),
      'occurrence_revision_conflict'
    );
    harness.store.close();
  });

  it('supersedes a corrected occurrence with deterministic lineage', async () => {
    const harness = await createHarness();
    const firstPublication = makePublication(1, '2026-08-10T15:00:00Z');
    const firstCommit = await publish(harness, firstPublication);
    const firstDetail = await makeDetail(
      firstCommit.evaluation!.assignment,
      firstPublication.request
    );
    await harness.service.completeEvaluation(
      firstCommit.evaluation!.assignment,
      completedResult(firstDetail),
      publicationFor(firstDetail)
    );

    harness.clock.value = '2026-08-10T16:00:00Z';
    const correctedSource = makePublication(2, '2026-08-10T15:55:00Z');
    const correctedCommit = await publish(harness, correctedSource);
    const replacementId =
      'occurrence-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const correctedDetail = await makeDetail(
      correctedCommit.evaluation!.assignment,
      correctedSource.request,
      replacementId
    );
    await harness.service.completeEvaluation(
      correctedCommit.evaluation!.assignment,
      completedResult(correctedDetail, '2026-08-10T16:00:01Z'),
      {
        occurrences: [
          {
            detail: correctedDetail,
            sourceRevisionRef:
              'revision-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        ],
        transitions: [
          {
            occurrenceId: firstDetail.occurrenceId,
            state: 'superseded',
            reasonCode: 'correction_superseded',
            replacementOccurrenceId: replacementId,
            occurredAt: '2026-08-10T16:00:01Z',
          },
        ],
      }
    );
    expect(await harness.store.getOccurrenceDetail(firstDetail.occurrenceId)).toMatchObject({
      sourceLifecycle: 'superseded',
      resolutionReason: 'correction_superseded',
      supersededByOccurrenceId: replacementId,
    });

    expect(await harness.store.getOccurrenceDetail(replacementId)).toMatchObject({
      sourceLifecycle: 'open',
      deliveryRevision: 1,
    });
    harness.store.close();
  });

  it('increments one occurrence revision only for a material non-correction change', async () => {
    const harness = await createHarness();
    const firstSource = makePublication(1, '2026-08-10T15:00:00Z');
    const firstCommit = await publish(harness, firstSource);
    const firstDetail = await makeDetail(
      firstCommit.evaluation!.assignment,
      firstSource.request
    );
    await harness.service.completeEvaluation(
      firstCommit.evaluation!.assignment,
      completedResult(firstDetail),
      publicationFor(firstDetail)
    );

    harness.clock.value = '2026-08-10T16:00:00Z';
    const secondSource = makePublication(2, '2026-08-10T15:55:00Z');
    const secondCommit = await publish(harness, secondSource);
    const nextEvaluationDetail = await makeDetail(
      secondCommit.evaluation!.assignment,
      secondSource.request
    );
    const material = parseInsightOccurrenceDetailV1({
      ...nextEvaluationDetail,
      createdAt: firstDetail.createdAt,
      deliveryRevision: 2,
      observedValue: {
        currency: 'USD',
        amountMinor: firstDetail.observedValue!.amountMinor + 1_000,
      },
      absoluteDelta: {
        currency: 'USD',
        amountMinor: firstDetail.absoluteDelta!.amountMinor + 1_000,
      },
      reasonCodes: [...firstDetail.reasonCodes, 'material_source_change'],
      lifecycleHistory: firstDetail.lifecycleHistory,
    });
    await harness.service.completeEvaluation(
      secondCommit.evaluation!.assignment,
      completedResult(material, '2026-08-10T16:00:01Z'),
      publicationFor(material)
    );
    expect(await harness.store.getOccurrenceDetail(firstDetail.occurrenceId)).toMatchObject({
      occurrenceId: firstDetail.occurrenceId,
      deliveryRevision: 2,
      sourceLifecycle: 'open',
      reasonCodes: expect.arrayContaining(['material_source_change']),
    });
    harness.store.close();
  });

  it('does not open alerts from stale source and records unavailable evaluation without 500-shaped failure', async () => {
    const harness = await createHarness();
    harness.clock.value = '2026-08-13T16:00:00Z';
    const stale = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, stale);
    const staleDetail = await makeDetail(
      committed.evaluation!.assignment,
      stale.request,
      undefined,
      'stale'
    );
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      completedResult(staleDetail, '2026-08-13T16:00:01Z'),
      publicationFor(staleDetail)
    );
    expect(
      await harness.store.getOccurrenceDetail(staleDetail.occurrenceId)
    ).toBeNull();

    const partialHarness = await createHarness();
    const partialSource = makePublication(1, '2026-08-10T15:00:00Z');
    const partialCommit = await publish(partialHarness, partialSource);
    const freshDetail = await makeDetail(
      partialCommit.evaluation!.assignment,
      partialSource.request
    );
    const partialDetail = parseInsightOccurrenceDetailV1({
      ...freshDetail,
      freshness: {
        ...freshDetail.freshness,
        state: 'partial',
        warningReason: 'source_partial',
      },
      provenance: {
        ...freshDetail.provenance,
        completeness: 'partial',
      },
    });
    await partialHarness.service.completeEvaluation(
      partialCommit.evaluation!.assignment,
      completedResult(partialDetail),
      publicationFor(partialDetail)
    );
    expect(
      await partialHarness.store.getOccurrenceDetail(partialDetail.occurrenceId)
    ).toBeNull();

    const secondHarness = await createHarness();
    const current = makePublication(1, '2026-08-10T15:00:00Z');
    const currentCommit = await publish(secondHarness, current);
    const unavailable = await secondHarness.service.completeEvaluation(
      currentCommit.evaluation!.assignment,
      {
        state: 'unavailable',
        completedAt: '2026-08-10T15:05:01Z',
      }
    );
    expect(unavailable.state).toBe('unavailable');
    expect(await secondHarness.store.listOccurrences(defaultListQuery())).toEqual({
      contractVersion: '1.0',
      items: [],
      nextCursor: null,
    });
    harness.store.close();
    partialHarness.store.close();
    secondHarness.store.close();
  });

  it('binds snapshot cursors to filters and excludes later publications', async () => {
    const harness = await createHarness();
    const source = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, source);
    const first = await makeDetail(
      committed.evaluation!.assignment,
      source.request
    );
    const second = parseInsightOccurrenceDetailV1({
      ...first,
      occurrenceId: 'occurrence-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      createdAt: '2026-08-10T15:05:01Z',
      updatedAt: '2026-08-10T15:05:01Z',
      provenance: {
        ...first.provenance,
        evaluationCompletedAt: '2026-08-10T15:05:01Z',
      },
      lifecycleHistory: [
        {
          sequence: 1,
          state: 'analyzing',
          reasonCode: null,
          occurredAt: '2026-08-10T15:05:00Z',
          replacementOccurrenceId: null,
        },
        {
          sequence: 2,
          state: 'open',
          reasonCode: null,
          occurredAt: '2026-08-10T15:05:01Z',
          replacementOccurrenceId: null,
        },
      ],
    });
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      completedResult(second, '2026-08-10T15:05:01Z', [first, second]),
      {
        occurrences: [
          publicationFor(first).occurrences[0]!,
          publicationFor(second).occurrences[0]!,
        ],
        transitions: [],
      }
    );
    const firstPage = await harness.store.listOccurrences({
      ...defaultListQuery(),
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    harness.clock.value = '2026-08-10T15:10:00Z';
    const laterSource = makePublication(2, '2026-08-10T15:09:00Z');
    const laterCommit = await publish(harness, laterSource);
    const later = await makeDetail(
      laterCommit.evaluation!.assignment,
      laterSource.request,
      'occurrence-v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
    );
    const revisedBase = await makeDetail(
      laterCommit.evaluation!.assignment,
      laterSource.request,
      first.occurrenceId
    );
    const revised = parseInsightOccurrenceDetailV1({
      ...revisedBase,
      createdAt: first.createdAt,
      deliveryRevision: 2,
      reasonCodes: [...first.reasonCodes, 'material_source_change'],
      lifecycleHistory: first.lifecycleHistory,
    });
    await harness.service.completeEvaluation(
      laterCommit.evaluation!.assignment,
      completedResult(later, '2026-08-10T15:10:01Z', [revised, later]),
      {
        occurrences: [
          publicationFor(revised).occurrences[0]!,
          publicationFor(later).occurrences[0]!,
        ],
        transitions: [],
      }
    );
    await expectStoreError(
      harness.store.listOccurrences({
        ...defaultListQuery(),
        limit: 2,
        cursor: firstPage.nextCursor,
      }),
      'invalid_cursor'
    );
    const secondPage = await harness.store.listOccurrences({
      ...defaultListQuery(),
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.occurrenceId).not.toBe(
      firstPage.items[0]?.occurrenceId
    );
    expect(secondPage.items[0]).toMatchObject({
      occurrenceId: first.occurrenceId,
      deliveryRevision: 1,
    });
    expect(secondPage.nextCursor).toBeNull();
    harness.store.close();
  });
});

describe('actions, classification, optional evidence, and retention', () => {
  it('persists immutable monotonic policy snapshots and fences assigned generations', async () => {
    const harness = await createHarness();
    const source = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, source);
    const first = (await harness.store.policies.find(1))!;
    const second = parseFinanceInsightPolicySnapshotV1({
      ...structuredClone(first),
      policyVersion: 2,
      effectiveAt: '2026-08-10T15:30:00Z',
      largeTransaction: {
        ...structuredClone(first.largeTransaction),
        explicitRuleMinor: 110_000,
      },
    });
    await harness.store.appendPolicy(second);
    expect((await harness.store.policies.current())?.policyVersion).toBe(1);
    await expectStoreError(
      harness.store.appendPolicy(
        parseFinanceInsightPolicySnapshotV1({
          ...structuredClone(second),
          largeTransaction: {
            ...structuredClone(second.largeTransaction),
            explicitRuleMinor: 120_000,
          },
        })
      ),
      'policy_conflict'
    );
    expect(await harness.store.policies.find(1)).toEqual(first);
    await harness.service.completeEvaluation(committed.evaluation!.assignment, {
      state: 'unavailable',
      completedAt: '2026-08-10T15:05:01Z',
    });
    await expectStoreError(
      harness.service.retryEvaluation({
        contractVersion: '1.0',
        connectorRef: source.request.connectorRef,
        sourceGeneration: source.request.sourceGeneration,
        detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
        expectedPolicyVersion: 2,
        idempotencyKey: 'wrong-assigned-policy-retry-v1',
      }),
      'stale_evaluation'
    );
    expect(
      (
        await harness.service.retryEvaluation({
          contractVersion: '1.0',
          connectorRef: source.request.connectorRef,
          sourceGeneration: source.request.sourceGeneration,
          detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
          expectedPolicyVersion: 1,
          idempotencyKey: 'original-assigned-policy-retry-v1',
        })
      ).assignment.identity.policyVersion
    ).toBe(1);
    harness.clock.value = '2026-08-10T15:31:00Z';
    expect((await harness.store.policies.current())?.policyVersion).toBe(2);
    harness.store.close();
  });

  it('persists deterministic recurring and merchant identity associations', async () => {
    const harness = await createHarness();
    await publish(harness, makePublication(1, '2026-08-10T15:00:00Z'));
    const recurring = {
      connectorRef: 'demo-connector-v1',
      transactionSourceRef: 'demo-transaction-sequence-1',
      recurringSourceRef: 'demo-recurring-sequence-1',
      associationVersion: 'association-v1',
      confidence: 'exact' as const,
      sourceSequence: 1,
      createdAt: '2026-08-10T15:05:00Z',
    };
    expect(await harness.store.associateRecurring(recurring)).toEqual(recurring);
    expect(await harness.store.associateRecurring(recurring)).toEqual(recurring);
    await expectStoreError(
      harness.store.associateRecurring({
        ...recurring,
        recurringSourceRef: 'demo-recurring-other-v1',
      }),
      'source_generation_conflict'
    );
    await expectStoreError(
      harness.store.associateRecurring({
        ...recurring,
        transactionSourceRef: 'demo-transaction-missing-v1',
      }),
      'source_generation_conflict'
    );
    const merchant = {
      connectorRef: 'demo-connector-v1',
      normalizedMerchantKey:
        'merchant-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      canonicalMerchantKey:
        'merchant-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      aliasVersion: 'merchant-alias-v1',
      createdAt: '2026-08-10T15:05:00Z',
    };
    expect(await harness.store.associateMerchantIdentity(merchant)).toEqual(
      merchant
    );
    expect(await harness.store.associateMerchantIdentity(merchant)).toEqual(
      merchant
    );
    harness.store.close();
  });

  it('persists only timed suppression, exposes expiry, and supports idempotent undo', async () => {
    const harness = await createPublishedOccurrenceHarness();
    const detail = harness.detail;
    const suppressed = await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-suppression-action-idempotency',
      action: 'suppress',
      confirm: true,
      scope: 'occurrence',
      durationDays: 30,
      reason: 'temporaryHouseholdChange',
    });
    expect(suppressed.action).toBe('suppress');
    expect(
      (await harness.store.getOccurrenceDetail(detail.occurrenceId))?.suppression
        .state
    ).toBe('active');
    const replay = await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-suppression-action-idempotency',
      action: 'suppress',
      confirm: true,
      scope: 'occurrence',
      durationDays: 30,
      reason: 'temporaryHouseholdChange',
    });
    expect(replay).toEqual(suppressed);
    const undone = await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-suppression-undo-idempotency',
      action: 'undoSuppression',
      suppressionId: suppressed.suppressionId!,
      confirm: true,
    });
    expect(undone.action).toBe('undoSuppression');
    expect(
      (await harness.store.getOccurrenceDetail(detail.occurrenceId))?.suppression
        .state
    ).toBe('undone');

    const second = await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-second-suppression-idempotency',
      action: 'suppress',
      confirm: true,
      scope: 'entity',
      durationDays: 30,
      reason: 'expectedRecurringPattern',
    });
    expect(second.suppressionId).not.toBe(suppressed.suppressionId);
    harness.clock.value = '2026-09-09T15:05:01Z';
    expect(
      (await harness.store.getOccurrenceDetail(detail.occurrenceId))?.suppression
        .state
    ).toBe('expired');
    harness.store.close();
  });

  it('isolates suppression scope by connector even when entity references collide', async () => {
    const harness = await createHarness();
    const firstSource = makePublication(1, '2026-08-10T15:00:00Z');
    const firstCommit = await publish(harness, firstSource);
    const first = await makeDetail(
      firstCommit.evaluation!.assignment,
      firstSource.request
    );
    await harness.service.completeEvaluation(
      firstCommit.evaluation!.assignment,
      completedResult(first),
      publicationFor(first)
    );

    const secondSource = makePublicationForConnector(
      'demo-connector-two-v1',
      1,
      '2026-08-10T15:00:00Z'
    );
    const secondCommit = await publish(harness, secondSource);
    const secondBase = await makeDetail(
      secondCommit.evaluation!.assignment,
      secondSource.request,
      'occurrence-v1_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
    );
    const second = parseInsightOccurrenceDetailV1({
      ...secondBase,
      insightId: 'insight-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    await harness.service.completeEvaluation(
      secondCommit.evaluation!.assignment,
      completedResult(second),
      publicationFor(second)
    );
    await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: first.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'connector-isolated-suppression-v1',
      action: 'suppress',
      confirm: true,
      scope: 'entity',
      durationDays: 30,
      reason: 'expectedRecurringPattern',
    });
    expect(
      (await harness.store.getOccurrenceDetail(first.occurrenceId))?.suppression
        .state
    ).toBe('active');
    expect(
      (await harness.store.getOccurrenceDetail(second.occurrenceId))?.suppression
        .state
    ).toBe('none');
    harness.store.close();
  });

  it('keeps broader suppression active after one occurrence closes and allows covered undo', async () => {
    const harness = await createHarness();
    const source = makePublication(1, '2026-08-10T15:00:00Z');
    const committed = await publish(harness, source);
    const first = await makeDetail(committed.evaluation!.assignment, source.request);
    const second = parseInsightOccurrenceDetailV1({
      ...first,
      occurrenceId: 'occurrence-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      completedResult(first, first.provenance.evaluationCompletedAt, [first, second]),
      {
        occurrences: [
          publicationFor(first).occurrences[0]!,
          publicationFor(second).occurrences[0]!,
        ],
        transitions: [],
      }
    );
    const suppression = await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: first.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'shared-entity-suppression-v1',
      action: 'suppress',
      confirm: true,
      scope: 'entity',
      durationDays: 90,
      reason: 'expectedRecurringPattern',
    });
    expect(
      (await harness.store.getOccurrenceDetail(second.occurrenceId))?.suppression
        .state
    ).toBe('active');

    harness.clock.value = '2026-08-10T15:10:00Z';
    const nextSource = makePublication(2, '2026-08-10T15:09:00Z');
    const nextCommit = await publish(harness, nextSource);
    await harness.service.completeEvaluation(
      nextCommit.evaluation!.assignment,
      {
        state: 'completed',
        summaries: [],
        completedAt: '2026-08-10T15:10:01Z',
      },
      {
        occurrences: [],
        transitions: [
          {
            occurrenceId: first.occurrenceId,
            state: 'resolved',
            reasonCode: 'correction_resolved',
            replacementOccurrenceId: null,
            occurredAt: '2026-08-10T15:10:01Z',
          },
        ],
      }
    );
    expect(
      (await harness.store.getOccurrenceDetail(first.occurrenceId))?.suppression
        .state
    ).toBe('none');
    expect(
      (await harness.store.getOccurrenceDetail(second.occurrenceId))?.suppression
        .state
    ).toBe('active');
    await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: second.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'covered-entity-suppression-undo-v1',
      action: 'undoSuppression',
      suppressionId: suppression.suppressionId!,
      confirm: true,
    });
    expect(
      (await harness.store.getOccurrenceDetail(second.occurrenceId))?.suppression
        .state
    ).toBe('undone');
    harness.store.close();
  });

  it('persists structured feedback idempotently without changing thresholds', async () => {
    const harness = await createPublishedOccurrenceHarness();
    const before = await harness.store.policies.current();
    const request = {
      contractVersion: '1.0' as const,
      occurrenceId: harness.detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'demo-not-useful-idempotency',
      action: 'notUseful' as const,
      reason: 'comparisonNotRepresentative' as const,
    };
    const first = await harness.store.applyOccurrenceAction(request);
    expect(await harness.store.applyOccurrenceAction(request)).toEqual(first);
    const next = await publish(
      harness,
      makePublication(2, '2026-08-10T15:06:00Z')
    );
    await harness.service.completeEvaluation(
      next.evaluation!.assignment,
      {
        state: 'completed',
        summaries: [],
        completedAt: '2026-08-10T15:06:01Z',
      },
      {
        occurrences: [],
        transitions: [
          {
            occurrenceId: harness.detail.occurrenceId,
            state: 'resolved',
            reasonCode: 'correction_resolved',
            replacementOccurrenceId: null,
            occurredAt: '2026-08-10T15:06:01Z',
          },
        ],
      }
    );
    expect(await harness.store.applyOccurrenceAction(request)).toEqual(first);
    expect(await harness.store.policies.current()).toEqual(before);
    harness.store.close();
  });

  it('stores the source-classification matrix and optional normalized evidence only', async () => {
    const harness = await createHarness({
      policy: {
        transferCategoryRefs: ['demo-category-transfer'],
        refundTagRefs: ['demo-tag-refund'],
      },
    });
    const source = makePublication(1, '2026-08-10T15:00:00Z', [
      transactionFact('pending', -100, { isPending: true }),
      transactionFact('transfer', -100, { categoryRef: 'demo-category-transfer' }),
      transactionFact('refund', 100, { tagRefs: ['demo-tag-refund'] }),
      transactionFact('credit', 100),
      transactionFact('recurring', -100, { recurringRef: 'demo-recurring-v1' }),
      transactionFact('spend', -100),
    ]);
    await publish(harness, source);
    expect(
      (await harness.store.classifyCurrentTransactions('demo-connector-v1', 1)).map(
        (item) => item.classification
      )
    ).toEqual([
      'unclassifiedCredit',
      'pending',
      'knownRecurring',
      'refund',
      'postedSpend',
      'transfer',
    ]);
    await harness.store.replaceDocumentEvidence(
      'demo-connector-v1',
      source.request.sourceGeneration,
      'demo-recurring-v1',
      [
        {
          source: 'owl',
          evidenceType: 'billingPeriod',
          observedAt: '2026-08-10T14:00:00Z',
          documentRef: 'demo-document-v1',
          normalizedValueMinor: 31,
          normalizedUnit: 'days',
        },
      ]
    );
    expect(
      await harness.store.findDocumentEvidence(
        'demo-connector-v1',
        source.request.sourceGeneration,
        'demo-recurring-v1'
      )
    ).toHaveLength(1);
    harness.store.close();
  });

  it('expires staging and removes terminal occurrence payload after bounded retention', async () => {
    const harness = await createPublishedOccurrenceHarness();
    await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: harness.detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'retention-feedback-action-v1',
      action: 'notUseful',
      reason: 'notActionable',
    });
    const retainedSuppression = await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: harness.detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'retention-suppression-action-v1',
      action: 'suppress',
      confirm: true,
      scope: 'occurrence',
      durationDays: 30,
      reason: 'temporaryHouseholdChange',
    });
    await harness.store.applyOccurrenceAction({
      contractVersion: '1.0',
      occurrenceId: harness.detail.occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      idempotencyKey: 'retention-suppression-undo-v1',
      action: 'undoSuppression',
      suppressionId: retainedSuppression.suppressionId!,
      confirm: true,
    });
    const source2 = makePublication(2, '2026-08-10T15:10:00Z');
    await harness.service.beginSourceGeneration(source2.request);
    harness.clock.value = '2026-08-12T15:10:00Z';
    expect((await harness.store.cleanup()).expiredStaging).toBe(1);

    harness.clock.value = '2026-08-12T15:11:00Z';
    const source3 = makePublication(3, '2026-08-12T15:10:00Z');
    const committed = await publish(harness, source3);
    await harness.service.completeEvaluation(
      committed.evaluation!.assignment,
      { state: 'completed', summaries: [], completedAt: '2026-08-12T15:11:01Z' },
      {
        occurrences: [],
        transitions: [
          {
            occurrenceId: harness.detail.occurrenceId,
            state: 'resolved',
            reasonCode: 'correction_resolved',
            replacementOccurrenceId: null,
            occurredAt: '2026-08-12T15:11:01Z',
          },
        ],
      }
    );
    harness.clock.value = '2027-08-13T15:11:02Z';
    expect((await harness.store.cleanup()).deletedOccurrences).toBe(1);
    expect(
      await harness.store.getOccurrenceDetail(harness.detail.occurrenceId)
    ).toBeNull();
    harness.store.close();
  });

  it('returns exact sanitized conflict errors without source values or 500-shaped fallback', async () => {
    const harness = await createHarness();
    const publication = makePublication(1, '2026-08-10T15:00:00Z');
    await harness.service.beginSourceGeneration(publication.request);
    try {
      await harness.service.beginSourceGeneration({
        ...publication.request,
        sourceAsOf: '2026-08-10T14:59:00Z',
        capturedConstituents: publication.request.capturedConstituents.map(
          (item, index) => ({
            ...item,
            sourceAsOf:
              index === 0 ? '2026-08-10T14:59:00Z' : item.sourceAsOf,
          })
        ),
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(FinanceInsightStoreError);
      const conflict = error as FinanceInsightStoreError;
      expect(conflict.descriptor).toEqual({
        status: 409,
        body: {
          contractVersion: '1.0',
          error: {
            code: 'idempotency_conflict',
            message:
              'Finance insight idempotency key conflicts with prior input',
          },
        },
        retryAfterSeconds: null,
      });
      expect(conflict.message).not.toContain(publication.request.sourceGeneration);
      expect(conflict.descriptor.status).not.toBe(500);
    }
    harness.store.close();
  });
});

interface MutableClock {
  value: string;
}

interface Harness {
  path: string;
  clock: MutableClock;
  store: FinanceInsightSqliteStoreV1;
  service: FinanceInsightLifecycleServiceV1;
}

interface Publication {
  request: SourceGenerationCreateRequestV1;
  batches: SourceFactBatchV1[];
  commit: {
    contractVersion: '1.0';
    sourceGeneration: string;
    expectedSourceSequence: number;
    manifestDigest: string;
    idempotencyKey: string;
  };
}

async function createHarness(options?: {
  testHook?: (
    point: 'beforePromotion' | 'afterProjection' | 'afterPromotion'
  ) => void;
  policy?: {
    transferCategoryRefs?: string[];
    refundTagRefs?: string[];
    recurringAmountAnalysis?: boolean;
  };
}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'tyrion-finance-insights-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'state.sqlite');
  const clock = { value: '2026-08-10T15:05:00Z' };
  const store = openStore(path, clock, options?.testHook);
  const base = createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: '2026-08-10T14:00:00Z',
    currency: 'USD',
    timezone: 'America/New_York',
  });
  await store.appendPolicy(
    parseFinanceInsightPolicySnapshotV1({
      ...base,
      sourceClassification: {
        ...base.sourceClassification,
        transferCategoryRefs: options?.policy?.transferCategoryRefs ?? [],
        refundTagRefs: options?.policy?.refundTagRefs ?? [],
      },
      featureGates: {
        ...base.featureGates,
        recurringAmountAnalysis:
          options?.policy?.recurringAmountAnalysis ??
          base.featureGates.recurringAmountAnalysis,
      },
    })
  );
  return {
    path,
    clock,
    store,
    service: new FinanceInsightLifecycleServiceV1({
      store,
      householdScope: 'homelab-household',
      detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
    }),
  };
}

function openStore(
  path: string,
  clock: MutableClock,
  testHook?: (
    point: 'beforePromotion' | 'afterProjection' | 'afterPromotion'
  ) => void
): FinanceInsightSqliteStoreV1 {
  const store = new FinanceInsightSqliteStoreV1({
    path,
    cursorChecksumNamespace: Buffer.from('finance-insight-cursor-test-v1'),
    clock: () => clock.value,
    testHook,
  });
  activeStores.push(store);
  return store;
}

function makePublication(
  sequence: number,
  sourceAsOf: string,
  transactions = [transactionFact(`sequence-${sequence}`, -120_000)],
  recurring = [
    {
      sourceRef: `demo-recurring-sequence-${sequence}`,
      displayName: 'Demo Utility',
      amountMinor: 28_640,
      cadence: 'monthly' as const,
      nextDate: '2026-09-08',
      categoryRef: 'demo-category-utility',
      accountRef: 'demo-account-household',
      active: true,
    },
  ]
): Publication {
  const sourceGeneration = `demo-generation-sequence-${sequence}`;
  const facts = {
    transaction: transactions,
    recurring,
    category: [
      {
        sourceRef: 'demo-category-utility',
        displayName: 'Demo Utilities',
        groupRef: null,
        active: true,
      },
    ],
    account: [
      {
        sourceRef: 'demo-account-household',
        accountType: 'checking' as const,
        active: true,
      },
    ],
    tag: [
      {
        sourceRef: 'demo-tag-reviewed',
        displayName: 'Demo Reviewed',
        active: true,
      },
    ],
  };
  const batches = (Object.keys(facts) as SourceFactKindV1[]).map((kind) => {
    const input = {
      contractVersion: '1.0',
      sourceGeneration,
      kind,
      batchIndex: 0,
      facts: facts[kind],
      digest: canonicalDigestV1(facts[kind]),
      idempotencyKey: `${kind}-batch-sequence-${sequence}-v1`,
    };
    return parseSourceFactBatchV1(input);
  });
  const manifest = (Object.keys(facts) as SourceFactKindV1[]).map((kind) => ({
    kind,
    batchCount: 1,
    itemCount: facts[kind].length,
    digest: sourceManifestKindDigestV1(kind, batches),
  }));
  const capturedConstituents = manifest.map((entry, index) => ({
    kind: entry.kind,
    generationRef: `demo-${entry.kind}-constituent-${sequence}`,
    sourceAsOf: addMinutes(sourceAsOf, index),
    itemCount: entry.itemCount,
    digest: canonicalDigestV1(facts[entry.kind]),
  }));
  const request = parseSourceGenerationCreateRequestV1({
    contractVersion: '1.0',
    connectorRef: 'demo-connector-v1',
    sourceGeneration,
    sourceSequence: sequence,
    sourceAsOf,
    coverageStart: '2023-08-01',
    coverageEnd: '2026-08-10',
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    capturedConstituents,
    manifest,
    idempotencyKey: `source-generation-sequence-${sequence}-v1`,
  });
  return {
    request,
    batches,
    commit: {
      contractVersion: '1.0',
      sourceGeneration,
      expectedSourceSequence: sequence,
      manifestDigest: sourceManifestDigestV1(manifest),
      idempotencyKey: `source-generation-commit-${sequence}-v1`,
    },
  };
}

function makePublicationForConnector(
  connectorRef: string,
  sequence: number,
  sourceAsOf: string
): Publication {
  const base = makePublication(sequence, sourceAsOf);
  const sourceGeneration = `${connectorRef}-generation-${sequence}`;
  const batches = base.batches.map((batch) =>
    parseSourceFactBatchV1({
      ...batch,
      sourceGeneration,
      idempotencyKey: `${connectorRef}-${batch.kind}-batch-${sequence}`,
    })
  );
  const request = parseSourceGenerationCreateRequestV1({
    ...base.request,
    connectorRef,
    sourceGeneration,
    idempotencyKey: `${connectorRef}-source-generation-${sequence}`,
  });
  return {
    request,
    batches,
    commit: {
      ...base.commit,
      sourceGeneration,
      idempotencyKey: `${connectorRef}-source-commit-${sequence}`,
    },
  };
}

function transactionFact(
  suffix: string,
  amountMinor: number,
  overrides: Partial<{
    isPending: boolean;
    categoryRef: string | null;
    tagRefs: string[];
    recurringRef: string | null;
  }> = {}
) {
  return {
    sourceRef: `demo-transaction-${suffix}`,
    occurredOn: '2026-08-10',
    amountMinor,
    merchantName: `Demo Merchant ${suffix}`,
    categoryRef: overrides.categoryRef ?? 'demo-category-utility',
    accountRef: 'demo-account-household',
    isPending: overrides.isPending ?? false,
    recurringRef: overrides.recurringRef ?? null,
    tagRefs: overrides.tagRefs ?? [],
  };
}

async function stage(harness: Harness, publication: Publication): Promise<void> {
  await harness.service.beginSourceGeneration(publication.request);
  for (const batch of publication.batches) {
    await harness.service.putSourceBatch(batch);
  }
}

async function publish(harness: Harness, publication: Publication) {
  await stage(harness, publication);
  return harness.service.commitSourceGeneration(
    publication.request.connectorRef,
    publication.commit
  );
}

function projectionFrom(batches: readonly SourceFactBatchV1[]) {
  const facts = (kind: SourceFactKindV1) =>
    batches
      .filter((batch) => batch.kind === kind)
      .flatMap((batch) => batch.facts)
      .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  return {
    transactions: facts('transaction'),
    recurring: facts('recurring'),
    categories: facts('category'),
    accounts: facts('account'),
    tags: facts('tag'),
  };
}

async function makeDetail(
  assignment: AssignedEvaluationV1,
  source: SourceGenerationCreateRequestV1,
  occurrenceId?: string,
  freshness: 'fresh' | 'stale' = 'fresh'
): Promise<InsightOccurrenceDetailV1> {
  const fixture = (await loadFixture('occurrence-detail')) as InsightOccurrenceDetailV1;
  const completedAt =
    freshness === 'fresh'
      ? addSeconds(assignment.acceptedAt, 1)
      : '2026-08-13T16:00:01Z';
  return parseInsightOccurrenceDetailV1({
    ...fixture,
    occurrenceId: occurrenceId ?? fixture.occurrenceId,
    freshness: {
      state: freshness,
      sourceAsOf: source.sourceAsOf,
      maxAgeHours: 48,
      warningReason: freshness === 'fresh' ? null : 'source_stale',
    },
    provenance: {
      ...fixture.provenance,
      connectorRef: source.connectorRef,
      sourceGeneration: source.sourceGeneration,
      sourceAsOf: source.sourceAsOf,
      coverageStart: source.coverageStart,
      coverageEnd: source.coverageEnd,
      bridgeContractVersion: source.bridgeContractVersion,
      detectorSetVersion: assignment.identity.detectorSetVersion,
      policyVersion: assignment.identity.policyVersion,
      evaluationStartedAt: assignment.acceptedAt,
      evaluationCompletedAt: completedAt,
    },
    createdAt: completedAt,
    updatedAt: completedAt,
    lifecycleHistory: [
      {
        sequence: 1,
        state: 'analyzing',
        reasonCode: null,
        occurredAt: assignment.acceptedAt,
        replacementOccurrenceId: null,
      },
      {
        sequence: 2,
        state: 'open',
        reasonCode: null,
        occurredAt: completedAt,
        replacementOccurrenceId: null,
      },
    ],
  });
}

function completedResult(
  detail: InsightOccurrenceDetailV1,
  completedAt = detail.provenance.evaluationCompletedAt,
  details = [detail]
) {
  return {
    state: 'completed' as const,
    summaries: details.map(summaryFrom),
    completedAt,
  };
}

function publicationFor(
  detail: InsightOccurrenceDetailV1
): EvaluationPublicationV1 {
  return {
    occurrences: [
      {
        detail,
        sourceRevisionRef:
          'revision-v1_YzUeFs7O4GgYrvgOUU1GLh0KIp_3tVNMcHdfykm2UMw',
      },
    ],
    transitions: [],
  };
}

function summaryFrom(
  detail: InsightOccurrenceDetailV1
): InsightOccurrenceSummaryV1 {
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
  return summary;
}

async function createPublishedOccurrenceHarness() {
  const harness = await createHarness();
  const source = makePublication(1, '2026-08-10T15:00:00Z');
  const committed = await publish(harness, source);
  const detail = await makeDetail(committed.evaluation!.assignment, source.request);
  await harness.service.completeEvaluation(
    committed.evaluation!.assignment,
    completedResult(detail),
    publicationFor(detail)
  );
  return { ...harness, detail };
}

function defaultListQuery() {
  return {
    kind: [],
    sourceLifecycle: ['open'] as const,
    analysisState: ['qualified'] as const,
    severity: [],
    baselineSufficiency: [],
    connectorRef: null,
    updatedAfter: null,
    limit: 50,
    cursor: null,
  };
}

function withManifestBatchCount(
  input: SourceGenerationCreateRequestV1,
  kind: SourceFactKindV1,
  batchCount: number
): SourceGenerationCreateRequestV1 {
  return parseSourceGenerationCreateRequestV1({
    ...input,
    sourceGeneration: 'demo-overlap-generation-v1',
    sourceSequence: 3,
    idempotencyKey: 'demo-overlap-generation-idempotency',
    manifest: input.manifest.map((entry) =>
      entry.kind === kind ? { ...entry, batchCount, itemCount: 2 } : entry
    ),
    capturedConstituents: input.capturedConstituents.map((entry) =>
      entry.kind === kind ? { ...entry, itemCount: 2 } : entry
    ),
  });
}

async function expectStoreError(
  operation: Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(FinanceInsightStoreError);
    expect((error as FinanceInsightStoreError).descriptor.body.error.code).toBe(
      code
    );
  }
}

function addMinutes(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}
