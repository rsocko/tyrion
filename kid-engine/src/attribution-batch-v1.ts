import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  ContractValidationError,
  parseAttributionInputV1,
  parsePolicyActorV1,
  type AttributionInputV1,
  type AttributionResultV1,
  type PolicyActorV1,
} from './contracts/v1.js';
import { attributeTransactionV1 } from './attribution-v1.js';
import {
  authorizeAttributionBatch,
  type PolicyRepository,
} from './policy/service.js';

export const ATTRIBUTION_BATCH_MAX_ITEMS = 100;
export const ATTRIBUTION_BATCH_PROVENANCE =
  'mission-control-normalized-v1' as const;

export interface AttributionBatchManualDecisionV1 {
  action: 'assign-kid' | 'parent-expense' | 'unassign';
  kidId: string | null;
  decidedAt: string;
}

export interface AttributionBatchItemV1 {
  sourceRef: string;
  occurredOn: string;
  merchantName: string;
  instrumentFingerprint: string | null;
  observedAt: string;
  existingManualDecision: AttributionBatchManualDecisionV1 | null;
}

export interface AttributionBatchRequestV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  provenance: typeof ATTRIBUTION_BATCH_PROVENANCE;
  expectedPolicyVersion: number | null;
  items: AttributionBatchItemV1[];
}

export interface AttributionBatchResultV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  sourceRef: string;
  status: AttributionResultV1['status'];
  kidId: string | null;
  confidence: AttributionResultV1['confidence'];
  method: AttributionResultV1['method'];
  explanation: string;
  reviewStatus: AttributionResultV1['review']['status'];
  reasons: AttributionResultV1['review']['reasons'];
  decisionSource: AttributionResultV1['provenance']['decisionSource'];
  policyVersion: number;
  engineVersion: typeof KID_ATTRIBUTION_ENGINE_VERSION;
  evaluatedAt: string;
}

export interface AttributionBatchResponseV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  policyVersion: number;
  engineVersion: typeof KID_ATTRIBUTION_ENGINE_VERSION;
  results: AttributionBatchResultV1[];
}

export interface AttributionBatchServiceOptions {
  now?: () => Date;
}

export class AttributionBatchService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: PolicyRepository,
    options: AttributionBatchServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async attribute(
    actorValue: PolicyActorV1,
    requestValue: unknown
  ): Promise<AttributionBatchResponseV1> {
    const actor = parsePolicyActorV1(actorValue);
    authorizeAttributionBatch(actor, actor.householdId);
    const request = parseAttributionBatchRequestV1(requestValue, actor);
    const policy = await this.repository.load(actor.householdId);
    if (!policy) {
      throw new AttributionBatchError(
        'policy_unavailable',
        'Household attribution policy is unavailable'
      );
    }
    if (
      request.expectedPolicyVersion !== null &&
      request.expectedPolicyVersion !== policy.policyVersion
    ) {
      throw new AttributionBatchError(
        'policy_conflict',
        'Attribution policy version changed'
      );
    }

    const evaluatedAt = this.now().toISOString();
    const response = await this.repository.withPolicyVersionFence(
      actor.householdId,
      policy.policyVersion,
      async () => ({
        contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
        policyVersion: policy.policyVersion,
        engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
        results: request.items.map((item) =>
          toBatchResult(
            attributeTransactionV1(toAttributionInput(item, actor), policy, {
              evaluatedAt,
            })
          )
        ),
      })
    );
    if (!response) {
      throw new AttributionBatchError(
        'policy_conflict',
        'Attribution policy version changed'
      );
    }
    return response;
  }
}

export class AttributionBatchError extends Error {
  constructor(
    readonly code:
      | 'policy_unavailable'
      | 'policy_conflict'
      | 'batch_too_large',
    message: string
  ) {
    super(message);
    this.name = 'AttributionBatchError';
  }
}

function parseAttributionBatchRequestV1(
  value: unknown,
  actor: PolicyActorV1
): AttributionBatchRequestV1 {
  const request = strictObject(value, [
    'contractVersion',
    'provenance',
    'expectedPolicyVersion',
    'items',
  ]);
  if (request.contractVersion !== TYRION_DOMAIN_CONTRACT_VERSION) {
    invalid('contractVersion is unsupported');
  }
  if (request.provenance !== ATTRIBUTION_BATCH_PROVENANCE) {
    invalid('provenance is unsupported');
  }
  const expectedPolicyVersion =
    request.expectedPolicyVersion === null
      ? null
      : positiveInteger(request.expectedPolicyVersion, 'expectedPolicyVersion');
  if (!Array.isArray(request.items) || request.items.length < 1) {
    invalid(
      `items must contain between 1 and ${ATTRIBUTION_BATCH_MAX_ITEMS} entries`
    );
  }
  if (request.items.length > ATTRIBUTION_BATCH_MAX_ITEMS) {
    throw new AttributionBatchError(
      'batch_too_large',
      `Attribution batch exceeds ${ATTRIBUTION_BATCH_MAX_ITEMS} items`
    );
  }
  const items = request.items.map((value, index) =>
    parseBatchItem(value, index, actor)
  );
  if (new Set(items.map((item) => item.sourceRef)).size !== items.length) {
    invalid('items must have unique sourceRef values');
  }
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    provenance: ATTRIBUTION_BATCH_PROVENANCE,
    expectedPolicyVersion,
    items,
  };
}

function parseBatchItem(
  value: unknown,
  _index: number,
  actor: PolicyActorV1
): AttributionBatchItemV1 {
  const item = strictObject(value, [
    'sourceRef',
    'occurredOn',
    'merchantName',
    'instrumentFingerprint',
    'observedAt',
    'existingManualDecision',
  ]);
  if (
    typeof item.sourceRef !== 'string' ||
    item.sourceRef !== item.sourceRef.trim()
  ) {
    invalid('sourceRef must be an exact opaque identifier');
  }
  let manual: unknown = null;
  if (item.existingManualDecision !== null) {
    const decision = strictObject(item.existingManualDecision, [
      'action',
      'kidId',
      'decidedAt',
    ]);
    manual = {
      action: decision.action,
      kidId: decision.kidId,
      decidedAt: decision.decidedAt,
      actorId: actor.actorId,
      explanation: 'An existing manual decision is preserved.',
    };
  }
  const parsed = parseAttributionInputV1({
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    householdId: actor.householdId,
    source: {
      system: 'monarch-bridge',
      recordRef: item.sourceRef,
      observedAt: item.observedAt,
    },
    transaction: {
      merchantName: item.merchantName,
      instrumentFingerprint: item.instrumentFingerprint,
      occurredOn: item.occurredOn,
    },
    historicalAttributions: [],
    existingManualDecision: manual,
  });
  return {
    sourceRef: parsed.source.recordRef,
    occurredOn: parsed.transaction.occurredOn,
    merchantName: parsed.transaction.merchantName,
    instrumentFingerprint: parsed.transaction.instrumentFingerprint,
    observedAt: parsed.source.observedAt,
    existingManualDecision:
      parsed.existingManualDecision === null
        ? null
        : {
            action: parsed.existingManualDecision.action,
            kidId: parsed.existingManualDecision.kidId,
            decidedAt: parsed.existingManualDecision.decidedAt,
          },
  };
}

function toAttributionInput(
  item: AttributionBatchItemV1,
  actor: PolicyActorV1
): AttributionInputV1 {
  return parseAttributionInputV1({
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    householdId: actor.householdId,
    source: {
      system: 'monarch-bridge',
      recordRef: item.sourceRef,
      observedAt: item.observedAt,
    },
    transaction: {
      merchantName: item.merchantName,
      instrumentFingerprint: item.instrumentFingerprint,
      occurredOn: item.occurredOn,
    },
    historicalAttributions: [],
    existingManualDecision:
      item.existingManualDecision === null
        ? null
        : {
            ...item.existingManualDecision,
            actorId: actor.actorId,
            explanation: 'An existing manual decision is preserved.',
          },
  });
}

function toBatchResult(result: AttributionResultV1): AttributionBatchResultV1 {
  if (result.provenance.policyVersion === null) {
    throw new AttributionBatchError(
      'policy_unavailable',
      'Household attribution policy is unavailable'
    );
  }
  return {
    contractVersion: result.contractVersion,
    sourceRef: result.sourceRef,
    status: result.status,
    kidId: result.kidId,
    confidence: result.confidence,
    method: result.method,
    explanation: result.explanation,
    reviewStatus: result.review.status,
    reasons: result.review.reasons,
    decisionSource: result.provenance.decisionSource,
    policyVersion: result.provenance.policyVersion,
    engineVersion: result.provenance.engineVersion,
    evaluatedAt: result.provenance.evaluatedAt,
  };
}

function strictObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('request values must be objects');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    keys.some((key) => !(key in record))
  ) {
    invalid('request has missing or unexpected fields');
  }
  return record;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive integer`);
  }
  return value as number;
}

function invalid(message: string): never {
  throw new ContractValidationError(message);
}
