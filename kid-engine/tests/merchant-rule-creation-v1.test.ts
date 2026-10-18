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
  contractVersion: '2.1',
  expectedPolicyVersion: 1,
  idempotencyKey: 'rule-create-demo-1',
  confirmation: {
    confirmed: true,
    confirmedAt: '2026-10-09T20:00:00Z',
  },
  locationOnlyConfirmation: null,
  rule: {
    outcome: 'kid',
    kidId: 'kid-alpha',
    pattern: 'INVENTED MARKET',
    businessEntityPattern: 'INVENTED HOLDINGS',
    statementDescriptorPattern: null,
    locationPredicate: null,
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

  it('requires a distinct fresh confirmation for a standalone location rule', async () => {
    const service = new MerchantRuleCreationService(
      new SeededPolicyRepository(policyFixture),
      { now: () => new Date('2026-10-09T20:01:00Z') }
    );
    const locationOnlyRequest = {
      ...request,
      idempotencyKey: 'rule-create-location-only',
      rule: {
        ...request.rule,
        pattern: null,
        businessEntityPattern: null,
        locationPredicate: {
          countryCode: 'US',
          region: 'MI',
          locality: null,
          minimumConfidence: 0.85,
        },
      },
    };
    await expect(
      service.create(actor, locationOnlyRequest, async () => true)
    ).rejects.toMatchObject({
      code: 'location_only_rule_confirmation_required',
    });

    await expect(
      service.create(
        actor,
        {
          ...locationOnlyRequest,
          locationOnlyConfirmation: {
            confirmed: true,
            confirmedAt: '2026-10-09T20:00:30Z',
          },
        },
        async () => true
      )
    ).resolves.toMatchObject({
      outcome: 'created',
      rule: {
        pattern: null,
        locationPredicate: {
          countryCode: 'US',
          region: 'MI',
          minimumConfidence: 0.85,
        },
      },
    });
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
