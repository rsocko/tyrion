import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttributionStoreError, FileAttributionRepositoryV1,
} from '../src/attribution-store-v1.js';
import { DurableAttributionServiceV1 } from '../src/attribution-persistence-v1.js';
import { ReattributionService } from '../src/reattribution-v1.js';
import {
  TagProjectionServiceV1, type MonarchTagProjectionBridgeV1, type MonarchTagV1,
} from '../src/tag-projection-v1.js';
import type { PolicyRepository } from '../src/policy/service.js';
import type { PolicyActorV1 } from '../src/contracts/v1.js';
import { policyFixture } from './fixtures.js';

const actor: PolicyActorV1 = {
  actorId: 'synthetic-service', householdId: policyFixture.householdId,
  permissions: ['attribution:actions', 'attribution:batch'],
};
const now = () => new Date('2026-10-20T12:00:00Z');
let directory: string;
let path: string;
let store: FileAttributionRepositoryV1;
let bridge: Bridge;
let policies: PolicyRepository;
let policyVersion: number;
let service: DurableAttributionServiceV1;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tyrion-attribution-test-'));
  path = join(directory, 'state.json');
  store = new FileAttributionRepositoryV1(path);
  bridge = new Bridge();
  policyVersion = 1;
  policies = {
    load: async () => ({ ...structuredClone(policyFixture), policyVersion }),
    save: async () => { throw new Error('not used'); },
    listAudit: async () => [],
    withPolicyVersionFence: async (_household, version, operation) =>
      version === policyVersion ? operation() : null,
  };
  service = createService(store);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('durable attribution decisions and tag outbox', () => {
  it('persists detailed normalized facts, source mapping and definite automated projection', async () => {
    const result = await service.register(actor, registration());
    expect(result.record.stateVersion).toBe(1);
    expect(result.record.input.transaction.merchantName).toBe('Invented Merchant');
    expect(result.record.attribution.kidId).toBe('kid-alpha');
    expect(result.projection?.status).toBe('projected');
    const restarted = new FileAttributionRepositoryV1(path);
    expect(await restarted.load(actor.householdId, 'opaque-source')).toEqual(result.record);
    expect(await restarted.transactionId(actor.householdId, 'opaque-source')).toBe('upstream-synthetic');
    expect(await restarted.listAudit(actor.householdId, 'opaque-source')).toHaveLength(1);
    expect(await restarted.projectionPending(actor.householdId, 'opaque-source')).toBe(false);
    expect(bridge.current).toEqual(['unrelated', 'created-1']);
  });

  it('loads existing journals written before the Parent mapping was added', async () => {
    await service.register(actor, registration());
    const journal = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete journal.parentMappings;
    for (const entry of journal.projections as Array<{
      projection: Record<string, unknown>;
    }>) {
      delete entry.projection.parentAssigned;
    }
    await writeFile(path, JSON.stringify(journal));

    store = new FileAttributionRepositoryV1(path);
    service = createService(store);
    const recovered = await service.projection(actor, projectionRequest('retry', 1));

    expect(recovered.projection?.status).toBe('projected');
    expect(recovered.projection && Object.keys(recovered.projection).sort()).toEqual([
      'decisionVersion', 'errorCode', 'kidIds', 'managedTagIds', 'sourceRef',
      'status', 'updatedAt',
    ]);
    const migrated = JSON.parse(await readFile(path, 'utf8'));
    expect(migrated.parentMappings).toEqual([]);
  });

  it('migrates a saved parent decision and projects Parent after an older journal restart', async () => {
    const request = registration();
    request.item.existingManualDecision = {
      action: 'parent-expense', kidId: null, decidedAt: now().toISOString(),
    };
    await service.register(actor, request);
    const journal = JSON.parse(await readFile(path, 'utf8'));
    delete journal.parentMappings;
    for (const entry of journal.projections) {
      delete entry.projection.parentAssigned;
      entry.projection.managedTagIds = [];
      entry.verifiedManagedTagIds = [];
    }
    bridge.current = ['unrelated'];
    bridge.tags = bridge.tags.filter((tag) => tag.name !== 'Parent');
    await writeFile(path, JSON.stringify(journal));

    store = new FileAttributionRepositoryV1(path);
    service = createService(store);
    const recovered = await service.projection(actor, projectionRequest('retry', 1));

    expect(recovered.projection?.status).toBe('projected');
    expect(recovered.projection?.managedTagIds).toEqual(['created-2']);
    expect(bridge.tags.find((tag) => tag.id === 'created-2')?.name).toBe('Parent');
    expect(bridge.current).toEqual(['unrelated', 'created-2']);
  });

  it('bootstraps a legacy manual parent/shared decision without requiring a tag pre-step', async () => {
    const request = registration();
    request.item.existingManualDecision = {
      action: 'parent-expense', kidId: null, decidedAt: now().toISOString(),
    };
    const result = await service.register(actor, request);
    expect(result.record.attribution.method).toBe('manual');
    expect(result.record.input.existingManualDecision?.actorId).toBe(actor.actorId);
    expect(result.projection?.status).toBe('projected');
    expect(result.projection?.kidIds).toEqual([]);
    expect(bridge.tags[1]).toMatchObject({ name: 'Parent', isActive: true });
    expect(bridge.current).toEqual(['unrelated', 'created-1']);
  });

  it('never writes ambiguous attribution or treats managed tags as attribution input', async () => {
    const request = registration();
    request.item.accountRef = 'shared-account';
    const result = await service.register(actor, request);
    expect(result.record.attribution.status).toBe('unassigned');
    expect(result.projection).toBeNull();
    expect(bridge.creates).toBe(0);
    expect(bridge.replacements).toBe(0);
    await expect(service.register(actor, {
      ...request, item: { ...request.item, tags: ['Kid: Alpha'] },
    })).rejects.toMatchObject({ code: 'invalid_domain_contract' });
  });

  it('does not project a likely parent/shared rule that has not reached definite confidence', async () => {
    policies.load = async () => ({
      ...structuredClone(policyFixture),
      merchantRules: [{
        ...policyFixture.merchantRules[0], outcome: 'parent-shared',
        pattern: 'INVENTED MERCHANT', kidId: null, confidence: 'likely',
      }],
      exceptionPolicy: {
        ...policyFixture.exceptionPolicy,
        requireReviewForLikelyAttribution: false,
      },
    });
    const result = await service.register(actor, registration());

    expect(result.record.attribution).toMatchObject({
      status: 'unassigned', confidence: 'likely', method: 'merchant-rule',
      review: { status: 'not-required' },
    });
    expect(result.projection).toBeNull();
    expect(bridge.creates).toBe(0);
    expect(bridge.replacements).toBe(0);
  });

  it('creates only once and refuses source identity remapping or aliasing', async () => {
    const first = await service.register(actor, registration());
    const second = await service.register(actor, registration());
    expect(second.record).toEqual(first.record);
    expect(bridge.creates).toBe(1);
    await expect(service.register(actor, {
      ...registration(), transactionId: 'different-upstream',
    })).rejects.toMatchObject({ code: 'attribution_state_conflict' });
    await expect(service.register(actor, {
      ...registration(), item: { ...registration().item, sourceRef: 'alias-source' },
    })).rejects.toMatchObject({ code: 'attribution_state_conflict' });
  });

  it('atomically saves audit, idempotency receipt and retry work before a Monarch failure', async () => {
    await service.register(actor, registration());
    bridge.fail = true;
    const result = await service.act(actor, action());
    expect(result.stateVersion).toBe(2);
    expect(result.attribution.kidId).toBe('kid-beta');
    expect(result.projection?.status).toBe('failed');
    expect(result.projection?.errorCode).toBe('tag_projection_unavailable');
    expect(JSON.stringify(result)).not.toContain('private upstream diagnostic');
    store = new FileAttributionRepositoryV1(path);
    expect(await store.projectionPending(actor.householdId, 'opaque-source')).toBe(true);
    expect(await store.listAudit(actor.householdId, 'opaque-source')).toHaveLength(2);
    bridge.fail = false;
    service = createService(store);
    const replay = await service.act(actor, action());
    expect(replay.stateVersion).toBe(2);
    expect(replay.audit?.outcome).toBe('replayed');
    expect(replay.projection?.status).toBe('projected');
    expect(await store.listAudit(actor.householdId, 'opaque-source')).toHaveLength(2);
    expect(bridge.current).toEqual(['unrelated', 'created-2']);
  });

  it('recovers committed outbox work when the process stops before invoking Monarch', async () => {
    const disconnected = new DurableAttributionServiceV1(policies, store, {
      projectConfirmed: async () => { throw new Error('private upstream diagnostic'); },
    }, now);
    const result = await disconnected.register(actor, registration());
    expect(result.projection?.status).toBe('failed');
    expect((await store.load(actor.householdId, 'opaque-source'))?.stateVersion).toBe(1);
    service = createService(new FileAttributionRepositoryV1(path));
    const recovered = await service.projection(actor, projectionRequest('retry', 1));
    expect(recovered.projection?.status).toBe('projected');
  });

  it('replays the original request after a policy change without repeating the decision', async () => {
    await service.register(actor, registration());
    await service.act(actor, action());
    policyVersion = 2;
    const replay = await service.act(actor, action());
    expect(replay.audit?.outcome).toBe('replayed');
    expect(replay.stateVersion).toBe(2);
    expect(replay.policyVersion).toBe(2);
    await expect(service.act(actor, { ...action(), expectedStateVersion: 2 }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('preserves Tyrion manual decisions during explicit fact refresh and create-only bootstrap', async () => {
    await service.register(actor, registration());
    await service.act(actor, action());
    expect((await service.register(actor, registration())).record.stateVersion).toBe(2);
    const refreshed = await service.register(actor, {
      ...registration(), expectedStateVersion: 2,
      item: { ...registration().item, merchantName: 'Updated Synthetic Merchant' },
    });
    expect(refreshed.record.stateVersion).toBe(3);
    expect(refreshed.record.attribution.kidId).toBe('kid-beta');
    expect(refreshed.record.attribution.method).toBe('manual');
    expect(refreshed.record.input.transaction.merchantName).toBe('Updated Synthetic Merchant');
    expect(await store.listAudit(actor.householdId, 'opaque-source')).toHaveLength(3);
  });

  it('rejects concurrent stale decisions and serializes managed tag creation across sources', async () => {
    await service.register(actor, registration());
    const other = createService(new FileAttributionRepositoryV1(path));
    const results = await Promise.allSettled([
      service.act(actor, action()),
      other.act(actor, { ...action(), idempotencyKey: 'other-action' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'attribution_state_conflict' },
    });
    await Promise.all([
      service.register(actor, { ...registration(), transactionId: 'upstream-two', item: {
        ...registration().item, sourceRef: 'source-two',
      } }),
      other.register(actor, { ...registration(), transactionId: 'upstream-three', item: {
        ...registration().item, sourceRef: 'source-three',
      } }),
    ]);
    expect(bridge.creates).toBe(2);
  });

  it('status and explain remain read-only; retry requires a current version', async () => {
    await service.register(actor, registration());
    bridge.current = ['unrelated'];
    const before = bridge.replacements;
    await service.act(actor, {
      contractVersion: '2.1', provenance: 'mission-control-normalized-v2',
      sourceRef: 'opaque-source', expectedPolicyVersion: 1, action: 'explain',
    });
    await service.projection(actor, projectionRequest('status', 1));
    expect(bridge.replacements).toBe(before);
    await expect(service.projection(actor, projectionRequest('retry', 2)))
      .rejects.toMatchObject({ code: 'attribution_state_conflict' });
  });

  it('does not erase real drift on retries, new decisions, or after restart', async () => {
    await service.register(actor, registration());
    bridge.current = ['unrelated'];
    const result = await service.projection(actor, projectionRequest('retry', 1));
    expect(result.projection?.status).toBe('drift');
    const replacements = bridge.replacements;
    service = createService(new FileAttributionRepositoryV1(path));
    const reassigned = await service.act(actor, action());
    expect(reassigned.stateVersion).toBe(2);
    expect(reassigned.projection?.status).toBe('drift');
    expect(bridge.replacements).toBe(replacements);
  });

  it('fails closed for malformed, unauthorized, stale-policy and corrupt-storage requests', async () => {
    await expect(service.register({ ...actor, permissions: [] }, registration()))
      .rejects.toMatchObject({ code: 'policy_forbidden' });
    await expect(service.register(actor, { ...registration(), expectedPolicyVersion: 2 }))
      .rejects.toMatchObject({ code: 'policy_conflict' });
    await expect(service.register(actor, { ...registration(), transactionId: '../unsafe' }))
      .rejects.toMatchObject({ code: 'invalid_domain_contract' });
    await service.register(actor, registration());
    const original = await readFile(path, 'utf8');
    await writeFile(path, '{"private":"private upstream diagnostic"}');
    await expect(service.projection(actor, projectionRequest('status', 1)))
      .rejects.toThrow(AttributionStoreError);
    await writeFile(path, original);
    expect((await store.load(actor.householdId, 'opaque-source'))?.stateVersion).toBe(1);
  });

  it('projects a definite automated parent/shared rule with the Parent tag only', async () => {
    await service.register(actor, registration());
    policyVersion = 2;
    policies.load = async () => ({
      ...structuredClone(policyFixture), policyVersion,
      merchantRules: [{
        ...policyFixture.merchantRules[0], outcome: 'parent-shared',
        pattern: 'INVENTED MERCHANT', kidId: null, confidence: 'definite',
      }],
    });
    const parent = await service.register(actor, {
      ...registration(), expectedPolicyVersion: 2, expectedStateVersion: 1,
    });
    expect(parent.record.attribution).toMatchObject({
      status: 'unassigned', confidence: 'definite', method: 'merchant-rule',
    });
    expect(parent.projection?.status).toBe('projected');
    expect(parent.projection?.kidIds).toEqual([]);
    expect(parent.projection?.managedTagIds).toEqual(['created-2']);
    expect(bridge.tags[2]).toMatchObject({ name: 'Parent', isActive: true });
    expect(bridge.current).toEqual(['unrelated', 'created-2']);
  });

  it('projects manual Parent, returns to Kid, and clears managed tags on explicit unassign', async () => {
    await service.register(actor, registration());
    const parent = await service.act(actor, {
      contractVersion: '2.1', provenance: 'mission-control-normalized-v2',
      sourceRef: 'opaque-source', expectedPolicyVersion: 1, expectedStateVersion: 1,
      idempotencyKey: 'manual-parent', confirm: true, action: 'mark-parent-expense',
    });
    expect(parent.projection?.status).toBe('projected');
    expect(bridge.current).toEqual(['unrelated', 'created-2']);
    expect(bridge.tags[1].name).toBe('Kid: Alpha');
    expect(bridge.tags[2].name).toBe('Parent');

    service = createService(new FileAttributionRepositoryV1(path));
    const kid = await service.act(actor, {
      contractVersion: '2.1', provenance: 'mission-control-normalized-v2',
      sourceRef: 'opaque-source', expectedPolicyVersion: 1, expectedStateVersion: 2,
      idempotencyKey: 'manual-kid-again', confirm: true,
      action: 'assign-kid', kidId: 'kid-alpha',
    });
    expect(kid.projection?.managedTagIds).toEqual(['created-1']);
    expect(bridge.current).toEqual(['unrelated', 'created-1']);

    const unassigned = await service.act(actor, {
      contractVersion: '2.1', provenance: 'mission-control-normalized-v2',
      sourceRef: 'opaque-source', expectedPolicyVersion: 1, expectedStateVersion: 3,
      idempotencyKey: 'explicit-unassign', confirm: true, action: 'unassign',
    });
    expect(unassigned.projection?.managedTagIds).toEqual([]);
    expect(bridge.current).toEqual(['unrelated']);
  });

  it('does not churn versions on observed-at-only refresh and permits rebasing only rejected CAS', async () => {
    await service.register(actor, registration());
    const same = await service.register(actor, {
      ...registration(), expectedStateVersion: 1,
      item: { ...registration().item, observedAt: '2026-10-21T12:00:00Z' },
    });
    expect(same.record.stateVersion).toBe(1);
    const refreshed = await service.register(actor, {
      ...registration(), expectedStateVersion: 1,
      item: { ...registration().item, merchantName: 'New Invented Merchant' },
    });
    expect(refreshed.record.stateVersion).toBe(2);
    await expect(service.act(actor, action())).rejects.toMatchObject({
      code: 'attribution_state_conflict',
    });
    expect(await store.loadReplay(actor.householdId, 'opaque-source', 'synthetic-action')).toBeNull();
    const applied = await service.act(actor, { ...action(), expectedStateVersion: 2 });
    expect(applied.stateVersion).toBe(3);
    await expect(service.act(actor, action())).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('returns the original replay receipt but never reprojects a superseded manual decision', async () => {
    await service.register(actor, registration());
    await service.act(actor, action());
    await service.act(actor, {
      contractVersion: '2.1', provenance: 'mission-control-normalized-v2',
      sourceRef: 'opaque-source', expectedPolicyVersion: 1, confirm: true,
      action: 'mark-parent-expense',
      expectedStateVersion: 2, idempotencyKey: 'parent-action',
    });
    const replay = await service.act(actor, action());
    expect(replay.stateVersion).toBe(2);
    expect(replay.attribution.kidId).toBe('kid-beta');
    expect(replay.projection?.kidIds).toEqual([]);
    expect(replay.projection?.managedTagIds).toEqual(['created-3']);
    expect(bridge.current).toEqual(['unrelated', 'created-3']);
  });

  it('recovers an unknown successful tag replacement without sending a duplicate mutation', async () => {
    await service.register(actor, registration());
    bridge.failAfterWrite = true;
    const result = await service.act(actor, action());
    expect(result.projection?.status).toBe('failed');
    const writes = bridge.replacements;
    service = createService(new FileAttributionRepositoryV1(path));
    const retry = await service.projection(actor, projectionRequest('retry', 2));
    expect(retry.projection?.status).toBe('projected');
    expect(bridge.replacements).toBe(writes);
  });

  it('retains the last verified managed baseline through an unknown outcome and refuses real drift', async () => {
    await service.register(actor, registration());
    bridge.failAfterWrite = true;
    await service.act(actor, action());
    bridge.current = ['unrelated', 'created-1', 'created-2'];
    const writes = bridge.replacements;
    service = createService(new FileAttributionRepositoryV1(path));
    const retry = await service.projection(actor, projectionRequest('retry', 2));
    expect(retry.projection?.status).toBe('drift');
    expect(bridge.replacements).toBe(writes);
  });

  it('persists re-attribution previews and rejects a newer manual state before applying them', async () => {
    await service.register(actor, registration());
    const operator = { ...actor, permissions: ['reattribution:preview', 'reattribution:apply'] as const };
    const reattribution = new ReattributionService(policies, store, { now });
    const preview = await reattribution.preview({ ...operator, permissions: [...operator.permissions] }, {
      contractVersion: '2.1', householdId: actor.householdId,
      expectedPolicyVersion: 1, sourceRefs: ['opaque-source'],
    });
    expect(await new FileAttributionRepositoryV1(path).loadPreview(
      actor.householdId, preview.previewId
    )).toEqual(preview);
    await service.act(actor, action());
    await expect(reattribution.apply({ ...operator, permissions: [...operator.permissions] }, {
      contractVersion: '2.1', householdId: actor.householdId, previewId: preview.previewId,
      expectedPolicyVersion: 1, confirm: true,
    })).rejects.toMatchObject({ code: 'policy_version_conflict' });
    expect((await store.load(actor.householdId, 'opaque-source'))?.attribution.kidId).toBe('kid-beta');
  });

  it('exposes current pending projection when refreshed facts no longer confirm a previously tagged kid', async () => {
    await service.register(actor, registration());
    const result = await service.register(actor, {
      ...registration(), expectedStateVersion: 1,
      item: { ...registration().item, accountRef: 'shared-account' },
    });
    expect(result.record.attribution.confidence).toBe('none');
    expect(result.projection).toMatchObject({
      decisionVersion: 'state:0000000000000002', status: 'pending', kidIds: [],
    });
    expect(await store.projectionPending(actor.householdId, 'opaque-source')).toBe(true);
    const writes = bridge.replacements;
    const retry = await service.projection(actor, projectionRequest('retry', 2));
    expect(retry.projection?.status).toBe('pending');
    expect(bridge.replacements).toBe(writes);
    expect(bridge.current).toEqual(['unrelated', 'created-1']);
    const confirmed = await service.act(actor, { ...action(), expectedStateVersion: 2 });
    expect(confirmed.projection?.status).toBe('projected');
    expect(bridge.current).toEqual(['unrelated', 'created-2']);
  });

  it('does not report stale projected success when re-attribution removes certainty', async () => {
    await service.register(actor, registration());
    policyVersion = 2;
    policies.load = async () => ({
      ...structuredClone(policyFixture), policyVersion, accountDefaults: [], merchantRules: [],
    });
    const operator: PolicyActorV1 = {
      ...actor, permissions: ['reattribution:preview', 'reattribution:apply'],
    };
    const reattribution = new ReattributionService(policies, store, { now });
    const preview = await reattribution.preview(operator, {
      contractVersion: '2.1', householdId: actor.householdId,
      expectedPolicyVersion: 2, sourceRefs: ['opaque-source'],
    });
    await reattribution.apply(operator, {
      contractVersion: '2.1', householdId: actor.householdId, previewId: preview.previewId,
      expectedPolicyVersion: 2, confirm: true,
    });
    const state = await service.projection(actor, projectionRequest('status', 2));
    expect(state.record.attribution.confidence).toBe('none');
    expect(state.projection?.status).toBe('pending');
    expect(state.projection?.decisionVersion).toBe('state:0000000000000002');
  });

  it('binds preview versions at source load and rejects a fact refresh before preview save', async () => {
    await service.register(actor, registration());
    const savePreview = store.savePreview.bind(store);
    store.savePreview = async (preview, observedVersions) => {
      await service.register(actor, {
        ...registration(), expectedStateVersion: 1,
        item: { ...registration().item, merchantName: 'Refreshed Invented Merchant' },
      });
      return savePreview(preview, observedVersions);
    };
    const operator: PolicyActorV1 = {
      ...actor, permissions: ['reattribution:preview', 'reattribution:apply'],
    };
    await expect(new ReattributionService(policies, store, { now }).preview(operator, {
      contractVersion: '2.1', householdId: actor.householdId,
      expectedPolicyVersion: 1, sourceRefs: ['opaque-source'],
    })).rejects.toMatchObject({ code: 'reattribution_state_conflict' });
    const journal = JSON.parse(await readFile(path, 'utf8'));
    expect(journal.previews).toHaveLength(0);
    expect(journal.records[0].record.stateVersion).toBe(2);
  });
});

function createService(repository: FileAttributionRepositoryV1) {
  return new DurableAttributionServiceV1(
    policies, repository, new TagProjectionServiceV1(repository, bridge, { now }), now
  );
}
function registration() {
  return {
    contractVersion: '2.1', provenance: 'mission-control-normalized-v3',
    expectedPolicyVersion: 1, expectedStateVersion: null as number | null,
    transactionId: 'upstream-synthetic',
    item: {
      sourceRef: 'opaque-source', occurredOn: '2026-10-20',
      merchantName: 'Invented Merchant', businessEntityName: null,
      statementDescriptors: [], locationEvidence: null,
      accountRef: 'bridge-account-alpha', observedAt: now().toISOString(),
      existingManualDecision: null as null | {
        action: 'parent-expense'; kidId: null; decidedAt: string;
      },
    },
  };
}
function action() {
  return {
    contractVersion: '2.1', provenance: 'mission-control-normalized-v2',
    sourceRef: 'opaque-source', expectedPolicyVersion: 1, expectedStateVersion: 1,
    action: 'assign-kid', kidId: 'kid-beta', idempotencyKey: 'synthetic-action', confirm: true,
  };
}
function projectionRequest(action: 'status' | 'retry', version: number) {
  return { contractVersion: '2.1', sourceRef: 'opaque-source', action, expectedStateVersion: version };
}
class Bridge implements MonarchTagProjectionBridgeV1 {
  tags: MonarchTagV1[] = [{ id: 'unrelated', name: 'Household', isActive: true }];
  current = ['unrelated'];
  creates = 0;
  replacements = 0;
  fail = false;
  failAfterWrite = false;
  async listTags() {
    if (this.fail) throw new Error('private upstream diagnostic');
    return structuredClone(this.tags);
  }
  async createTag(name: string) {
    const tag = { id: `created-${++this.creates}`, name, isActive: true };
    this.tags.push(tag);
    return tag;
  }
  async readTransactionTagIds() { return [...this.current]; }
  async replaceTransactionTags(_sourceRef: string, tagIds: string[]) {
    this.replacements++;
    this.current = [...tagIds];
    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new Error('private upstream diagnostic');
    }
    return [...tagIds];
  }
}
