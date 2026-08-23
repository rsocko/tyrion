import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
  FinanceInsightEvaluationOrchestratorV1,
  FinanceInsightLifecycleServiceV1,
  FinanceInsightSqliteStoreV1,
  canonicalDigestV1,
  createCandidatePolicySnapshotV1,
  parseFinanceInsightPolicySnapshotV1,
  parseSourceFactBatchV1,
  parseSourceGenerationCreateRequestV1,
  sourceManifestDigestV1,
  sourceManifestKindDigestV1,
  type FinanceInsightPolicySnapshotV1,
  type FinanceInsightTelemetryEventV1,
  type SourceFactBatchV1,
  type SourceFactKindV1,
  type TransactionSourceFactV1,
} from '../src/index.js';

const directories: string[] = [];
const stores: FinanceInsightSqliteStoreV1[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may close and reopen the store.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('finance insight evaluation orchestration', () => {
  it('claims and composes all three detectors into one exact publication', async () => {
    const harness = await createHarness(enabledPolicy());
    const publication = makePublication(1, detectorTransactions());
    const assignment = await stageAndCommit(harness, publication);
    const result = await harness.orchestrator.run(assignment);

    expect(result.state).toBe('completed');
    const page = await harness.store.listOccurrences({
      kind: [],
      sourceLifecycle: [],
      analysisState: [],
      severity: [],
      baselineSufficiency: [],
      connectorRef: publication.request.connectorRef,
      updatedAfter: null,
      limit: 100,
      cursor: null,
    });
    expect(new Set(page.items.map((item) => item.kind))).toEqual(
      new Set([
        'recurringAmountChange',
        'largeTransaction',
        'categoryVariance',
        'merchantVariance',
      ])
    );
    expect(harness.events).toEqual([
      { name: 'evaluation_started', detectorCount: 3 },
      expect.objectContaining({
        name: 'evaluation_completed',
        detectorCount: 3,
        empty: false,
      }),
    ]);
  });

  it('records an exact completed empty publication when analysis gates are off', async () => {
    const harness = await createHarness(basePolicy());
    const publication = makePublication(1, []);
    const assignment = await stageAndCommit(harness, publication);

    expect(await harness.orchestrator.run(assignment)).toMatchObject({
      state: 'completed',
    });
    expect(
      await harness.store.listOccurrencePublications(
        publication.request.connectorRef,
        100
      )
    ).toEqual([]);
    expect(harness.events.at(-1)).toMatchObject({
      name: 'evaluation_completed',
      occurrenceCount: 0,
      transitionCount: 0,
      empty: true,
    });
  });

  it('publishes no new occurrence for stale promoted input', async () => {
    const harness = await createHarness(enabledPolicy());
    const publication = makePublication(1, detectorTransactions(), {
      sourceAsOf: '2026-08-01T12:00:00Z',
    });
    const assignment = await stageAndCommit(harness, publication);

    expect(await harness.orchestrator.run(assignment)).toMatchObject({
      state: 'completed',
    });
    const persisted = await harness.store.listOccurrencePublications(
      publication.request.connectorRef,
      100
    );
    expect(
      persisted.filter(
        (item) =>
          item.detail.analysisState === 'qualified' &&
          item.detail.sourceLifecycle === 'open'
      )
    ).toEqual([]);
    expect(
      persisted.every((item) => item.detail.freshness.state !== 'fresh')
    ).toBe(true);
  });

  it('does not infer seasonal sufficiency from a truthful 365-day composite', async () => {
    const harness = await createHarness(enabledPolicy());
    const transactions = [
      transaction('annual-current', '2026-08-10', -40_000, {
        merchantName: 'Invented Annual Utility',
        categoryRef: 'category-utility',
        recurringRef: 'recurring-utility',
      }),
      ...Array.from({ length: 11 }, (_, index) => {
        const date = new Date(Date.UTC(2025, 8 + index, 10));
        return transaction(
          `annual-history-${index}`,
          date.toISOString().slice(0, 10),
          -20_000,
          {
            merchantName: 'Invented Annual Utility',
            categoryRef: 'category-utility',
            recurringRef: 'recurring-utility',
          }
        );
      }),
    ];
    const publication = makePublication(1, transactions, {
      coverageStart: '2025-08-11',
      coverageEnd: '2026-08-10',
    });
    const assignment = await stageAndCommit(harness, publication);

    expect(await harness.orchestrator.run(assignment)).toMatchObject({
      state: 'completed',
    });
    const persisted = await harness.store.listOccurrencePublications(
      publication.request.connectorRef,
      100
    );
    expect(
      persisted.filter(
        (item) =>
          item.detail.kind === 'recurringAmountChange' &&
          item.detail.analysisState === 'qualified' &&
          item.detail.sourceLifecycle === 'open'
      )
    ).toEqual([]);
  });

  it('allows only one concurrent claimant and bounds operator batches', async () => {
    const harness = await createHarness(basePolicy());
    const publication = makePublication(1, []);
    const assignment = await stageAndCommit(harness, publication);
    const attempts = await Promise.allSettled([
      harness.orchestrator.run(assignment),
      harness.orchestrator.run(assignment),
    ]);

    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    await expect(harness.orchestrator.runBounded([])).rejects.toMatchObject({
      descriptor: {
        body: { error: { code: 'invalid_request' } },
      },
    });
    await expect(
      harness.orchestrator.runBounded(Array.from({ length: 101 }, () => assignment))
    ).rejects.toMatchObject({
      descriptor: {
        body: { error: { code: 'invalid_request' } },
      },
    });
  });

  it('terminalizes a superseded claim and continues a bounded operator run', async () => {
    const harness = await createHarness(basePolicy());
    const first = makePublication(1, []);
    const firstAssignment = await stageAndCommit(harness, first);
    const second = makePublication(2, []);
    let secondAssignment:
      | Awaited<ReturnType<typeof stageAndCommit>>
      | undefined;
    const racedOrchestrator = new FinanceInsightEvaluationOrchestratorV1({
      store: harness.store,
      lifecycle: harness.lifecycle,
      identityNamespace: Buffer.alloc(32, 5),
      clock: () => '2026-08-11T12:05:00Z',
      testHook: async () => {
        if (!secondAssignment) {
          secondAssignment = await stageAndCommit(harness, second);
        }
      },
    });

    await expect(racedOrchestrator.run(firstAssignment)).rejects.toMatchObject({
      descriptor: {
        body: { error: { code: 'stale_evaluation' } },
      },
    });
    await expect(
      harness.store.evaluations.find(firstAssignment.identity)
    ).resolves.toMatchObject({
      state: 'failed',
      completedAt: '2026-08-11T12:05:00Z',
    });
    expect(secondAssignment).toBeDefined();
    if (!secondAssignment) {
      throw new Error('expected the race hook to promote the second generation');
    }
    await expect(
      racedOrchestrator.runBounded([firstAssignment, secondAssignment])
    ).resolves.toEqual({
      requested: 2,
      completed: 1,
      unavailable: 0,
      failed: 1,
    });
  });
});

interface Harness {
  store: FinanceInsightSqliteStoreV1;
  lifecycle: FinanceInsightLifecycleServiceV1;
  orchestrator: FinanceInsightEvaluationOrchestratorV1;
  events: FinanceInsightTelemetryEventV1[];
}

async function createHarness(
  policy: FinanceInsightPolicySnapshotV1
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'tyrion-orchestrator-'));
  directories.push(directory);
  const store = new FinanceInsightSqliteStoreV1({
    path: join(directory, 'state.sqlite'),
    cursorChecksumNamespace: Buffer.from('finance-insight-cursor-test-v1'),
    clock: () => '2026-08-11T12:00:00Z',
  });
  stores.push(store);
  await store.policies.append(policy);
  const lifecycle = new FinanceInsightLifecycleServiceV1({
    store,
    householdScope: 'homelab-household',
    detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
  });
  const events: FinanceInsightTelemetryEventV1[] = [];
  return {
    store,
    lifecycle,
    events,
    orchestrator: new FinanceInsightEvaluationOrchestratorV1({
      store,
      lifecycle,
      identityNamespace: Buffer.alloc(32, 5),
      telemetry: { emit: (event) => events.push(event) },
      clock: () => '2026-08-11T12:05:00Z',
    }),
  };
}

function basePolicy(): FinanceInsightPolicySnapshotV1 {
  return createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: '2026-08-01T00:00:00Z',
    currency: 'USD',
    timezone: 'America/New_York',
  });
}

function enabledPolicy(): FinanceInsightPolicySnapshotV1 {
  const base = basePolicy();
  return parseFinanceInsightPolicySnapshotV1({
    ...base,
    featureGates: {
      ...base.featureGates,
      recurringAmountAnalysis: true,
      largeTransactionAnalysis: true,
      varianceAnalysis: true,
      recurringAmountNotifications: true,
      immediateLargeTransactionNotifications: true,
      monthlyMoverDigestNotifications: true,
      confirmedActions: true,
    },
  });
}

function detectorTransactions(): TransactionSourceFactV1[] {
  const recurring = [
    transaction('utility-current', '2026-08-10', -40_000, {
      merchantName: 'Invented Utility',
      categoryRef: 'category-utility',
      recurringRef: 'recurring-utility',
    }),
    ...['2025-07-10', '2025-08-10', '2025-09-10', '2024-07-10', '2024-08-10', '2024-09-10'].map(
      (occurredOn, index) =>
        transaction(`utility-history-${index}`, occurredOn, -20_000, {
          merchantName: 'Invented Utility',
          categoryRef: 'category-utility',
          recurringRef: 'recurring-utility',
        })
    ),
  ];
  const large = [
    ...Array.from({ length: 6 }, (_, index) =>
      transaction(
        `large-history-${index}`,
        `2026-0${index + 1}-05`,
        -20_000,
        {
          merchantName: 'Invented Market',
          categoryRef: 'category-market',
        }
      )
    ),
    transaction('large-current', '2026-08-10', -184_000, {
      merchantName: 'Invented Market',
      categoryRef: 'category-market',
    }),
  ];
  const variance = [
    ...['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'].flatMap(
      (occurredOn, monthIndex) =>
        Array.from({ length: 3 }, (_, index) =>
          transaction(
            `variance-history-${monthIndex}-${index}`,
            occurredOn,
            -10_000,
            {
              merchantName: 'Invented Grocer',
              categoryRef: 'category-grocery',
            }
          )
        )
    ),
    transaction('variance-current', '2026-07-15', -90_000, {
      merchantName: 'Invented Grocer',
      categoryRef: 'category-grocery',
    }),
  ];
  return [...recurring, ...large, ...variance];
}

function transaction(
  sourceRef: string,
  occurredOn: string,
  amountMinor: number,
  overrides: Partial<TransactionSourceFactV1> = {}
): TransactionSourceFactV1 {
  return {
    sourceRef,
    occurredOn,
    amountMinor,
    merchantName: 'Invented Merchant',
    categoryRef: 'category-main',
    accountRef: 'account-main',
    isPending: false,
    recurringRef: null,
    tagRefs: [],
    ...overrides,
  };
}

function makePublication(
  sequence: number,
  transactions: readonly TransactionSourceFactV1[],
  options: {
    sourceAsOf?: string;
    coverageStart?: string;
    coverageEnd?: string;
  } = {}
) {
  const sourceGeneration = `orchestrator-generation-${sequence}`;
  const facts = {
    transaction: [...transactions],
    recurring: [
      {
        sourceRef: 'recurring-utility',
        displayName: 'Invented Utility',
        amountMinor: 40_000,
        cadence: 'monthly' as const,
        nextDate: '2026-09-10',
        categoryRef: 'category-utility',
        accountRef: 'account-main',
        active: true,
      },
    ],
    category: ['category-main', 'category-utility', 'category-market', 'category-grocery'].map(
      (sourceRef) => ({
        sourceRef,
        displayName: `Invented ${sourceRef}`,
        groupRef: null,
        active: true,
      })
    ),
    account: [
      {
        sourceRef: 'account-main',
        accountType: 'checking' as const,
        active: true,
      },
    ],
    tag: [
      {
        sourceRef: 'tag-reviewed',
        displayName: 'Invented Reviewed',
        active: true,
      },
    ],
  };
  const batches = (Object.keys(facts) as SourceFactKindV1[]).flatMap((kind) => {
    const kindFacts = facts[kind];
    if (kindFacts.length === 0) return [];
    return [
      parseSourceFactBatchV1({
        contractVersion: '1.0',
        sourceGeneration,
        kind,
        batchIndex: 0,
        facts: kindFacts,
        digest: canonicalDigestV1(kindFacts),
        idempotencyKey: `orchestrator-${kind}-batch-${sequence}`,
      }),
    ];
  });
  const manifest = (Object.keys(facts) as SourceFactKindV1[]).map((kind) => ({
    kind,
    batchCount: facts[kind].length === 0 ? 0 : 1,
    itemCount: facts[kind].length,
    digest: sourceManifestKindDigestV1(kind, batches),
  }));
  const sourceAsOf = options.sourceAsOf ?? '2026-08-11T11:30:00Z';
  const request = parseSourceGenerationCreateRequestV1({
    contractVersion: '1.0',
    connectorRef: 'orchestrator-connector',
    sourceGeneration,
    sourceSequence: sequence,
    sourceAsOf,
    coverageStart: options.coverageStart ?? '2024-01-01',
    coverageEnd: options.coverageEnd ?? '2026-08-10',
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    capturedConstituents: manifest.map((entry, index) => ({
      kind: entry.kind,
      generationRef: `constituent-${entry.kind}-${sequence}`,
      sourceAsOf: addMinutes(sourceAsOf, index),
      itemCount: entry.itemCount,
      digest: canonicalDigestV1(facts[entry.kind]),
    })),
    manifest,
    idempotencyKey: `orchestrator-source-generation-${sequence}`,
  });
  return {
    request,
    batches,
    commit: {
      contractVersion: '1.0' as const,
      sourceGeneration,
      expectedSourceSequence: sequence,
      manifestDigest: sourceManifestDigestV1(manifest),
      idempotencyKey: `orchestrator-source-commit-${sequence}`,
    },
  };
}

async function stageAndCommit(
  harness: Harness,
  publication: ReturnType<typeof makePublication>
) {
  await harness.lifecycle.beginSourceGeneration(publication.request);
  for (const batch of publication.batches as SourceFactBatchV1[]) {
    await harness.lifecycle.putSourceBatch(batch);
  }
  const committed = await harness.lifecycle.commitSourceGeneration(
    publication.request.connectorRef,
    publication.commit
  );
  return committed.evaluation!.assignment;
}

function addMinutes(value: string, minutes: number): string {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
}
