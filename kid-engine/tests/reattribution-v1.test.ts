import { describe, expect, it } from 'vitest';
import {
  ReattributionError,
  ReattributionService,
  type ReattributionApplyCountsV1,
  type ReattributionRecordV1,
  type ReattributionRepository,
} from '../src/reattribution-v1.js';
import type {
  PolicyActorV1,
  PolicyAuditEventV1,
  PolicySnapshotV1,
  ReattributionPreviewV1,
} from '../src/contracts/v1.js';
import type { PolicyRepository } from '../src/policy/service.js';
import { inputFixture, policyFixture } from './fixtures.js';
import { createUnavailableAttributionResultV1 } from '../src/attribution-v1.js';

const previewActor: PolicyActorV1 = {
  actorId: 'actor-demo',
  householdId: 'household-demo',
  permissions: ['reattribution:preview'],
};
const applyActor: PolicyActorV1 = {
  ...previewActor,
  permissions: ['reattribution:apply'],
};

describe('controlled re-attribution service', () => {
  it('creates and persists an ordered preview without applying it', async () => {
    const records = new MemoryReattributionRepository([
      {
        input: inputFixture,
        current: createUnavailableAttributionResultV1(
          inputFixture,
          'policy-unavailable',
          '2026-08-08T12:02:00Z'
        ),
      },
    ]);
    const service = createService(records);
    const preview = await service.preview(previewActor, {
      contractVersion: '2.0',
      householdId: 'household-demo',
      expectedPolicyVersion: 1,
      sourceRefs: ['source-record-demo'],
    });
    expect(preview).toMatchObject({
      previewId: 'preview-demo',
      policyVersion: 1,
      items: [{ disposition: 'pending-review' }],
    });
    expect(records.applied).toBe(false);
  });

  it('preserves manual corrections in preview disposition', async () => {
    const manualInput = {
      ...inputFixture,
      existingManualDecision: {
        action: 'parent-expense' as const,
        kidId: null,
        actorId: 'actor-demo',
        decidedAt: '2026-08-08T12:02:00Z',
        explanation: 'Household operator marked this as a parent expense.',
      },
    };
    const current = createUnavailableAttributionResultV1(
      manualInput,
      'engine-unavailable',
      '2026-08-08T12:02:00Z'
    );
    const records = new MemoryReattributionRepository([
      { input: manualInput, current },
    ]);
    const preview = await createService(records).preview(previewActor, {
      contractVersion: '2.0',
      householdId: 'household-demo',
      expectedPolicyVersion: 1,
      sourceRefs: ['source-record-demo'],
    });
    expect(preview.items[0].disposition).toBe('manual-preserved');
  });

  it('requires apply permission and explicit persisted preview confirmation', async () => {
    const records = new MemoryReattributionRepository([
      {
        input: inputFixture,
        current: createUnavailableAttributionResultV1(
          inputFixture,
          'policy-unavailable',
          '2026-08-08T12:02:00Z'
        ),
      },
    ]);
    const service = createService(records);
    await service.preview(previewActor, {
      contractVersion: '2.0',
      householdId: 'household-demo',
      expectedPolicyVersion: 1,
      sourceRefs: ['source-record-demo'],
    });
    await expect(
      service.apply(previewActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: true,
      })
    ).rejects.toMatchObject({ code: 'policy_forbidden' });
    const result = await service.apply(applyActor, {
      contractVersion: '2.0',
      householdId: 'household-demo',
      previewId: 'preview-demo',
      expectedPolicyVersion: 1,
      confirm: true,
    });
    expect(result).toMatchObject({
      previewId: 'preview-demo',
      pendingReview: 1,
    });
    expect(records.applied).toBe(true);
  });

  it('rejects apply after the preview expires or policy changes', async () => {
    const records = new MemoryReattributionRepository([]);
    records.preview = {
      contractVersion: '2.0',
      previewId: 'preview-demo',
      householdId: 'household-demo',
      policyVersion: 1,
      createdAt: '2026-08-08T11:00:00Z',
      expiresAt: '2026-08-08T11:15:00Z',
      items: [],
    };
    await expect(
      createService(records).apply(applyActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: true,
      })
    ).rejects.toMatchObject({ code: 'reattribution_preview_expired' });
    const changedPolicy = { ...policyFixture, policyVersion: 2 };
    await expect(
      createService(records, changedPolicy).apply(applyActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: true,
      })
    ).rejects.toBeInstanceOf(ReattributionError);
  });

  it('rejects an apply-time atomic policy compare-and-swap failure', async () => {
    const records = new MemoryReattributionRepository([]);
    records.preview = {
      contractVersion: '2.0',
      previewId: 'preview-demo',
      householdId: 'household-demo',
      policyVersion: 1,
      createdAt: '2026-08-08T12:00:00Z',
      expiresAt: '2026-08-08T12:15:00Z',
      items: [],
    };
    records.policyMatchesAtApply = false;
    await expect(
      createService(records).apply(applyActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: true,
      })
    ).rejects.toMatchObject({ code: 'policy_version_conflict' });
    expect(records.applied).toBe(false);
  });

  it('rejects a repository record or preview that does not match the selection', async () => {
    const mismatchedCurrent = createUnavailableAttributionResultV1(
      inputFixture,
      'policy-unavailable',
      '2026-08-08T12:02:00Z'
    );
    mismatchedCurrent.sourceRef = 'source-record-other';
    await expect(
      createService(
        new MemoryReattributionRepository([
          { input: inputFixture, current: mismatchedCurrent },
        ])
      ).preview(previewActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        expectedPolicyVersion: 1,
        sourceRefs: ['source-record-demo'],
      })
    ).rejects.toMatchObject({ code: 'reattribution_source_mismatch' });

    const records = new MemoryReattributionRepository([]);
    records.preview = {
      contractVersion: '2.0',
      previewId: 'preview-other',
      householdId: 'household-demo',
      policyVersion: 1,
      createdAt: '2026-08-08T12:00:00Z',
      expiresAt: '2026-08-08T12:15:00Z',
      items: [],
    };
    await expect(
      createService(records).apply(applyActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: true,
      })
    ).rejects.toMatchObject({ code: 'reattribution_preview_invalid' });
  });

  it('rejects malformed persisted preview expiration before apply', async () => {
    const records = new MemoryReattributionRepository([]);
    records.preview = {
      contractVersion: '2.0',
      previewId: 'preview-demo',
      householdId: 'household-demo',
      policyVersion: 1,
      createdAt: '2026-08-08T12:00:00Z',
      expiresAt: 'not-a-timestamp',
      items: [],
    };
    await expect(
      createService(records).apply(applyActor, {
        contractVersion: '2.0',
        householdId: 'household-demo',
        previewId: 'preview-demo',
        expectedPolicyVersion: 1,
        confirm: true,
      })
    ).rejects.toMatchObject({ code: 'reattribution_preview_invalid' });
    expect(records.applied).toBe(false);
  });
});

function createService(
  records: MemoryReattributionRepository,
  policy: PolicySnapshotV1 = policyFixture
): ReattributionService {
  return new ReattributionService(
    new StaticPolicyRepository(policy),
    records,
    {
      now: () => new Date('2026-08-08T12:03:00Z'),
      previewId: () => 'preview-demo',
    }
  );
}

class StaticPolicyRepository implements PolicyRepository {
  constructor(private readonly policy: PolicySnapshotV1) {}

  async load(): Promise<PolicySnapshotV1> {
    return structuredClone(this.policy);
  }

  async save(
    _snapshot: PolicySnapshotV1,
    _expectedPolicyVersion: number | null,
    _auditEvent: PolicyAuditEventV1
  ): Promise<void> {
    throw new Error('not used');
  }

  async listAudit(): Promise<PolicyAuditEventV1[]> {
    return [];
  }

  async withPolicyVersionFence<T>(
    householdId: string,
    expectedPolicyVersion: number,
    operation: () => Promise<T>
  ): Promise<T | null> {
    if (
      this.policy.householdId !== householdId ||
      this.policy.policyVersion !== expectedPolicyVersion
    ) {
      return null;
    }
    return operation();
  }
}

class MemoryReattributionRepository implements ReattributionRepository {
  preview: ReattributionPreviewV1 | null = null;
  applied = false;
  policyMatchesAtApply = true;

  constructor(private readonly records: ReattributionRecordV1[]) {}

  async loadRecords(): Promise<ReattributionRecordV1[]> {
    return structuredClone(this.records);
  }

  async savePreview(preview: ReattributionPreviewV1): Promise<void> {
    this.preview = structuredClone(preview);
  }

  async loadPreview(): Promise<ReattributionPreviewV1 | null> {
    return this.preview ? structuredClone(this.preview) : null;
  }

  async applyPreviewIfPolicyVersion(
    preview: ReattributionPreviewV1,
    _appliedAt: string,
    expectedPolicyVersion: number
  ): Promise<ReattributionApplyCountsV1 | null> {
    expect(expectedPolicyVersion).toBe(preview.policyVersion);
    if (!this.policyMatchesAtApply) return null;
    this.applied = true;
    return {
      applied: preview.items.filter((item) => item.disposition === 'would-update')
        .length,
      unchanged: preview.items.filter((item) => item.disposition === 'unchanged')
        .length,
      manualPreserved: preview.items.filter(
        (item) => item.disposition === 'manual-preserved'
      ).length,
      pendingReview: preview.items.filter(
        (item) => item.disposition === 'pending-review'
      ).length,
    };
  }
}
