import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilePolicyRepository,
  PolicyStoreConfigurationError,
  PolicyStoreCorruptError,
  PolicyStoreBusyError,
} from '../src/policy/file-repository.js';
import {
  PolicyAuthorizationError,
  PolicyService,
  PolicyVersionConflictError,
  authorizePolicy,
  authorizeReattribution,
  type PolicyRepository,
} from '../src/policy/service.js';
import type {
  PolicyActorV1,
  PolicyAuditEventV1,
  PolicySnapshotV1,
} from '../src/contracts/v1.js';
import { policyDraftFixture, policyFixture } from './fixtures.js';

const directories: string[] = [];
const writer: PolicyActorV1 = {
  actorId: 'actor-demo',
  householdId: 'household-demo',
  permissions: ['policy:read', 'policy:write', 'reattribution:preview'],
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('policy service authorization and versioning', () => {
  it('rejects cross-household and missing-permission access', async () => {
    const service = new PolicyService(new MemoryPolicyRepository());
    await expect(
      service.getPolicy(writer, 'household-other')
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
    await expect(
      service.replacePolicy(
        { ...writer, permissions: ['policy:read'] },
        'household-demo',
        { expectedPolicyVersion: null, policy: policyDraftFixture }
      )
    ).rejects.toBeInstanceOf(PolicyAuthorizationError);
  });

  it('uses optimistic policy versions and metadata-only audit events', async () => {
    const repository = new MemoryPolicyRepository();
    const service = new PolicyService(repository, {
      now: () => new Date('2026-08-08T13:00:00Z'),
      eventId: () => 'audit-event-demo',
    });
    const created = await service.replacePolicy(writer, 'household-demo', {
      expectedPolicyVersion: null,
      policy: policyDraftFixture,
    });
    expect(created.policyVersion).toBe(1);
    await expect(
      service.replacePolicy(writer, 'household-demo', {
        expectedPolicyVersion: null,
        policy: policyDraftFixture,
      })
    ).rejects.toBeInstanceOf(PolicyVersionConflictError);
    const audit = await service.listAudit(writer, 'household-demo');
    expect(audit).toEqual([
      {
        contractVersion: '1.0',
        eventId: 'audit-event-demo',
        householdId: 'household-demo',
        actorId: 'actor-demo',
        action: 'policy-created',
        previousPolicyVersion: null,
        policyVersion: 1,
        occurredAt: '2026-08-08T13:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('merchantRules');
  });

  it('uses separate permissions for re-attribution preview and apply', () => {
    expect(() =>
      authorizeReattribution(writer, 'household-demo', 'preview')
    ).not.toThrow();
    expect(() =>
      authorizeReattribution(writer, 'household-demo', 'apply')
    ).toThrowError(PolicyAuthorizationError);
  });

  it('exposes policy authorization without repository access', () => {
    expect(() => authorizePolicy(writer, 'household-demo', 'write')).not.toThrow();
    expect(() =>
      authorizePolicy(writer, 'household-other', 'read')
    ).toThrowError(PolicyAuthorizationError);
  });
});

describe('durable file policy repository', () => {
  it('requires an external absolute state path', () => {
    expect(() => new FilePolicyRepository('relative-state.json')).toThrowError(
      PolicyStoreConfigurationError
    );
    expect(
      () => new FilePolicyRepository(resolve(process.cwd(), 'state.json'))
    ).toThrowError(PolicyStoreConfigurationError);
  });

  it('persists snapshots and audit records across repository instances', async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, 'policies.json');
    const service = new PolicyService(new FilePolicyRepository(path), {
      now: () => new Date('2026-08-08T13:00:00Z'),
      eventId: () => 'audit-event-demo',
    });
    await service.replacePolicy(writer, 'household-demo', {
      expectedPolicyVersion: null,
      policy: policyDraftFixture,
    });
    const reopened = new PolicyService(new FilePolicyRepository(path));
    expect(
      (await reopened.getPolicy(writer, 'household-demo'))?.policyVersion
    ).toBe(1);
    expect(await reopened.listAudit(writer, 'household-demo')).toHaveLength(1);
    const updated = await reopened.replacePolicy(writer, 'household-demo', {
      expectedPolicyVersion: 1,
      policy: {
        ...policyDraftFixture,
        limits: [
          { kidId: 'kid-alpha', period: 'daily', amount: 30, currency: 'USD' },
        ],
      },
    });
    expect(updated.policyVersion).toBe(2);
    expect(
      (
        await new PolicyService(
          new FilePolicyRepository(path)
        ).getPolicy(writer, 'household-demo')
      )?.limits[0].amount
    ).toBe(30);
  });

  it('atomically adopts a sole legacy policy into the canonical household', async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, 'policies.json');
    const legacy = new FilePolicyRepository(path);
    await legacy.save(policyFixture, null, {
      contractVersion: '1.0',
      eventId: 'audit-event-legacy',
      householdId: 'household-demo',
      actorId: 'actor-demo',
      action: 'policy-created',
      previousPolicyVersion: null,
      policyVersion: 1,
      occurredAt: policyFixture.updatedAt,
    });

    const canonical = new FilePolicyRepository(path, {
      canonicalHouseholdId: 'homelab-household',
    });
    const migrated = await canonical.load('homelab-household');
    expect(migrated).toMatchObject({
      householdId: 'homelab-household',
      policyVersion: 1,
    });
    expect(await canonical.load('household-demo')).toBeNull();
    expect(await canonical.listAudit('homelab-household')).toMatchObject([
      {
        householdId: 'homelab-household',
        eventId: 'audit-event-legacy',
      },
    ]);
    expect(await readFile(path, 'utf8')).not.toContain('"household-demo"');
  });

  it('enforces compare-and-swap when a writer uses a stale version', async () => {
    const directory = await temporaryDirectory();
    const repository = new FilePolicyRepository(resolve(directory, 'policies.json'));
    const event: PolicyAuditEventV1 = {
      contractVersion: '1.0',
      eventId: 'audit-event-demo',
      householdId: 'household-demo',
      actorId: 'actor-demo',
      action: 'policy-created',
      previousPolicyVersion: null,
      policyVersion: 1,
      occurredAt: policyFixture.updatedAt,
    };
    await repository.save(policyFixture, null, event);
    await expect(
      repository.save(
        { ...policyFixture, policyVersion: 2 },
        null,
        {
          ...event,
          eventId: 'audit-event-stale',
          action: 'policy-replaced',
          previousPolicyVersion: null,
          policyVersion: 2,
        }
      )
    ).rejects.toBeInstanceOf(PolicyVersionConflictError);
  });

  it('fences policy writes while a version-bound operation is applying', async () => {
    const directory = await temporaryDirectory();
    const repository = new FilePolicyRepository(resolve(directory, 'policies.json'));
    const service = new PolicyService(repository);
    const created = await service.replacePolicy(writer, 'household-demo', {
      expectedPolicyVersion: null,
      policy: policyDraftFixture,
    });
    let enterFence!: () => void;
    let releaseFence!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      enterFence = resolvePromise;
    });
    const released = new Promise<void>((resolvePromise) => {
      releaseFence = resolvePromise;
    });
    const fenced = repository.withPolicyVersionFence(
      'household-demo',
      created.policyVersion,
      async () => {
        enterFence();
        await released;
        return 'applied';
      }
    );
    await entered;
    await expect(
      service.replacePolicy(writer, 'household-demo', {
        expectedPolicyVersion: created.policyVersion,
        policy: policyDraftFixture,
      })
    ).rejects.toBeInstanceOf(PolicyStoreBusyError);
    releaseFence();
    await expect(fenced).resolves.toBe('applied');
    await expect(
      service.getPolicy(writer, 'household-demo')
    ).resolves.toMatchObject({ policyVersion: created.policyVersion });
  });

  it('sanitizes audit input before persisting it', async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, 'policies.json');
    const repository = new FilePolicyRepository(path);
    const auditWithUnexpectedData = {
      contractVersion: '1.0' as const,
      eventId: 'audit-event-demo',
      householdId: 'household-demo',
      actorId: 'actor-demo',
      action: 'policy-created' as const,
      previousPolicyVersion: null,
      policyVersion: 1,
      occurredAt: policyFixture.updatedAt,
      unexpectedData: { value: 'must-not-persist' },
    };
    await expect(
      repository.save(policyFixture, null, auditWithUnexpectedData)
    ).rejects.toThrow('unexpected field');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a lock left by a terminated process', async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, 'policies.json');
    const lockPath = `${path}.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    await utimes(lockPath, new Date(0), new Date(0));
    const repository = new FilePolicyRepository(path);
    await repository.save(policyFixture, null, {
      contractVersion: '1.0',
      eventId: 'audit-event-demo',
      householdId: 'household-demo',
      actorId: 'actor-demo',
      action: 'policy-created',
      previousPolicyVersion: null,
      policyVersion: 1,
      occurredAt: policyFixture.updatedAt,
    });
    expect((await repository.load('household-demo'))?.policyVersion).toBe(1);
  });

  it('returns a stable sanitized error for corrupt persisted data', async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, 'policies.json');
    await writeFile(path, '{"storageVersion":1,"policies":"invalid","audit":[]}', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const repository = new FilePolicyRepository(path);
    await expect(repository.load('household-demo')).rejects.toMatchObject({
      code: 'policy_store_corrupt',
      message: 'Policy store contents are invalid',
    });
    await expect(repository.load('household-demo')).rejects.not.toThrow(path);
  });

  it('does not persist reusable Monarch session material fields', async () => {
    const directory = await temporaryDirectory();
    const path = resolve(directory, 'policies.json');
    const repository = new FilePolicyRepository(path);
    await repository.save(policyFixture, null, {
      contractVersion: '1.0',
      eventId: 'audit-event-demo',
      householdId: 'household-demo',
      actorId: 'actor-demo',
      action: 'policy-created',
      previousPolicyVersion: null,
      policyVersion: 1,
      occurredAt: policyFixture.updatedAt,
    });
    const stored = await readFile(path, 'utf8');
    expect(stored).not.toMatch(/cookie|password|authorization|sessionPath/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'tyrion-policy-test-'));
  directories.push(directory);
  return directory;
}

class MemoryPolicyRepository implements PolicyRepository {
  private snapshot: PolicySnapshotV1 | null = null;
  private audit: PolicyAuditEventV1[] = [];

  async load(): Promise<PolicySnapshotV1 | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(
    snapshot: PolicySnapshotV1,
    expectedPolicyVersion: number | null,
    auditEvent: PolicyAuditEventV1
  ): Promise<void> {
    if ((this.snapshot?.policyVersion ?? null) !== expectedPolicyVersion) {
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
      this.snapshot?.householdId !== householdId ||
      this.snapshot.policyVersion !== expectedPolicyVersion
    ) {
      return null;
    }
    return operation();
  }
}
