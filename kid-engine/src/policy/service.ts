import { randomUUID } from 'node:crypto';
import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  parsePolicyActorV1,
  parsePolicyDraftV1,
  type PolicyActorV1,
  type PolicyAuditEventV1,
  type PolicyDraftV1,
  type PolicyPermissionV1,
  type PolicySnapshotV1,
} from '../contracts/v1.js';

export interface PolicyRepository {
  load(householdId: string): Promise<PolicySnapshotV1 | null>;
  save(
    snapshot: PolicySnapshotV1,
    expectedPolicyVersion: number | null,
    auditEvent: PolicyAuditEventV1
  ): Promise<void>;
  listAudit(householdId: string): Promise<PolicyAuditEventV1[]>;
  withPolicyVersionFence<T>(
    householdId: string,
    expectedPolicyVersion: number,
    operation: () => Promise<T>
  ): Promise<T | null>;
}

export interface ReplacePolicyRequestV1 {
  expectedPolicyVersion: number | null;
  policy: PolicyDraftV1;
}

export interface PolicyServiceOptions {
  now?: () => Date;
  eventId?: () => string;
}

export class PolicyService {
  private readonly now: () => Date;
  private readonly eventId: () => string;

  constructor(
    private readonly repository: PolicyRepository,
    options: PolicyServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.eventId = options.eventId ?? randomUUID;
  }

  async getPolicy(
    actor: PolicyActorV1,
    householdId: string
  ): Promise<PolicySnapshotV1 | null> {
    const parsedActor = parsePolicyActorV1(actor);
    authorizePolicy(parsedActor, householdId, 'read');
    return this.repository.load(householdId);
  }

  async replacePolicy(
    actor: PolicyActorV1,
    householdId: string,
    request: ReplacePolicyRequestV1
  ): Promise<PolicySnapshotV1> {
    const parsedActor = parsePolicyActorV1(actor);
    authorizePolicy(parsedActor, householdId, 'write');
    const draft = parsePolicyDraftV1(request.policy);
    const current = await this.repository.load(householdId);
    const currentVersion = current?.policyVersion ?? null;
    if (currentVersion !== request.expectedPolicyVersion) {
      throw new PolicyVersionConflictError();
    }
    const policyVersion = (currentVersion ?? 0) + 1;
    const occurredAt = this.now().toISOString();
    const snapshot: PolicySnapshotV1 = {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
      householdId,
      policyVersion,
      updatedAt: occurredAt,
      ...draft,
    };
    const auditEvent: PolicyAuditEventV1 = {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      eventId: this.eventId(),
      householdId,
      actorId: parsedActor.actorId,
      action: current === null ? 'policy-created' : 'policy-replaced',
      previousPolicyVersion: currentVersion,
      policyVersion,
      occurredAt,
    };
    await this.repository.save(snapshot, currentVersion, auditEvent);
    return snapshot;
  }

  async listAudit(
    actor: PolicyActorV1,
    householdId: string
  ): Promise<PolicyAuditEventV1[]> {
    const parsedActor = parsePolicyActorV1(actor);
    authorizePolicy(parsedActor, householdId, 'read');
    return this.repository.listAudit(householdId);
  }
}

export class PolicyAuthorizationError extends Error {
  readonly code = 'policy_forbidden';

  constructor() {
    super('Actor is not authorized for this household policy operation');
    this.name = 'PolicyAuthorizationError';
  }
}

export class PolicyVersionConflictError extends Error {
  readonly code = 'policy_version_conflict';

  constructor() {
    super('Policy version changed; reload before retrying the mutation');
    this.name = 'PolicyVersionConflictError';
  }
}

export function authorizeReattribution(
  actor: PolicyActorV1,
  householdId: string,
  operation: 'preview' | 'apply'
): void {
  const parsedActor = parsePolicyActorV1(actor);
  authorize(
    parsedActor,
    householdId,
    operation === 'preview' ? 'reattribution:preview' : 'reattribution:apply'
  );
}

export function authorizeAttributionBatch(
  actor: PolicyActorV1,
  householdId: string
): void {
  const parsedActor = parsePolicyActorV1(actor);
  authorize(parsedActor, householdId, 'attribution:batch');
}

export function authorizePolicy(
  actor: PolicyActorV1,
  householdId: string,
  operation: 'read' | 'write'
): void {
  const parsedActor = parsePolicyActorV1(actor);
  authorize(
    parsedActor,
    householdId,
    operation === 'read' ? 'policy:read' : 'policy:write'
  );
}

function authorize(
  actor: PolicyActorV1,
  householdId: string,
  permission: PolicyPermissionV1
): void {
  if (
    actor.householdId !== householdId ||
    !actor.permissions.includes(permission)
  ) {
    throw new PolicyAuthorizationError();
  }
}
