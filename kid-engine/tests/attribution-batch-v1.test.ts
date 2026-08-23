import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_BATCH_MAX_ITEMS,
  ATTRIBUTION_BATCH_PROVENANCE,
  AttributionBatchError,
  AttributionBatchService,
} from '../src/attribution-batch-v1.js';
import { ContractValidationError, type PolicyActorV1 } from '../src/contracts/v1.js';
import {
  PolicyAuthorizationError,
  type PolicyRepository,
} from '../src/policy/service.js';
import { policyFixture } from './fixtures.js';

const actor: PolicyActorV1 = {
  actorId: 'mission-control-service',
  householdId: policyFixture.householdId,
  permissions: ['attribution:batch'],
};

describe('v1 batch attribution service', () => {
  it('evaluates a bounded batch against one policy version', async () => {
    const service = new AttributionBatchService(repository(), {
      now: () => new Date('2026-08-08T13:00:00Z'),
    });
    const response = await service.attribute(actor, request([item('source-one'), item('source-two')]));

    expect(response).toMatchObject({
      contractVersion: '2.0',
      policyVersion: 1,
      engineVersion: '2.0.0',
    });
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({
      sourceRef: 'source-one',
      status: 'pending',
      confidence: 'likely',
      method: 'merchant-rule',
      reviewStatus: 'pending',
      reasons: ['low-confidence'],
      policyVersion: 1,
      engineVersion: '2.0.0',
      evaluatedAt: '2026-08-08T13:00:00.000Z',
    });
    expect(JSON.stringify(response)).not.toContain('merchantName');
    expect(JSON.stringify(response)).not.toContain('accountRef');
  });

  it('preserves safe manual context without accepting a free-form explanation', async () => {
    const service = new AttributionBatchService(repository(), {
      now: () => new Date('2026-08-08T13:00:00Z'),
    });
    const manualItem = {
      ...item('source-manual'),
      existingManualDecision: {
        action: 'assign-kid',
        kidId: 'kid-alpha',
        decidedAt: '2026-08-08T12:59:00Z',
      },
    };
    const response = await service.attribute(actor, request([manualItem]));

    expect(response.results[0]).toMatchObject({
      status: 'attributed',
      kidId: 'kid-alpha',
      confidence: 'definite',
      method: 'manual',
      explanation: 'An existing manual decision is preserved.',
      reviewStatus: 'resolved',
      reasons: [],
      decisionSource: 'manual',
    });
  });

  it('rejects private transaction fields and duplicate source references', async () => {
    const service = new AttributionBatchService(repository());
    await expect(
      service.attribute(
        actor,
        request([{ ...item('source-private'), amount: 42 }])
      )
    ).rejects.toBeInstanceOf(ContractValidationError);
    await expect(
      service.attribute(actor, request([item('source-duplicate'), item('source-duplicate')]))
    ).rejects.toBeInstanceOf(ContractValidationError);
    await expect(
      service.attribute(actor, request([item(' source-whitespace ')]))
    ).rejects.toBeInstanceOf(ContractValidationError);
  });

  it('enforces batch and policy version bounds', async () => {
    const service = new AttributionBatchService(repository());
    await expect(
      service.attribute(
        actor,
        request(
          Array.from({ length: ATTRIBUTION_BATCH_MAX_ITEMS + 1 }, (_, index) =>
            item(`source-${index}`)
          )
        )
      )
    ).rejects.toMatchObject({ code: 'batch_too_large' });
    await expect(
      service.attribute(actor, {
        ...request([item('source-conflict')]),
        expectedPolicyVersion: 2,
      })
    ).rejects.toMatchObject({ code: 'policy_conflict' });
  });

  it('fails closed for missing or concurrently changed policy', async () => {
    const missing = new AttributionBatchService(repository(null));
    await expect(
      missing.attribute(actor, request([item('source-missing')]))
    ).rejects.toEqual(
      expect.objectContaining<Partial<AttributionBatchError>>({
        code: 'policy_unavailable',
      })
    );
    const changed = new AttributionBatchService(repository(policyFixture, false));
    await expect(
      changed.attribute(actor, request([item('source-race')]))
    ).rejects.toMatchObject({ code: 'policy_conflict' });
  });

  it('requires the dedicated least-privilege permission', async () => {
    const service = new AttributionBatchService(repository());
    await expect(
      service.attribute(
        { ...actor, permissions: ['policy:read'] },
        request([item('source-forbidden')])
      )
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
  });
});

function request(items: unknown[]) {
  return {
    contractVersion: '2.0',
    provenance: ATTRIBUTION_BATCH_PROVENANCE,
    expectedPolicyVersion: null,
    items,
  };
}

function item(sourceRef: string) {
  return {
    sourceRef,
    occurredOn: '2026-08-08',
    merchantName: 'Synthetic Shop',
    accountRef: 'account-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    observedAt: '2026-08-08T12:58:00Z',
    existingManualDecision: null,
  };
}

function repository(
  policy: typeof policyFixture | null = policyFixture,
  fenceMatches = true
): PolicyRepository {
  return {
    async load() {
      return policy ? structuredClone(policy) : null;
    },
    async save() {
      throw new Error('not used');
    },
    async listAudit() {
      return [];
    },
    async withPolicyVersionFence(_householdId, _version, operation) {
      return fenceMatches ? operation() : null;
    },
  };
}
