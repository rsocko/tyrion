import { createHash, randomUUID } from 'node:crypto';
import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  ContractValidationError,
  parseAttributionInputV1,
  parseAttributionResultV1,
  parsePolicyActorV1,
  parseTimestampV1,
  type AttributionInputV1,
  type AttributionResultV1,
  type AttributionReviewReasonV1,
  type PolicyActorV1,
} from './contracts/v1.js';
import {
  authorizeAttributionActions,
  type PolicyRepository,
} from './policy/service.js';

export const ATTRIBUTION_ACTION_PROVENANCE =
  'mission-control-normalized-v2' as const;
export const ATTRIBUTION_ACTION_DEFER_MAX_MS = 30 * 24 * 60 * 60 * 1_000;

export type AttributionMutationActionV1 =
  | 'assign-kid'
  | 'mark-parent-expense'
  | 'unassign'
  | 'resolve-exception'
  | 'defer-exception';

interface AttributionActionRequestBaseV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  provenance: typeof ATTRIBUTION_ACTION_PROVENANCE;
  sourceRef: string;
  expectedPolicyVersion: number;
}

export interface ExplainAttributionRequestV1
  extends AttributionActionRequestBaseV1 {
  action: 'explain';
}

interface AttributionMutationRequestBaseV1
  extends AttributionActionRequestBaseV1 {
  expectedStateVersion: number;
  idempotencyKey: string;
  confirm: true;
}

export interface AssignKidAttributionRequestV1
  extends AttributionMutationRequestBaseV1 {
  action: 'assign-kid';
  kidId: string;
}

export interface MarkParentExpenseAttributionRequestV1
  extends AttributionMutationRequestBaseV1 {
  action: 'mark-parent-expense';
}

export interface UnassignAttributionRequestV1
  extends AttributionMutationRequestBaseV1 {
  action: 'unassign';
}

export interface ResolveAttributionExceptionRequestV1
  extends AttributionMutationRequestBaseV1 {
  action: 'resolve-exception';
}

export interface DeferAttributionExceptionRequestV1
  extends AttributionMutationRequestBaseV1 {
  action: 'defer-exception';
  deferUntil: string;
}

export type AttributionActionRequestV1 =
  | ExplainAttributionRequestV1
  | AssignKidAttributionRequestV1
  | MarkParentExpenseAttributionRequestV1
  | UnassignAttributionRequestV1
  | ResolveAttributionExceptionRequestV1
  | DeferAttributionExceptionRequestV1;

export interface AttributionExceptionStateV1 {
  status: 'open' | 'resolved' | 'deferred';
  reasons: AttributionReviewReasonV1[];
  deferredUntil: string | null;
  updatedAt: string;
}

export interface AttributionActionAuditV1 {
  actionRef: string;
  idempotencyKey: string;
  action: AttributionMutationActionV1;
  actorId: string;
  outcome: 'applied' | 'replayed';
  previousStateVersion: number;
  stateVersion: number;
  policyVersion: number;
  appliedAt: string;
}

export interface AttributionActionRecordV1 {
  input: AttributionInputV1;
  attribution: AttributionResultV1;
  stateVersion: number;
  exception: AttributionExceptionStateV1;
  lastAction: AttributionActionAuditV1 | null;
}

export interface AttributionActionMutationV1 {
  request: Exclude<AttributionActionRequestV1, ExplainAttributionRequestV1>;
  requestFingerprint: string;
  input: AttributionInputV1;
  attribution: AttributionResultV1;
  exception: AttributionExceptionStateV1;
  audit: Omit<AttributionActionAuditV1, 'outcome' | 'stateVersion'>;
}

export interface AttributionActionApplyResultV1 {
  record: AttributionActionRecordV1;
  replayed: boolean;
  requestFingerprint: string;
}

export interface AttributionActionRepository {
  load(
    householdId: string,
    sourceRef: string
  ): Promise<AttributionActionRecordV1 | null>;
  loadReplay(
    householdId: string,
    sourceRef: string,
    idempotencyKey: string
  ): Promise<AttributionActionApplyResultV1 | null>;
  applyIfCurrent(
    householdId: string,
    mutation: AttributionActionMutationV1
  ): Promise<AttributionActionApplyResultV1 | null>;
}

export interface AttributionActionResponseV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  sourceRef: string;
  policyVersion: number;
  engineVersion: typeof KID_ATTRIBUTION_ENGINE_VERSION;
  stateVersion: number;
  attribution: AttributionResultV1;
  exception: AttributionExceptionStateV1;
  availableActions: Array<
    'explain' | AttributionMutationActionV1 | 'open-in-monarch'
  >;
  assignableKidIds: string[];
  authoritativeDeepLink: {
    system: 'monarch';
    target: 'transaction';
    sourceRef: string;
  };
  provenance: {
    sourceSystem: 'monarch';
    normalizedBy: 'monarch-bridge';
    decidedBy: 'tyrion';
    decisionSource: AttributionResultV1['provenance']['decisionSource'];
    evaluatedAt: string;
  };
  audit: AttributionActionAuditV1 | null;
}

export interface AttributionActionServiceOptions {
  now?: () => Date;
  actionRef?: () => string;
}

export class AttributionActionService {
  private readonly now: () => Date;
  private readonly actionRef: () => string;

  constructor(
    private readonly policyRepository: PolicyRepository,
    private readonly actionRepository: AttributionActionRepository,
    options: AttributionActionServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.actionRef = options.actionRef ?? randomUUID;
  }

  async act(
    actorValue: PolicyActorV1,
    requestValue: unknown
  ): Promise<AttributionActionResponseV1> {
    const actor = parsePolicyActorV1(actorValue);
    authorizeAttributionActions(actor, actor.householdId);
    const request = parseAttributionActionRequestV1(requestValue);
    const policy = await this.policyRepository.load(actor.householdId);
    if (!policy) {
      throw new AttributionActionError(
        'policy_unavailable',
        'Household attribution policy is unavailable'
      );
    }
    if (request.expectedPolicyVersion !== policy.policyVersion) {
      throw new AttributionActionError(
        'policy_conflict',
        'Attribution policy version changed'
      );
    }

    const record = await this.actionRepository.load(
      actor.householdId,
      request.sourceRef
    );
    if (!record) {
      throw new AttributionActionError(
        'attribution_not_found',
        'Attribution state was not found'
      );
    }
    const current = parseAttributionActionRecordV1(record);
    if (
      current.input.householdId !== actor.householdId ||
      current.input.source.recordRef !== request.sourceRef ||
      current.attribution.sourceRef !== request.sourceRef
    ) {
      throw new AttributionActionError(
        'attribution_state_invalid',
        'Attribution state is unavailable'
      );
    }

    if (request.action === 'explain') {
      return response(current, policy.policyVersion, policy.kids);
    }
    const requestFingerprint = attributionActionRequestFingerprintV1(request);
    const replay = await this.actionRepository.loadReplay(
      actor.householdId,
      request.sourceRef,
      request.idempotencyKey
    );
    if (replay) {
      return response(
        validateAppliedResult(
          replay,
          actor,
          request,
          policy.policyVersion,
          requestFingerprint
        ),
        policy.policyVersion,
        policy.kids
      );
    }
    if (current.stateVersion !== request.expectedStateVersion) {
      throw new AttributionActionError(
        'attribution_state_conflict',
        'Attribution state changed'
      );
    }

    const appliedAt = this.now().toISOString();
    const next = nextState(
      current,
      request,
      policy.kids,
      policy.policyVersion,
      actor.actorId,
      appliedAt
    );
    const result = await this.policyRepository.withPolicyVersionFence(
      actor.householdId,
      policy.policyVersion,
      () =>
        this.actionRepository.applyIfCurrent(actor.householdId, {
          request,
          requestFingerprint,
          input: next.input,
          attribution: next.attribution,
          exception: next.exception,
          audit: {
            actionRef: this.actionRef(),
            idempotencyKey: request.idempotencyKey,
            action: request.action,
            actorId: actor.actorId,
            previousStateVersion: current.stateVersion,
            policyVersion: policy.policyVersion,
            appliedAt,
          },
        })
    );
    if (!result) {
      const currentPolicy = await this.policyRepository.load(actor.householdId);
      if (currentPolicy?.policyVersion !== policy.policyVersion) {
        throw new AttributionActionError(
          'policy_conflict',
          'Attribution policy version changed'
        );
      }
      throw new AttributionActionError(
        'attribution_state_conflict',
        'Attribution state changed'
      );
    }
    const normalized = validateAppliedResult(
      result,
      actor,
      request,
      policy.policyVersion,
      requestFingerprint
    );
    return response(normalized, policy.policyVersion, policy.kids);
  }
}

export type AttributionActionErrorCode =
  | 'policy_unavailable'
  | 'policy_conflict'
  | 'attribution_not_found'
  | 'attribution_state_conflict'
  | 'attribution_state_invalid'
  | 'idempotency_conflict'
  | 'kid_not_assignable'
  | 'action_not_available'
  | 'invalid_defer_window';

export class AttributionActionError extends Error {
  constructor(
    readonly code: AttributionActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AttributionActionError';
  }
}

export function parseAttributionActionRequestV1(
  value: unknown
): AttributionActionRequestV1 {
  const request = strictObject(value);
  const action = enumeration(
    request.action,
    [
      'explain',
      'assign-kid',
      'mark-parent-expense',
      'unassign',
      'resolve-exception',
      'defer-exception',
    ] as const,
    'action'
  );
  const commonKeys = [
    'contractVersion',
    'provenance',
    'sourceRef',
    'expectedPolicyVersion',
    'action',
  ];
  const actionKeys =
    action === 'explain'
      ? []
      : [
          'expectedStateVersion',
          'idempotencyKey',
          'confirm',
          ...(action === 'assign-kid' ? ['kidId'] : []),
          ...(action === 'defer-exception' ? ['deferUntil'] : []),
        ];
  exactKeys(request, [...commonKeys, ...actionKeys]);
  literal(request.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  literal(request.provenance, ATTRIBUTION_ACTION_PROVENANCE, 'provenance');
  const base = {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    provenance: ATTRIBUTION_ACTION_PROVENANCE,
    sourceRef: identifier(request.sourceRef, 'sourceRef'),
    expectedPolicyVersion: positiveInteger(
      request.expectedPolicyVersion,
      'expectedPolicyVersion'
    ),
  };
  if (action === 'explain') return { ...base, action };
  if (request.confirm !== true) invalid('confirm must be true');
  const mutation = {
    ...base,
    action,
    expectedStateVersion: positiveInteger(
      request.expectedStateVersion,
      'expectedStateVersion'
    ),
    idempotencyKey: identifier(request.idempotencyKey, 'idempotencyKey'),
    confirm: true as const,
  };
  if (action === 'assign-kid') {
    return { ...mutation, action, kidId: identifier(request.kidId, 'kidId') };
  }

  if (action === 'defer-exception') {
    return {
      ...mutation,
      action,
      deferUntil: timestamp(request.deferUntil, 'deferUntil'),
    };
  }
  if (action === 'mark-parent-expense') {
    return { ...mutation, action };
  }
  if (action === 'unassign') {
    return { ...mutation, action };
  }
  return { ...mutation, action: 'resolve-exception' };
}

export function attributionActionRequestFingerprintV1(
  request: Exclude<AttributionActionRequestV1, ExplainAttributionRequestV1>
): string {
  const actionValue =
    request.action === 'assign-kid'
      ? request.kidId
      : request.action === 'defer-exception'
        ? request.deferUntil
        : null;
  const canonical = JSON.stringify([
    request.contractVersion,
    request.provenance,
    request.sourceRef,
    request.expectedPolicyVersion,
    request.action,
    request.expectedStateVersion,
    request.confirm,
    actionValue,
  ]);
  return `action-request-v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function parseAttributionActionRecordV1(
  value: unknown
): AttributionActionRecordV1 {
  const record = strictObject(value);
  exactKeys(record, [
    'input',
    'attribution',
    'stateVersion',
    'exception',
    'lastAction',
  ]);
  const input = parseAttributionInputV1(record.input);
  const attribution = parseAttributionResultV1(record.attribution);
  const exception = parseException(record.exception);
  const lastAction =
    record.lastAction === null ? null : parseAudit(record.lastAction);
  const stateVersion = positiveInteger(record.stateVersion, 'stateVersion');
  if (
    input.source.recordRef !== attribution.sourceRef ||
    (lastAction !== null && lastAction.stateVersion !== stateVersion)
  ) {
    invalid('attribution action record is inconsistent');
  }
  if (
    (exception.status === 'resolved' &&
      attribution.review.status === 'pending') ||
    (exception.status !== 'resolved' &&
      (attribution.review.status !== 'pending' ||
        JSON.stringify(exception.reasons) !==
          JSON.stringify(attribution.review.reasons)))
  ) {
    invalid('attribution and exception state are inconsistent');
  }
  return { input, attribution, stateVersion, exception, lastAction };
}

function nextState(
  current: AttributionActionRecordV1,
  request: Exclude<AttributionActionRequestV1, ExplainAttributionRequestV1>,
  kids: Array<{ id: string; active: boolean }>,
  policyVersion: number,
  actorId: string,
  appliedAt: string
): Pick<AttributionActionRecordV1, 'input' | 'attribution' | 'exception'> {
  if (request.action === 'defer-exception') {
    if (current.exception.status === 'resolved') {
      throw new AttributionActionError(
        'action_not_available',
        'Resolved attribution exceptions cannot be deferred'
      );
    }

    const deferMs = Date.parse(request.deferUntil) - Date.parse(appliedAt);
    if (deferMs <= 0 || deferMs > ATTRIBUTION_ACTION_DEFER_MAX_MS) {
      throw new AttributionActionError(
        'invalid_defer_window',
        'Attribution exceptions may be deferred for up to 30 days'
      );
    }
    return {
      input: current.input,
      attribution: current.attribution,
      exception: {
        status: 'deferred',
        reasons: current.exception.reasons,
        deferredUntil: request.deferUntil,
        updatedAt: appliedAt,
      },
    };
  }

  let action: 'assign-kid' | 'parent-expense' | 'unassign';
  let kidId: string | null;
  let explanation: string;
  if (request.action === 'assign-kid') {
    if (!kids.some((kid) => kid.active && kid.id === request.kidId)) {
      throw new AttributionActionError(
        'kid_not_assignable',
        'The selected kid is not available for attribution'
      );
    }
    action = 'assign-kid';
    kidId = request.kidId;
    explanation = 'A household operator assigned this transaction to a kid.';
  } else if (request.action === 'resolve-exception') {
    if (
      current.exception.status === 'resolved' ||
      current.attribution.kidId === null
    ) {
      throw new AttributionActionError(
        'action_not_available',
        'This attribution exception requires a correction before it can be resolved'
      );
    }
    if (current.attribution.provenance.policyVersion !== policyVersion) {
      throw new AttributionActionError(
        'policy_conflict',
        'Attribution policy version changed'
      );
    }
    if (
      !kids.some(
        (kid) => kid.active && kid.id === current.attribution.kidId
      )
    ) {
      throw new AttributionActionError(
        'kid_not_assignable',
        'The selected kid is not available for attribution'
      );
    }
    action = 'assign-kid';
    kidId = current.attribution.kidId;
    explanation = 'A household operator confirmed the current kid attribution.';
  } else {
    action =
      request.action === 'mark-parent-expense' ? 'parent-expense' : 'unassign';
    kidId = null;
    explanation =
      request.action === 'mark-parent-expense'
        ? 'A household operator marked this transaction as a parent expense.'
        : 'A household operator explicitly left this transaction unassigned.';
  }
  const input = parseAttributionInputV1({
    ...current.input,
    existingManualDecision: {
      action,
      kidId,
      actorId,
      decidedAt: appliedAt,
      explanation,
    },
  });
  return {
    input,
    attribution: {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      sourceRef: input.source.recordRef,
      status: action === 'assign-kid' ? 'attributed' : 'unassigned',
      kidId,
      confidence: 'definite',
      method: 'manual',
      explanation,
      review: { status: 'resolved', reasons: [] },
      provenance: {
        decisionSource: 'manual',
        policyVersion,
        engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
        ruleIds: [],
        evaluatedAt: appliedAt,
      },
    },
    exception: {
      status: 'resolved',
      reasons: [],
      deferredUntil: null,
      updatedAt: appliedAt,
    },
  };
}

function validateAppliedResult(
  result: AttributionActionApplyResultV1,
  actor: PolicyActorV1,
  request: Exclude<AttributionActionRequestV1, ExplainAttributionRequestV1>,
  policyVersion: number,
  requestFingerprint: string
): AttributionActionRecordV1 {
  if (result.requestFingerprint !== requestFingerprint) {
    throw new AttributionActionError(
      'idempotency_conflict',
      'Idempotency key was already used for a different attribution action'
    );
  }
  const applied = parseAttributionActionRecordV1(result.record);
  const audit = applied.lastAction;
  if (
    applied.input.householdId !== actor.householdId ||
    applied.input.source.recordRef !== request.sourceRef ||
    applied.attribution.sourceRef !== request.sourceRef ||
    !audit ||
    audit.idempotencyKey !== request.idempotencyKey ||
    audit.action !== request.action ||
    audit.actorId !== actor.actorId ||
    audit.previousStateVersion !== request.expectedStateVersion ||
    audit.stateVersion !== request.expectedStateVersion + 1 ||
    audit.policyVersion !== policyVersion
  ) {
    throw new AttributionActionError(
      'attribution_state_invalid',
      'Attribution state is unavailable'
    );
  }
  return {
    ...applied,
    lastAction: {
      ...audit,
      outcome: result.replayed ? 'replayed' : 'applied',
    },
  };
}

function response(
  record: AttributionActionRecordV1,
  policyVersion: number,
  kids: Array<{ id: string; active: boolean }>
): AttributionActionResponseV1 {
  const availableActions: AttributionActionResponseV1['availableActions'] = [
    'explain',
    'assign-kid',
    'mark-parent-expense',
    'unassign',
  ];
  if (
    record.exception.status !== 'resolved' &&
    record.attribution.kidId !== null &&
    record.attribution.provenance.policyVersion === policyVersion
  ) {
    availableActions.push('resolve-exception');
  }
  if (record.exception.status !== 'resolved') {
    availableActions.push('defer-exception');
  }
  availableActions.push('open-in-monarch');
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: record.attribution.sourceRef,
    policyVersion,
    engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
    stateVersion: record.stateVersion,
    attribution: record.attribution,
    exception: record.exception,
    availableActions,
    assignableKidIds: kids
      .filter((kid) => kid.active)
      .map((kid) => kid.id)
      .sort(),
    authoritativeDeepLink: {
      system: 'monarch',
      target: 'transaction',
      sourceRef: record.attribution.sourceRef,
    },
    provenance: {
      sourceSystem: 'monarch',
      normalizedBy: 'monarch-bridge',
      decidedBy: 'tyrion',
      decisionSource: record.attribution.provenance.decisionSource,
      evaluatedAt: record.attribution.provenance.evaluatedAt,
    },
    audit: record.lastAction,
  };
}

function parseException(value: unknown): AttributionExceptionStateV1 {
  const exception = strictObject(value);
  exactKeys(exception, ['status', 'reasons', 'deferredUntil', 'updatedAt']);
  const status = enumeration(
    exception.status,
    ['open', 'resolved', 'deferred'] as const,
    'exception.status'
  );
  if (!Array.isArray(exception.reasons)) invalid('exception.reasons must be an array');
  const reasons = exception.reasons.map((reason, index) =>
    reviewReason(reason, `exception.reasons[${index}]`)
  );
  if (new Set(reasons).size !== reasons.length) {
    invalid('exception.reasons must be unique');
  }
  const deferredUntil =
    exception.deferredUntil === null
      ? null
      : timestamp(exception.deferredUntil, 'exception.deferredUntil');
  if (
    (status === 'resolved' && (reasons.length !== 0 || deferredUntil !== null)) ||
    (status === 'open' && (reasons.length === 0 || deferredUntil !== null)) ||
    (status === 'deferred' && (reasons.length === 0 || deferredUntil === null))
  ) {
    invalid('attribution exception state is inconsistent');
  }
  return {
    status,
    reasons,
    deferredUntil,
    updatedAt: timestamp(exception.updatedAt, 'exception.updatedAt'),
  };
}

function parseAudit(value: unknown): AttributionActionAuditV1 {
  const audit = strictObject(value);
  exactKeys(audit, [
    'actionRef',
    'idempotencyKey',
    'action',
    'actorId',
    'outcome',
    'previousStateVersion',
    'stateVersion',
    'policyVersion',
    'appliedAt',
  ]);
  const previousStateVersion = positiveInteger(
    audit.previousStateVersion,
    'lastAction.previousStateVersion'
  );
  const stateVersion = positiveInteger(
    audit.stateVersion,
    'lastAction.stateVersion'
  );
  if (stateVersion !== previousStateVersion + 1) {
    invalid('lastAction state version is inconsistent');
  }
  return {
    actionRef: identifier(audit.actionRef, 'lastAction.actionRef'),
    idempotencyKey: identifier(
      audit.idempotencyKey,
      'lastAction.idempotencyKey'
    ),
    action: enumeration(
      audit.action,
      [
        'assign-kid',
        'mark-parent-expense',
        'unassign',
        'resolve-exception',
        'defer-exception',
      ] as const,
      'lastAction.action'
    ),
    actorId: identifier(audit.actorId, 'lastAction.actorId'),
    outcome: enumeration(
      audit.outcome,
      ['applied', 'replayed'] as const,
      'lastAction.outcome'
    ),
    previousStateVersion,
    stateVersion,
    policyVersion: positiveInteger(
      audit.policyVersion,
      'lastAction.policyVersion'
    ),
    appliedAt: timestamp(audit.appliedAt, 'lastAction.appliedAt'),
  };
}

function reviewReason(value: unknown, field: string): AttributionReviewReasonV1 {
  return enumeration(
    value,
    [
      'no-match',
      'low-confidence',
      'account-rule-conflict',
      'merchant-rule-conflict',
      'historical-attribution-tie',
      'engine-unavailable',
      'policy-unavailable',
      'policy-version-mismatch',
    ] as const,
    field
  );
}

function strictObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('request values must be objects');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    keys.some((key) => !(key in value))
  ) {
    invalid('request has missing or unexpected fields');
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    invalid(`${field} must be an exact identifier`);
  }
  if (['__proto__', 'constructor', 'prototype'].includes(value)) {
    invalid(`${field} contains a reserved value`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive integer`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a timestamp`);
  try {
    return parseTimestampV1(value as string, field);
  } catch {
    invalid(`${field} must be a valid ISO 8601 timestamp`);
  }
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    invalid(`${field} has an unsupported value`);
  }
  return value as T[number];
}

function literal(value: unknown, expected: string, field: string): void {
  if (value !== expected) invalid(`${field} is unsupported`);
}

function invalid(message: string): never {
  throw new ContractValidationError(message);
}
