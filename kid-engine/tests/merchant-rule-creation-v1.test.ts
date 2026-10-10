import { describe, expect, it } from 'vitest';
import {
  MerchantRuleCreationError,
  MerchantRuleCreationService,
} from '../src/merchant-rule-creation-v1.js';
import {
  PolicyVersionConflictError,
  type PolicyRepository,
} from '../src/policy/service.js';
import type {
  PolicyActorV1,
  PolicyAuditEventV1,
  PolicySnapshotV1,
} from '../src/contracts/v1.js';
import { policyFixture } from './fixtures.js';

const actor: PolicyActorV1 = {
  actorId: 'mission-control-demo',
  householdId: 'household-demo',
  permissions: ['merchant-rules:create'],
};

const request = {
  contractVersion: '2.0',
  expectedPolicyVersion: 1,
  idempotencyKey: 'rule-create-demo-1',
  confirmation: {
    confirmed: true,
    confirmedAt: '2026-10-09T20:00:00Z',
  },
  rule: {
    outcome: 'kid',
    kidId: 'kid-alpha',
    pattern: 'INVENTED MARKET',
    businessEntityPattern: 'INVENTED HOLDINGS',
    scope: 'accounts',
    accountRefs: ['bridge-account-alpha'],
    confidence: 'likely',
  },
} as const;

describe('merchant rule creation v1', () => {
  it('creates once and replays the same idempotent request across policy versions', async () => {
    const repository = new SeededPolicyRepository(policyFixture);
    const service = new MerchantRuleCreationService(repository, {
      now: () => new Date('2026-10-09T20:01:00Z'),
      eventId: () => 'audit-rule-create',
    });
    const created = await service.create(actor, request, async () => true);
    expect(created).toMatchObject({
      outcome: 'created',
      policyVersion: 2,
      rule: {
        outcome: 'kid',
        scope: 'accounts',
        accountRefs: ['bridge-account-alpha'],
        enabled: true,
      },
    });
    const replayed = await service.create(actor, request, async () => {
      throw new Error('replay must not reload the account catalog');
    });
    expect(replayed).toEqual({ ...created, outcome: 'replayed' });
    expect((await repository.listAudit('household-demo'))).toHaveLength(1);
  });

  it('replays when an identical concurrent request wins the policy write', async () => {
    const repository = new ConcurrentReplayRepository(policyFixture);
    const service = new MerchantRuleCreationService(repository, {
      now: () => new Date('2026-10-09T20:01:00Z'),
      eventId: () => 'audit-rule-create',
    });

    await expect(
      service.create(actor, request, async () => true)
    ).resolves.toMatchObject({
      outcome: 'replayed',
      policyVersion: 2,
      rule: { pattern: 'INVENTED MARKET' },
    });
  });

  it('rejects stale versions, changed idempotent payloads, and unknown accounts', async () => {
    const repository = new SeededPolicyRepository(policyFixture);
    const service = new MerchantRuleCreationService(repository, {
      now: () => new Date('2026-10-09T20:01:00Z'),
    });
    await expect(
      service.create(
        actor,
        { ...request, expectedPolicyVersion: 2 },
        async () => true
      )
    ).rejects.toMatchObject({ code: 'policy_version_conflict' });
    await expect(
      service.create(actor, request, async () => false)
    ).rejects.toMatchObject({ code: 'merchant_rule_account_not_found' });

    await service.create(actor, request, async () => true);
    await expect(
      service.create(
        actor,
        {
          ...request,
          rule: { ...request.rule, pattern: 'DIFFERENT MARKET' },
        },
        async () => true
      )
    ).rejects.toMatchObject({ code: 'merchant_rule_idempotency_conflict' });
  });

  it('requires a fresh explicit confirmation', async () => {
    const service = new MerchantRuleCreationService(
      new SeededPolicyRepository(policyFixture),
      { now: () => new Date('2026-10-09T20:10:01Z') }
    );
    await expect(
      service.create(actor, request, async () => true)
    ).rejects.toBeInstanceOf(MerchantRuleCreationError);
    await expect(
      service.create(
        actor,
        {
          ...request,
          confirmation: {
            confirmed: false,
            confirmedAt: '2026-10-09T20:10:00Z',
          },
        },
        async () => true
      )
    ).rejects.toMatchObject({ code: 'merchant_rule_confirmation_required' });
  });
});

class SeededPolicyRepository implements PolicyRepository {
  protected snapshot: PolicySnapshotV1;
  protected readonly audit: PolicyAuditEventV1[] = [];

  constructor(snapshot: PolicySnapshotV1) {
    this.snapshot = structuredClone(snapshot);
  }

  async load(): Promise<PolicySnapshotV1> {
    return structuredClone(this.snapshot);
  }

  async save(
    snapshot: PolicySnapshotV1,
    expectedPolicyVersion: number | null,
    auditEvent: PolicyAuditEventV1
  ): Promise<void> {
    if (this.snapshot.policyVersion !== expectedPolicyVersion) {
      throw new PolicyVersionConflictError();
    }
    this.snapshot = structuredClone(snapshot);
    this.audit.push(structuredClone(auditEvent));
  }

  async listAudit(): Promise<PolicyAuditEventV1[]> {
    return structuredClone(this.audit);
  }

  async withPolicyVersionFence<T>(
    householdId: string,
    expectedPolicyVersion: number,
    operation: () => Promise<T>
  ): Promise<T | null> {
    if (
      this.snapshot.householdId !== householdId ||
      this.snapshot.policyVersion !== expectedPolicyVersion
    ) {
      return null;
    }
    return operation();
  }
}

class ConcurrentReplayRepository extends SeededPolicyRepository {
  override async save(
    snapshot: PolicySnapshotV1,
    expectedPolicyVersion: number | null,
    auditEvent: PolicyAuditEventV1
  ): Promise<void> {
    await super.save(snapshot, expectedPolicyVersion, auditEvent);
    throw new PolicyVersionConflictError();
  }
}
