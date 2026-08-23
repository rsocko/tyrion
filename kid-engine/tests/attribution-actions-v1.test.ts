import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_ACTION_PROVENANCE,
  AttributionActionError,
  AttributionActionService,
  parseAttributionActionRequestV1,
  type AttributionActionApplyResultV1,
  type AttributionActionMutationV1,
  type AttributionActionRecordV1,
  type AttributionActionRepository,
} from '../src/attribution-actions-v1.js';
import { attributeTransactionV1 } from '../src/attribution-v1.js';
import {
  ContractValidationError,
  type PolicyActorV1,
} from '../src/contracts/v1.js';
import {
  PolicyAuthorizationError,
  type PolicyRepository,
} from '../src/policy/service.js';
import { inputFixture, policyFixture } from './fixtures.js';

const now = '2026-08-08T13:00:00.000Z';
const actor: PolicyActorV1 = {
  actorId: 'mission-control-service',
  householdId: policyFixture.householdId,
  permissions: ['attribution:actions'],
};

describe('v1 attribution correction and exception actions', () => {
  it('explains current attribution with bounded actions and provenance', async () => {
    const actions = new MemoryActionRepository(record());
    const service = createService(actions);

    const result = await service.act(actor, explainRequest());

    expect(result).toMatchObject({
      contractVersion: '2.0',
      sourceRef: inputFixture.source.recordRef,
      policyVersion: 1,
      engineVersion: '2.0.0',
      stateVersion: 1,
      attribution: {
        status: 'pending',
        kidId: 'kid-beta',
        explanation: 'A configured merchant rule matched.',
      },
      exception: { status: 'open', reasons: ['low-confidence'] },
      assignableKidIds: ['kid-alpha', 'kid-beta'],
      authoritativeDeepLink: {
        system: 'monarch',
        target: 'transaction',
        sourceRef: inputFixture.source.recordRef,
      },
      provenance: {
        sourceSystem: 'monarch',
        normalizedBy: 'monarch-bridge',
        decidedBy: 'tyrion',
        decisionSource: 'automated',
      },
      audit: null,
    });
    expect(result.availableActions).toEqual([
      'explain',
      'assign-kid',
      'mark-parent-expense',
      'unassign',
      'resolve-exception',
      'defer-exception',
      'open-in-monarch',
    ]);
    expect(JSON.stringify(result)).not.toContain('merchantName');
    expect(JSON.stringify(result)).not.toContain('accountRef');
  });

  it.each([
    {
      action: 'assign-kid' as const,
      extra: { kidId: 'kid-alpha' },
      status: 'attributed',
      kidId: 'kid-alpha',
      manualAction: 'assign-kid',
      explanation: 'A household operator assigned this transaction to a kid.',
    },
    {
      action: 'mark-parent-expense' as const,
      extra: {},
      status: 'unassigned',
      kidId: null,
      manualAction: 'parent-expense',
      explanation:
        'A household operator marked this transaction as a parent expense.',
    },
    {
      action: 'unassign' as const,
      extra: {},
      status: 'unassigned',
      kidId: null,
      manualAction: 'unassign',
      explanation:
        'A household operator explicitly left this transaction unassigned.',
    },
    {
      action: 'resolve-exception' as const,
      extra: {},
      status: 'attributed',
      kidId: 'kid-beta',
      manualAction: 'assign-kid',
      explanation:
        'A household operator confirmed the current kid attribution.',
    },
  ])(
    'applies confirmed $action with manual decision and audit state',
    async ({
      action,
      extra,
      status,
      kidId,
      manualAction,
      explanation,
    }) => {
      const actions = new MemoryActionRepository(record());
      const service = createService(actions);

      const result = await service.act(actor, mutationRequest(action, extra));

      expect(result.attribution).toMatchObject({
        status,
        kidId,
        confidence: 'definite',
        method: 'manual',
        explanation,
        review: { status: 'resolved', reasons: [] },
        provenance: {
          decisionSource: 'manual',
          policyVersion: 1,
          engineVersion: '2.0.0',
          ruleIds: [],
          evaluatedAt: now,
        },
      });
      expect(result.exception).toEqual({
        status: 'resolved',
        reasons: [],
        deferredUntil: null,
        updatedAt: now,
      });
      expect(result.audit).toMatchObject({
        actionRef: 'action-demo',
        idempotencyKey: `action-${action}`,
        action,
        actorId: actor.actorId,
        outcome: 'applied',
        previousStateVersion: 1,
        stateVersion: 2,
        policyVersion: 1,
        appliedAt: now,
      });
      expect(actions.current.input.existingManualDecision).toMatchObject({
        action: manualAction,
        kidId,
        actorId: actor.actorId,
        explanation,
      });
      expect(result.availableActions).toEqual([
        'explain',
        'assign-kid',
        'mark-parent-expense',
        'unassign',
        'open-in-monarch',
      ]);
    }
  );

  it('defers an open exception without changing attribution', async () => {
    const actions = new MemoryActionRepository(record());
    const service = createService(actions);
    const before = structuredClone(actions.current.attribution);

    const result = await service.act(
      actor,
      mutationRequest('defer-exception', {
        deferUntil: '2026-08-15T13:00:00.000Z',
      })
    );

    expect(result.attribution).toEqual(before);
    expect(result.exception).toEqual({
      status: 'deferred',
      reasons: ['low-confidence'],
      deferredUntil: '2026-08-15T13:00:00.000Z',
      updatedAt: now,
    });
    expect(result.audit?.action).toBe('defer-exception');
  });

  it('requires confirmation and a bounded future defer window', async () => {
    expect(() =>
      parseAttributionActionRequestV1({
        ...mutationRequest('unassign'),
        confirm: false,
      })
    ).toThrow(ContractValidationError);
    const service = createService(new MemoryActionRepository(record()));
    await expect(
      service.act(
        actor,
        mutationRequest('defer-exception', {
          deferUntil: '2026-09-08T13:00:00.001Z',
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_defer_window' });
  });

  it('rejects policy/state conflicts, missing records, and inactive kids', async () => {
    const actions = new MemoryActionRepository(record());
    const service = createService(actions);
    await expect(
      service.act(actor, { ...explainRequest(), expectedPolicyVersion: 2 })
    ).rejects.toMatchObject({ code: 'policy_conflict' });
    await expect(
      service.act(actor, {
        ...mutationRequest('unassign'),
        expectedStateVersion: 2,
      })
    ).rejects.toMatchObject({ code: 'attribution_state_conflict' });
    await expect(
      service.act(
        actor,
        mutationRequest('assign-kid', { kidId: 'kid-not-active' })
      )
    ).rejects.toMatchObject({ code: 'kid_not_assignable' });
    await expect(
      createService(new MemoryActionRepository(null)).act(actor, explainRequest())
    ).rejects.toMatchObject({ code: 'attribution_not_found' });
  });

  it('fails closed when the policy changes during mutation', async () => {
    const service = new AttributionActionService(
      policyRepository(false),
      new MemoryActionRepository(record()),
      {
        now: () => new Date(now),
        actionRef: () => 'action-demo',
      }
    );
    await expect(
      service.act(actor, mutationRequest('unassign'))
    ).rejects.toMatchObject({ code: 'policy_conflict' });
  });

  it('replays the last matching action without applying it twice', async () => {
    const actions = new MemoryActionRepository(record());
    const service = createService(actions);
    const request = mutationRequest('unassign');

    const first = await service.act(actor, request);
    const replay = await service.act(actor, request);

    expect(first.audit?.outcome).toBe('applied');
    expect(replay.audit).toMatchObject({
      actionRef: first.audit?.actionRef,
      outcome: 'replayed',
      stateVersion: 2,
    });
    expect(actions.applyCalls).toBe(1);
  });

  it('rejects idempotency-key reuse with different action parameters', async () => {
    const actions = new MemoryActionRepository(record());
    const service = createService(actions);
    await service.act(
      actor,
      mutationRequest('assign-kid', { kidId: 'kid-alpha' })
    );

    await expect(
      service.act(
        actor,
        mutationRequest('assign-kid', { kidId: 'kid-beta' })
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(actions.applyCalls).toBe(1);
  });

  it('replays an earlier action after newer action history exists', async () => {
    const actions = new MemoryActionRepository(record());
    const service = createService(actions);
    const firstRequest = mutationRequest('unassign');
    const first = await service.act(actor, firstRequest);
    await service.act(actor, {
      ...mutationRequest('assign-kid', { kidId: 'kid-alpha' }),
      expectedStateVersion: 2,
    });

    const replay = await service.act(actor, firstRequest);

    expect(replay.stateVersion).toBe(first.stateVersion);
    expect(replay.audit).toMatchObject({
      action: 'unassign',
      outcome: 'replayed',
    });
    expect(actions.applyCalls).toBe(2);
  });

  it('requires the dedicated least-privilege permission', async () => {
    const service = createService(new MemoryActionRepository(record()));
    await expect(
      service.act(
        { ...actor, permissions: ['attribution:batch'] },
        explainRequest()
      )
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
  });

  it('rejects resolving an exception without a current kid suggestion', async () => {
    const current = record();
    current.attribution = {
      ...current.attribution,
      status: 'unassigned',
      kidId: null,
      confidence: 'none',
      method: 'unassigned',
      explanation: 'No attribution rule matched.',
      review: { status: 'pending', reasons: ['no-match'] },
    };
    current.exception.reasons = ['no-match'];
    await expect(
      createService(new MemoryActionRepository(current)).act(
        actor,
        mutationRequest('resolve-exception')
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<AttributionActionError>>({
        code: 'action_not_available',
      })
    );
  });

  it('requires a current-policy suggestion before resolving an exception', async () => {
    const current = record();
    current.attribution.provenance.policyVersion = null;
    const service = createService(new MemoryActionRepository(current));

    expect((await service.act(actor, explainRequest())).availableActions).not.toContain(
      'resolve-exception'
    );
    await expect(
      service.act(actor, mutationRequest('resolve-exception'))
    ).rejects.toMatchObject({ code: 'policy_conflict' });
  });

  it('rejects reserved identifiers in action requests', () => {
    expect(() =>
      parseAttributionActionRequestV1({
        ...explainRequest(),
        sourceRef: 'constructor',
      })
    ).toThrow('reserved');
  });
});

function createService(actions: AttributionActionRepository) {
  return new AttributionActionService(policyRepository(), actions, {
    now: () => new Date(now),
    actionRef: () => 'action-demo',
  });
}

function explainRequest() {
  return {
    contractVersion: '2.0',
    provenance: ATTRIBUTION_ACTION_PROVENANCE,
    sourceRef: inputFixture.source.recordRef,
    expectedPolicyVersion: 1,
    action: 'explain',
  };
}

function mutationRequest(
  action:
    | 'assign-kid'
    | 'mark-parent-expense'
    | 'unassign'
    | 'resolve-exception'
    | 'defer-exception',
  extra: Record<string, unknown> = {}
) {
  return {
    ...explainRequest(),
    action,
    expectedStateVersion: 1,
    idempotencyKey: `action-${action}`,
    confirm: true,
    ...extra,
  };
}

function record(): AttributionActionRecordV1 {
  const attribution = attributeTransactionV1(inputFixture, policyFixture, {
    evaluatedAt: '2026-08-08T12:05:00.000Z',
  });
  return {
    input: structuredClone(inputFixture),
    attribution,
    stateVersion: 1,
    exception: {
      status: 'open',
      reasons: structuredClone(attribution.review.reasons),
      deferredUntil: null,
      updatedAt: attribution.provenance.evaluatedAt,
    },
    lastAction: null,
  };
}

function policyRepository(fenceMatches = true): PolicyRepository {
  let loadCount = 0;
  return {
    async load() {
      loadCount += 1;
      if (!fenceMatches && loadCount > 1) {
        return { ...structuredClone(policyFixture), policyVersion: 2 };
      }
      return structuredClone(policyFixture);
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

class MemoryActionRepository implements AttributionActionRepository {
  applyCalls = 0;
  private readonly replays = new Map<
    string,
    AttributionActionApplyResultV1
  >();

  constructor(public current: AttributionActionRecordV1 | null) {}

  async load(): Promise<AttributionActionRecordV1 | null> {
    return this.current ? structuredClone(this.current) : null;
  }

  async loadReplay(
    _householdId: string,
    _sourceRef: string,
    idempotencyKey: string
  ): Promise<AttributionActionApplyResultV1 | null> {
    const replay = this.replays.get(idempotencyKey);
    return replay
      ? { ...structuredClone(replay), replayed: true }
      : null;
  }

  async applyIfCurrent(
    _householdId: string,
    mutation: AttributionActionMutationV1
  ): Promise<AttributionActionApplyResultV1 | null> {
    this.applyCalls += 1;
    const replay = this.replays.get(mutation.request.idempotencyKey);
    if (replay) return { ...structuredClone(replay), replayed: true };
    if (
      !this.current ||
      this.current.stateVersion !== mutation.request.expectedStateVersion
    ) {
      return null;
    }
    const stateVersion = this.current.stateVersion + 1;
    this.current = {
      input: structuredClone(mutation.input),
      attribution: structuredClone(mutation.attribution),
      stateVersion,
      exception: structuredClone(mutation.exception),
      lastAction: {
        ...structuredClone(mutation.audit),
        outcome: 'applied',
        stateVersion,
      },
    };
    const result = {
      record: structuredClone(this.current),
      replayed: false,
      requestFingerprint: mutation.requestFingerprint,
    };
    this.replays.set(mutation.request.idempotencyKey, structuredClone(result));
    return result;
  }
}
