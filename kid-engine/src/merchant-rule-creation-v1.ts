import { createHash, randomUUID } from 'node:crypto';
import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  ContractValidationError,
  parsePolicyActorV1,
  parsePolicyDraftV1,
  parseTimestampV1,
  policyDraftFromSnapshotV1,
  type MerchantAttributionRuleV1,
  type PolicyActorV1,
  type PolicyAuditEventV1,
  type PolicySnapshotV1,
} from './contracts/v1.js';
import {
  PolicyVersionConflictError,
  authorizeMerchantRuleCreation,
  type PolicyRepository,
} from './policy/service.js';

const CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1_000;
const CONFIRMATION_FUTURE_TOLERANCE_MS = 60 * 1_000;

export interface MerchantRuleCreationRequestV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  expectedPolicyVersion: number;
  idempotencyKey: string;
  confirmation: {
    confirmed: true;
    confirmedAt: string;
  };
  rule: Omit<MerchantAttributionRuleV1, 'id' | 'enabled'>;
}

export interface MerchantRuleCreationResponseV1 {
  contractVersion: typeof TYRION_DOMAIN_CONTRACT_VERSION;
  outcome: 'created' | 'replayed';
  policyVersion: number;
  rule: MerchantAttributionRuleV1;
}

export type AccountReferenceValidator = (
  accountRefs: readonly string[]
) => Promise<boolean>;

export interface MerchantRuleCreationServiceOptions {
  now?: () => Date;
  eventId?: () => string;
}

export class MerchantRuleCreationService {
  private readonly now: () => Date;
  private readonly eventId: () => string;

  constructor(
    private readonly repository: PolicyRepository,
    options: MerchantRuleCreationServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.eventId = options.eventId ?? randomUUID;
  }

  async create(
    actorValue: PolicyActorV1,
    requestValue: unknown,
    validateAccountRefs: AccountReferenceValidator
  ): Promise<MerchantRuleCreationResponseV1> {
    const actor = parsePolicyActorV1(actorValue);
    authorizeMerchantRuleCreation(actor, actor.householdId);
    const request = parseMerchantRuleCreationRequestV1(requestValue);
    const current = await this.repository.load(actor.householdId);
    if (!current) {
      throw new MerchantRuleCreationError(
        'policy_unavailable',
        'Household attribution policy is unavailable'
      );
    }

    const ruleId = deterministicRuleId(
      actor.householdId,
      actor.actorId,
      request.idempotencyKey
    );
    const rule = canonicalRule(current, ruleId, request.rule);
    const existing = current.merchantRules.find((candidate) => candidate.id === ruleId);
    if (existing) {
      if (!sameRule(existing, rule)) {
        throw new MerchantRuleCreationError(
          'merchant_rule_idempotency_conflict',
          'Idempotency key was already used for a different merchant rule'
        );
      }
      return {
        contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
        outcome: 'replayed',
        policyVersion: current.policyVersion,
        rule: existing,
      };
    }

    validateFreshConfirmation(request.confirmation.confirmedAt, this.now());
    if (current.policyVersion !== request.expectedPolicyVersion) {
      throw new MerchantRuleCreationError(
        'policy_version_conflict',
        'Attribution policy version changed'
      );
    }
    if (rule.scope === 'accounts') {
      let validAccounts: boolean;
      try {
        validAccounts = await validateAccountRefs(rule.accountRefs);
      } catch {
        throw new MerchantRuleCreationError(
          'policy_unavailable',
          'Account validation is unavailable'
        );
      }
      if (!validAccounts) {
        throw new MerchantRuleCreationError(
          'merchant_rule_account_not_found',
          'One or more selected accounts are unavailable'
        );
      }
    }

    const occurredAt = this.now().toISOString();
    const snapshot: PolicySnapshotV1 = {
      ...current,
      policyVersion: current.policyVersion + 1,
      updatedAt: occurredAt,
      merchantRules: [...current.merchantRules, rule],
    };
    const auditEvent: PolicyAuditEventV1 = {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      eventId: this.eventId(),
      householdId: actor.householdId,
      actorId: actor.actorId,
      action: 'merchant-rule-created',
      previousPolicyVersion: current.policyVersion,
      policyVersion: snapshot.policyVersion,
      occurredAt,
    };
    try {
      await this.repository.save(snapshot, current.policyVersion, auditEvent);
    } catch (error) {
      if (!(error instanceof PolicyVersionConflictError)) throw error;
      const latest = await this.repository.load(actor.householdId);
      if (!latest) {
        throw new MerchantRuleCreationError(
          'policy_unavailable',
          'Household attribution policy is unavailable'
        );
      }
      const replayRule = canonicalRule(latest, ruleId, request.rule);
      const replayed = latest.merchantRules.find(
        (candidate) => candidate.id === ruleId
      );
      if (replayed) {
        if (!sameRule(replayed, replayRule)) {
          throw new MerchantRuleCreationError(
            'merchant_rule_idempotency_conflict',
            'Idempotency key was already used for a different merchant rule'
          );
        }
        return {
          contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
          outcome: 'replayed',
          policyVersion: latest.policyVersion,
          rule: replayed,
        };
      }
      throw new MerchantRuleCreationError(
        'policy_version_conflict',
        'Attribution policy version changed'
      );
    }
    return {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      outcome: 'created',
      policyVersion: snapshot.policyVersion,
      rule,
    };
  }
}

export class MerchantRuleCreationError extends Error {
  constructor(
    readonly code:
      | 'policy_unavailable'
      | 'policy_version_conflict'
      | 'merchant_rule_idempotency_conflict'
      | 'merchant_rule_confirmation_required'
      | 'merchant_rule_confirmation_expired'
      | 'merchant_rule_account_not_found',
    message: string
  ) {
    super(message);
    this.name = 'MerchantRuleCreationError';
  }
}

function parseMerchantRuleCreationRequestV1(
  value: unknown
): MerchantRuleCreationRequestV1 {
  const request = strictObject(value, [
    'contractVersion',
    'expectedPolicyVersion',
    'idempotencyKey',
    'confirmation',
    'rule',
  ]);
  if (request.contractVersion !== TYRION_DOMAIN_CONTRACT_VERSION) {
    invalid('contractVersion is unsupported');
  }
  const expectedPolicyVersion = positiveInteger(
    request.expectedPolicyVersion,
    'expectedPolicyVersion'
  );
  const idempotencyKey = identifier(
    request.idempotencyKey,
    'idempotencyKey',
    8
  );
  const confirmation = strictObject(request.confirmation, [
    'confirmed',
    'confirmedAt',
  ]);
  if (confirmation.confirmed !== true) {
    throw new MerchantRuleCreationError(
      'merchant_rule_confirmation_required',
      'Explicit merchant rule confirmation is required'
    );
  }
  const confirmedAt = parseTimestampV1(
    confirmation.confirmedAt,
    'confirmation.confirmedAt'
  );
  const rule = strictObject(request.rule, [
    'outcome',
    'kidId',
    'pattern',
    'businessEntityPattern',
    'scope',
    'accountRefs',
    'confidence',
  ]);
  const provisionalDraft = parsePolicyDraftV1({
    timezone: 'UTC',
    currency: 'USD',
    kids:
      rule.outcome === 'kid' && typeof rule.kidId === 'string'
        ? [{ id: rule.kidId, displayName: 'Rule target', color: null, active: true }]
        : [],
    accountDefaults: [],
    merchantRules: [
      {
        id: 'rule-provisional',
        ...rule,
        enabled: true,
      },
    ],
    limits: [],
    exceptionPolicy: {
      limitWarningPercent: 80,
      requireReviewForLikelyAttribution: true,
      notificationSignals: [],
    },
  });
  const parsedRule = provisionalDraft.merchantRules[0];
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    expectedPolicyVersion,
    idempotencyKey,
    confirmation: { confirmed: true, confirmedAt },
    rule: {
      outcome: parsedRule.outcome,
      kidId: parsedRule.kidId,
      pattern: parsedRule.pattern,
      businessEntityPattern: parsedRule.businessEntityPattern,
      scope: parsedRule.scope,
      accountRefs: parsedRule.accountRefs,
      confidence: parsedRule.confidence,
    },
  };
}

function canonicalRule(
  policy: PolicySnapshotV1,
  id: string,
  rule: MerchantRuleCreationRequestV1['rule']
): MerchantAttributionRuleV1 {
  const parsed = parsePolicyDraftV1({
    ...policyDraftFromSnapshotV1(policy),
    merchantRules: [
      ...policy.merchantRules.filter((candidate) => candidate.id !== id),
      {
        id,
        ...rule,
        enabled: true,
      },
    ],
  });
  return parsed.merchantRules[parsed.merchantRules.length - 1];
}

function deterministicRuleId(
  householdId: string,
  actorId: string,
  idempotencyKey: string
): string {
  const digest = createHash('sha256')
    .update(`${householdId}\0${actorId}\0${idempotencyKey}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `rule-merchant-${digest}`;
}

function sameRule(
  left: MerchantAttributionRuleV1,
  right: MerchantAttributionRuleV1
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateFreshConfirmation(confirmedAt: string, now: Date): void {
  const timestamp = Date.parse(confirmedAt);
  const age = now.getTime() - timestamp;
  if (
    age > CONFIRMATION_MAX_AGE_MS ||
    age < -CONFIRMATION_FUTURE_TOLERANCE_MS
  ) {
    throw new MerchantRuleCreationError(
      'merchant_rule_confirmation_expired',
      'Merchant rule confirmation expired'
    );
  }
}

function strictObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid('request must be an object');
  }
  const result = value as Record<string, unknown>;
  const actualKeys = Object.keys(result);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    invalid('request fields are invalid');
  }
  return result;
}

function identifier(value: unknown, field: string, minimum = 1): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > 128 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    invalid(`${field} is invalid`);
  }
  return value;
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
