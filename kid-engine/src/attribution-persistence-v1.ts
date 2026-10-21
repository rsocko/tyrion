import {
  AttributionActionError,
  AttributionActionService,
  parseAttributionActionRequestV1,
  type AttributionActionRecordV1,
} from './attribution-actions-v1.js';
import {
  ATTRIBUTION_BATCH_PROVENANCE,
  parseAttributionBatchRequestV1,
  toAttributionInput,
} from './attribution-batch-v1.js';
import { attributeTransactionV1 } from './attribution-v1.js';
import {
  ContractValidationError,
  parsePolicyActorV1,
  type PolicyActorV1,
} from './contracts/v1.js';
import { authorizeAttributionActions, type PolicyRepository } from './policy/service.js';
import {
  decisionVersion,
  FileAttributionRepositoryV1,
  projectable,
} from './attribution-store-v1.js';
import {
  TagProjectionError,
  type AttributionTagProjectorV1,
  type TagProjectionRecordV1,
} from './tag-projection-v1.js';

export interface DurableAttributionStateV1 {
  contractVersion: '2.1';
  record: AttributionActionRecordV1;
  projection: TagProjectionRecordV1 | null;
}

export class DurableAttributionServiceV1 {
  private readonly actions: AttributionActionService;

  constructor(
    private readonly policies: PolicyRepository,
    private readonly store: FileAttributionRepositoryV1,
    private readonly projector: AttributionTagProjectorV1,
    private readonly now: () => Date = () => new Date()
  ) {
    this.actions = new AttributionActionService(policies, store, { now });
  }

  async register(actorValue: PolicyActorV1, value: unknown): Promise<DurableAttributionStateV1> {
    const actor = parsePolicyActorV1(actorValue);
    authorizeAttributionActions(actor, actor.householdId);
    const request = object(value, [
      'contractVersion', 'provenance', 'expectedPolicyVersion',
      'expectedStateVersion', 'transactionId', 'item',
    ]);
    if (request.contractVersion !== '2.1' || request.provenance !== ATTRIBUTION_BATCH_PROVENANCE) invalid();
    const batch = parseAttributionBatchRequestV1({
      contractVersion: request.contractVersion, provenance: request.provenance,
      expectedPolicyVersion: request.expectedPolicyVersion, items: [request.item],
    }, actor);
    if (batch.expectedPolicyVersion === null) invalid();
    const expectedStateVersion = version(request.expectedStateVersion, true);
    const transactionId = identifier(request.transactionId);
    return this.store.withProjectionLease(async () => {
      const policy = await this.policies.load(actor.householdId);
      if (!policy) throw new AttributionActionError('policy_unavailable', 'Household attribution policy is unavailable');
      if (policy.policyVersion !== batch.expectedPolicyVersion) {
        throw new AttributionActionError('policy_conflict', 'Attribution policy version changed');
      }
      const input = toAttributionInput(batch.items[0], actor);
      const current = await this.store.load(actor.householdId, input.source.recordRef);
      if (current) {
        // Tyrion's durable manual decisions are authoritative over refreshed caller facts.
        input.existingManualDecision = current.input.existingManualDecision;
      }
      const attribution = attributeTransactionV1(input, policy, { evaluatedAt: this.now().toISOString() });
      const record = await this.policies.withPolicyVersionFence(
        actor.householdId, policy.policyVersion,
        () => this.store.register(actor.householdId, transactionId, {
          input, attribution, stateVersion: 1, lastAction: null,
          exception: {
            status: attribution.review.reasons.length ? 'open' : 'resolved',
            reasons: attribution.review.reasons,
            deferredUntil: null, updatedAt: attribution.provenance.evaluatedAt,
          },
        }, expectedStateVersion, actor.actorId)
      );
      if (!record) throw new AttributionActionError('attribution_state_conflict', 'Attribution state or source identity changed');
      const projection = await this.projectCurrent(actor.householdId, record.attribution.sourceRef);
      return { contractVersion: '2.1', record, projection };
    });
  }

  async act(actor: PolicyActorV1, value: unknown) {
    const request = parseAttributionActionRequestV1(value);
    return this.store.withProjectionLease(async () => {
      const result = await this.actions.act(actor, value);
      const current = await this.store.load(actor.householdId, result.sourceRef);
      if (!current) throw new AttributionActionError('attribution_not_found', 'Attribution state was not found');
      const projection = request.action === 'explain' || request.action === 'defer-exception'
        ? await this.projectionStatus(actor.householdId, current)
        : await this.projectCurrent(actor.householdId, result.sourceRef);
      return { ...result, projection };
    });
  }

  async projection(actorValue: PolicyActorV1, value: unknown): Promise<DurableAttributionStateV1> {
    const actor = parsePolicyActorV1(actorValue);
    authorizeAttributionActions(actor, actor.householdId);
    const request = object(value, ['contractVersion', 'sourceRef', 'action', 'expectedStateVersion']);
    if (request.contractVersion !== '2.1' || !['status', 'retry'].includes(String(request.action))) invalid();
    const sourceRef = identifier(request.sourceRef);
    const expectedStateVersion = version(request.expectedStateVersion, false);
    return this.store.withProjectionLease(async () => {
      const record = await this.store.load(actor.householdId, sourceRef);
      if (!record) throw new AttributionActionError('attribution_not_found', 'Attribution state was not found');
      if (record.stateVersion !== expectedStateVersion) {
        throw new AttributionActionError('attribution_state_conflict', 'Attribution state changed');
      }
      const projection = request.action === 'retry'
        ? await this.projectCurrent(actor.householdId, sourceRef)
        : await this.projectionStatus(actor.householdId, record);
      return { contractVersion: '2.1', record, projection };
    });
  }

  /** Caller holds the store's projection lease while reading and projecting current state. */
  async projectCurrent(householdId: string, sourceRef: string): Promise<TagProjectionRecordV1 | null> {
    const record = await this.store.load(householdId, sourceRef);
    if (!record) throw new AttributionActionError('attribution_not_found', 'Attribution state was not found');
    if (!projectable(record)) return this.projectionStatus(householdId, record);
    const policy = await this.policies.load(householdId);
    if (!policy) throw new AttributionActionError('policy_unavailable', 'Household attribution policy is unavailable');
    try {
      return await this.projector.projectConfirmed({
        householdId, sourceRef, decisionVersion: decisionVersion(record),
        kidIds: record.attribution.status === 'attributed' && record.attribution.kidId
          ? [record.attribution.kidId] : [],
        kids: policy.kids,
      });
    } catch (error) {
      const prior = await this.store.loadProjection(householdId, sourceRef);
      if (
        error instanceof TagProjectionError &&
        prior?.decisionVersion === decisionVersion(record) &&
        (prior.status === 'failed' || prior.status === 'drift')
      ) {
        return prior;
      }
      // The decision and outbox already committed. Expose a sanitized partial failure,
      // including catalog/read failures that occur before the projector writes a record.
      const failed: TagProjectionRecordV1 = {
        sourceRef, decisionVersion: decisionVersion(record),
        kidIds: record.attribution.kidId ? [record.attribution.kidId] : [],
        managedTagIds: prior?.managedTagIds ?? [],
        status: prior?.status === 'drift' ||
          (error instanceof TagProjectionError && error.code === 'transaction_tag_drift')
          ? 'drift' : 'failed',
        errorCode: prior?.status === 'drift' ? 'transaction_tag_drift'
          : error instanceof TagProjectionError ? error.code : 'tag_projection_unavailable',
        updatedAt: this.now().toISOString(),
      };
      await this.store.saveProjection(householdId, failed);
      return failed;
    }
  }

  private async projectionStatus(householdId: string, record: AttributionActionRecordV1) {
    const prior = await this.store.loadProjection(householdId, record.attribution.sourceRef);
    if (!await this.store.projectionPending(householdId, record.attribution.sourceRef)) {
      return prior;
    }
    if (prior?.decisionVersion === decisionVersion(record)) return prior;
    return {
      sourceRef: record.attribution.sourceRef, decisionVersion: decisionVersion(record),
      kidIds: record.attribution.kidId ? [record.attribution.kidId] : [],
      managedTagIds: prior?.managedTagIds ?? [], status: 'pending' as const,
      errorCode: null, updatedAt: record.attribution.provenance.evaluatedAt,
    };
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}

function version(value: unknown, nullable: boolean): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new ContractValidationError('Durable attribution request is invalid');
}
