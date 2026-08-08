export const TYRION_DOMAIN_CONTRACT_VERSION = '1.0' as const;
export const KID_ATTRIBUTION_ENGINE_VERSION = '1.0.0' as const;
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const SUPPORTED_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

export type TyrionDomainContractVersion = typeof TYRION_DOMAIN_CONTRACT_VERSION;
export type KidAttributionEngineVersion = typeof KID_ATTRIBUTION_ENGINE_VERSION;
export type AttributionConfidenceV1 = 'definite' | 'likely' | 'none';
export type LimitPeriodV1 = 'daily' | 'weekly' | 'monthly';
export type PolicyPermissionV1 =
  | 'policy:read'
  | 'policy:write'
  | 'reattribution:preview'
  | 'reattribution:apply';

export interface KidProfileV1 {
  id: string;
  displayName: string;
  color: string | null;
  active: boolean;
}

export interface CardAttributionRuleV1 {
  id: string;
  kidId: string;
  instrumentFingerprint: string;
  confidence: Exclude<AttributionConfidenceV1, 'none'>;
  enabled: boolean;
}

export interface MerchantAttributionRuleV1 {
  id: string;
  kidId: string;
  pattern: string;
  confidence: Exclude<AttributionConfidenceV1, 'none'>;
  enabled: boolean;
}

export interface SpendingLimitV1 {
  kidId: string;
  period: LimitPeriodV1;
  amount: number;
  currency: string;
}

export interface PolicyDraftV1 {
  timezone: string;
  currency: string;
  kids: KidProfileV1[];
  cardRules: CardAttributionRuleV1[];
  merchantRules: MerchantAttributionRuleV1[];
  limits: SpendingLimitV1[];
}

export interface PolicySnapshotV1 extends PolicyDraftV1 {
  contractVersion: TyrionDomainContractVersion;
  engineVersion: KidAttributionEngineVersion;
  householdId: string;
  policyVersion: number;
  updatedAt: string;
}

export interface AttributionSourceV1 {
  system: 'monarch-bridge';
  recordRef: string;
  observedAt: string;
}

export interface NormalizedAttributionTransactionV1 {
  merchantName: string;
  instrumentFingerprint: string | null;
  occurredOn: string;
}

export interface HistoricalAttributionV1 {
  normalizedMerchant: string;
  kidId: string;
  assignmentCount: number;
}

export interface ManualAttributionDecisionV1 {
  action: 'assign-kid' | 'parent-expense';
  kidId: string | null;
  actorId: string;
  decidedAt: string;
  explanation: string;
}

export interface AttributionInputV1 {
  contractVersion: TyrionDomainContractVersion;
  householdId: string;
  source: AttributionSourceV1;
  transaction: NormalizedAttributionTransactionV1;
  historicalAttributions: HistoricalAttributionV1[];
  existingManualDecision: ManualAttributionDecisionV1 | null;
}

export type AttributionMethodV1 =
  | 'manual'
  | 'card-rule'
  | 'merchant-rule'
  | 'historical-pattern'
  | 'unassigned'
  | 'unavailable';

export type AttributionReviewReasonV1 =
  | 'no-match'
  | 'low-confidence'
  | 'card-rule-conflict'
  | 'merchant-rule-conflict'
  | 'historical-attribution-tie'
  | 'engine-unavailable'
  | 'policy-unavailable'
  | 'policy-version-mismatch';

export interface AttributionReviewStateV1 {
  status: 'not-required' | 'pending' | 'resolved';
  reasons: AttributionReviewReasonV1[];
}

export interface AttributionProvenanceV1 {
  decisionSource: 'manual' | 'automated' | 'fallback';
  policyVersion: number | null;
  engineVersion: KidAttributionEngineVersion;
  ruleIds: string[];
  evaluatedAt: string;
}

export interface AttributionResultV1 {
  contractVersion: TyrionDomainContractVersion;
  sourceRef: string;
  status: 'attributed' | 'unassigned' | 'pending';
  kidId: string | null;
  confidence: AttributionConfidenceV1;
  method: AttributionMethodV1;
  explanation: string;
  review: AttributionReviewStateV1;
  provenance: AttributionProvenanceV1;
}

export type AttributionReviewActionV1 =
  | { action: 'assign-kid'; kidId: string; explanation: string }
  | { action: 'mark-parent-expense'; explanation: string }
  | { action: 'confirm-suggestion'; explanation: string }
  | { action: 'flag'; explanation: string }
  | { action: 'defer'; explanation: string };

export interface ReattributionPreviewRequestV1 {
  contractVersion: TyrionDomainContractVersion;
  householdId: string;
  expectedPolicyVersion: number;
  sourceRefs: string[];
}

export interface ReattributionPreviewItemV1 {
  sourceRef: string;
  previous: AttributionResultV1;
  proposed: AttributionResultV1;
  disposition:
    | 'unchanged'
    | 'would-update'
    | 'manual-preserved'
    | 'pending-review';
}

export interface ReattributionPreviewV1 {
  contractVersion: TyrionDomainContractVersion;
  previewId: string;
  householdId: string;
  policyVersion: number;
  createdAt: string;
  expiresAt: string;
  items: ReattributionPreviewItemV1[];
}

export interface ReattributionApplyRequestV1 {
  contractVersion: TyrionDomainContractVersion;
  householdId: string;
  previewId: string;
  expectedPolicyVersion: number;
  confirm: true;
}

export interface ReattributionApplyResultV1 {
  contractVersion: TyrionDomainContractVersion;
  previewId: string;
  policyVersion: number;
  applied: number;
  unchanged: number;
  manualPreserved: number;
  pendingReview: number;
  appliedAt: string;
}

export interface PolicyActorV1 {
  actorId: string;
  householdId: string;
  permissions: PolicyPermissionV1[];
}

export interface PolicyAuditEventV1 {
  contractVersion: TyrionDomainContractVersion;
  eventId: string;
  householdId: string;
  actorId: string;
  action: 'policy-created' | 'policy-replaced';
  previousPolicyVersion: number | null;
  policyVersion: number;
  occurredAt: string;
}

export function parseReattributionPreviewRequestV1(
  value: unknown
): ReattributionPreviewRequestV1 {
  const request = object(value, 're-attribution preview request');
  exactKeys(request, [
    'contractVersion',
    'householdId',
    'expectedPolicyVersion',
    'sourceRefs',
  ]);
  literal(request.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  const sourceRefs = array(request.sourceRefs, 'sourceRefs').map((sourceRef, index) =>
    identifier(sourceRef, `sourceRefs[${index}]`)
  );
  if (sourceRefs.length === 0) invalid('sourceRefs must not be empty');
  unique(sourceRefs, 'sourceRefs');
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    householdId: identifier(request.householdId, 'householdId'),
    expectedPolicyVersion: positiveInteger(
      request.expectedPolicyVersion,
      'expectedPolicyVersion'
    ),
    sourceRefs,
  };
}

export function parseReattributionApplyRequestV1(
  value: unknown
): ReattributionApplyRequestV1 {
  const request = object(value, 're-attribution apply request');
  exactKeys(request, [
    'contractVersion',
    'householdId',
    'previewId',
    'expectedPolicyVersion',
    'confirm',
  ]);
  literal(request.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  if (request.confirm !== true) invalid('confirm must be true');
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    householdId: identifier(request.householdId, 'householdId'),
    previewId: identifier(request.previewId, 'previewId'),
    expectedPolicyVersion: positiveInteger(
      request.expectedPolicyVersion,
      'expectedPolicyVersion'
    ),
    confirm: true,
  };
}

export function parseAttributionResultV1(value: unknown): AttributionResultV1 {
  const result = object(value, 'attribution result');
  exactKeys(result, [
    'contractVersion',
    'sourceRef',
    'status',
    'kidId',
    'confidence',
    'method',
    'explanation',
    'review',
    'provenance',
  ]);
  literal(result.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  const status = enumeration(
    result.status,
    ['attributed', 'unassigned', 'pending'] as const,
    'status'
  );
  const kidId =
    result.kidId === null ? null : identifier(result.kidId, 'kidId');
  if (
    (status === 'attributed' && kidId === null) ||
    (status === 'unassigned' && kidId !== null)
  ) {
    invalid('attribution result status and kidId are inconsistent');
  }
  const review = object(result.review, 'review');
  exactKeys(review, ['status', 'reasons']);
  const reviewStatus = enumeration(
    review.status,
    ['not-required', 'pending', 'resolved'] as const,
    'review.status'
  );
  const reasons = array(review.reasons, 'review.reasons').map((reason, index) =>
    enumeration(
      reason,
      [
        'no-match',
        'low-confidence',
        'card-rule-conflict',
        'merchant-rule-conflict',
        'historical-attribution-tie',
        'engine-unavailable',
        'policy-unavailable',
        'policy-version-mismatch',
      ] as const,
      `review.reasons[${index}]`
    )
  );
  unique(reasons, 'review reasons');
  if (
    (reviewStatus === 'pending' && reasons.length === 0) ||
    (reviewStatus !== 'pending' && reasons.length !== 0)
  ) {
    invalid('review status and reasons are inconsistent');
  }
  const provenance = object(result.provenance, 'provenance');
  exactKeys(provenance, [
    'decisionSource',
    'policyVersion',
    'engineVersion',
    'ruleIds',
    'evaluatedAt',
  ]);
  literal(
    provenance.engineVersion,
    KID_ATTRIBUTION_ENGINE_VERSION,
    'provenance.engineVersion'
  );
  const ruleIds = array(provenance.ruleIds, 'provenance.ruleIds').map(
    (ruleId, index) => identifier(ruleId, `provenance.ruleIds[${index}]`)
  );
  unique(ruleIds, 'provenance rule ids');
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: identifier(result.sourceRef, 'sourceRef'),
    status,
    kidId,
    confidence: enumeration(
      result.confidence,
      ['definite', 'likely', 'none'] as const,
      'confidence'
    ),
    method: enumeration(
      result.method,
      [
        'manual',
        'card-rule',
        'merchant-rule',
        'historical-pattern',
        'unassigned',
        'unavailable',
      ] as const,
      'method'
    ),
    explanation: boundedString(result.explanation, 'explanation', 1, 300),
    review: { status: reviewStatus, reasons },
    provenance: {
      decisionSource: enumeration(
        provenance.decisionSource,
        ['manual', 'automated', 'fallback'] as const,
        'provenance.decisionSource'
      ),
      policyVersion:
        provenance.policyVersion === null
          ? null
          : positiveInteger(provenance.policyVersion, 'provenance.policyVersion'),
      engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
      ruleIds,
      evaluatedAt: timestamp(provenance.evaluatedAt, 'provenance.evaluatedAt'),
    },
  };
}

export function parseReattributionPreviewV1(
  value: unknown
): ReattributionPreviewV1 {
  const preview = object(value, 're-attribution preview');
  exactKeys(preview, [
    'contractVersion',
    'previewId',
    'householdId',
    'policyVersion',
    'createdAt',
    'expiresAt',
    'items',
  ]);
  literal(preview.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  const createdAt = timestamp(preview.createdAt, 'createdAt');
  const expiresAt = timestamp(preview.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    invalid('expiresAt must be later than createdAt');
  }
  const items = array(preview.items, 'items').map((item, index) => {
    const previewItem = object(item, `items[${index}]`);
    exactKeys(previewItem, [
      'sourceRef',
      'previous',
      'proposed',
      'disposition',
    ]);
    const sourceRef = identifier(
      previewItem.sourceRef,
      `items[${index}].sourceRef`
    );
    const previous = parseAttributionResultV1(previewItem.previous);
    const proposed = parseAttributionResultV1(previewItem.proposed);
    if (previous.sourceRef !== sourceRef || proposed.sourceRef !== sourceRef) {
      invalid(`items[${index}] source references are inconsistent`);
    }
    return {
      sourceRef,
      previous,
      proposed,
      disposition: enumeration(
        previewItem.disposition,
        [
          'unchanged',
          'would-update',
          'manual-preserved',
          'pending-review',
        ] as const,
        `items[${index}].disposition`
      ),
    };
  });
  unique(
    items.map((item) => item.sourceRef),
    'preview source references'
  );
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    previewId: identifier(preview.previewId, 'previewId'),
    householdId: identifier(preview.householdId, 'householdId'),
    policyVersion: positiveInteger(preview.policyVersion, 'policyVersion'),
    createdAt,
    expiresAt,
    items,
  };
}

export function parsePolicyActorV1(value: unknown): PolicyActorV1 {
  const actor = object(value, 'policy actor');
  exactKeys(actor, ['actorId', 'householdId', 'permissions']);
  const permissions = array(actor.permissions, 'permissions').map(
    (permission, index) =>
      enumeration(
        permission,
        [
          'policy:read',
          'policy:write',
          'reattribution:preview',
          'reattribution:apply',
        ] as const,
        `permissions[${index}]`
      )
  );
  unique(permissions, 'permissions');
  return {
    actorId: identifier(actor.actorId, 'actorId'),
    householdId: identifier(actor.householdId, 'householdId'),
    permissions,
  };
}

export function parsePolicyAuditEventV1(value: unknown): PolicyAuditEventV1 {
  const event = object(value, 'policy audit event');
  exactKeys(event, [
    'contractVersion',
    'eventId',
    'householdId',
    'actorId',
    'action',
    'previousPolicyVersion',
    'policyVersion',
    'occurredAt',
  ]);
  literal(event.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  const previousPolicyVersion =
    event.previousPolicyVersion === null
      ? null
      : positiveInteger(event.previousPolicyVersion, 'previousPolicyVersion');
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    eventId: identifier(event.eventId, 'eventId'),
    householdId: identifier(event.householdId, 'householdId'),
    actorId: identifier(event.actorId, 'actorId'),
    action: enumeration(
      event.action,
      ['policy-created', 'policy-replaced'] as const,
      'action'
    ),
    previousPolicyVersion,
    policyVersion: positiveInteger(event.policyVersion, 'policyVersion'),
    occurredAt: timestamp(event.occurredAt, 'occurredAt'),
  };
}

export function parseTimestampV1(value: unknown, field = 'timestamp'): string {
  return timestamp(value, field);
}

export function parsePolicySnapshotV1(value: unknown): PolicySnapshotV1 {
  const snapshot = object(value, 'policy snapshot');
  exactKeys(snapshot, [
    'contractVersion',
    'engineVersion',
    'householdId',
    'policyVersion',
    'updatedAt',
    'timezone',
    'currency',
    'kids',
    'cardRules',
    'merchantRules',
    'limits',
  ]);
  literal(snapshot.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  literal(snapshot.engineVersion, KID_ATTRIBUTION_ENGINE_VERSION, 'engineVersion');
  const householdId = identifier(snapshot.householdId, 'householdId');
  const policyVersion = positiveInteger(snapshot.policyVersion, 'policyVersion');
  const updatedAt = timestamp(snapshot.updatedAt, 'updatedAt');
  const draft = parsePolicyDraftV1({
    timezone: snapshot.timezone,
    currency: snapshot.currency,
    kids: snapshot.kids,
    cardRules: snapshot.cardRules,
    merchantRules: snapshot.merchantRules,
    limits: snapshot.limits,
  });
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
    householdId,
    policyVersion,
    updatedAt,
    ...draft,
  };
}

export function parsePolicyDraftV1(value: unknown): PolicyDraftV1 {
  const draft = object(value, 'policy draft');
  exactKeys(draft, [
    'timezone',
    'currency',
    'kids',
    'cardRules',
    'merchantRules',
    'limits',
  ]);
  const timezone = ianaTimezone(draft.timezone, 'timezone');
  const currency = isoCurrency(draft.currency, 'currency');
  const kids = array(draft.kids, 'kids').map((item, index) => {
    const kid = object(item, `kids[${index}]`);
    exactKeys(kid, ['id', 'displayName', 'color', 'active']);
    return {
      id: identifier(kid.id, `kids[${index}].id`),
      displayName: boundedString(kid.displayName, `kids[${index}].displayName`, 1, 100),
      color:
        kid.color === null
          ? null
          : boundedString(kid.color, `kids[${index}].color`, 1, 40),
      active: boolean(kid.active, `kids[${index}].active`),
    };
  });
  unique(kids.map((kid) => kid.id), 'kid ids');
  const kidIds = new Set(kids.map((kid) => kid.id));
  const cardRules = array(draft.cardRules, 'cardRules').map((item, index) => {
    const rule = object(item, `cardRules[${index}]`);
    exactKeys(rule, [
      'id',
      'kidId',
      'instrumentFingerprint',
      'confidence',
      'enabled',
    ]);
    const kidId = identifier(rule.kidId, `cardRules[${index}].kidId`);
    referencedKid(kidIds, kidId, `cardRules[${index}].kidId`);
    return {
      id: identifier(rule.id, `cardRules[${index}].id`),
      kidId,
      instrumentFingerprint: boundedString(
        rule.instrumentFingerprint,
        `cardRules[${index}].instrumentFingerprint`,
        8,
        256
      ),
      confidence: confidence(rule.confidence, `cardRules[${index}].confidence`),
      enabled: boolean(rule.enabled, `cardRules[${index}].enabled`),
    };
  });
  const merchantRules = array(draft.merchantRules, 'merchantRules').map(
    (item, index) => {
      const rule = object(item, `merchantRules[${index}]`);
      exactKeys(rule, ['id', 'kidId', 'pattern', 'confidence', 'enabled']);
      const kidId = identifier(rule.kidId, `merchantRules[${index}].kidId`);
      referencedKid(kidIds, kidId, `merchantRules[${index}].kidId`);
      return {
        id: identifier(rule.id, `merchantRules[${index}].id`),
        kidId,
        pattern: boundedString(
          rule.pattern,
          `merchantRules[${index}].pattern`,
          2,
          160
        ),
        confidence: confidence(
          rule.confidence,
          `merchantRules[${index}].confidence`
        ),
        enabled: boolean(rule.enabled, `merchantRules[${index}].enabled`),
      };
    }
  );
  unique(
    [...cardRules, ...merchantRules].map((rule) => rule.id),
    'attribution rule ids'
  );
  const limits = array(draft.limits, 'limits').map((item, index) => {
    const limit = object(item, `limits[${index}]`);
    exactKeys(limit, ['kidId', 'period', 'amount', 'currency']);
    const kidId = identifier(limit.kidId, `limits[${index}].kidId`);
    referencedKid(kidIds, kidId, `limits[${index}].kidId`);
    const period = enumeration(
      limit.period,
      ['daily', 'weekly', 'monthly'] as const,
      `limits[${index}].period`
    );
    const amount = finiteNumber(limit.amount, `limits[${index}].amount`);
    if (amount < 0) {
      invalid(`limits[${index}].amount must be non-negative`);
    }
    const limitCurrency = isoCurrency(
      limit.currency,
      `limits[${index}].currency`
    );
    if (limitCurrency !== currency) {
      invalid(`limits[${index}].currency must match policy currency`);
    }
    return { kidId, period, amount, currency: limitCurrency };
  });
  unique(
    limits.map((limit) => `${limit.kidId}:${limit.period}`),
    'kid limit periods'
  );
  return { timezone, currency, kids, cardRules, merchantRules, limits };
}

export function parseAttributionInputV1(value: unknown): AttributionInputV1 {
  const input = object(value, 'attribution input');
  exactKeys(input, [
    'contractVersion',
    'householdId',
    'source',
    'transaction',
    'historicalAttributions',
    'existingManualDecision',
  ]);
  literal(input.contractVersion, TYRION_DOMAIN_CONTRACT_VERSION, 'contractVersion');
  const source = object(input.source, 'source');
  exactKeys(source, ['system', 'recordRef', 'observedAt']);
  literal(source.system, 'monarch-bridge', 'source.system');
  const transaction = object(input.transaction, 'transaction');
  exactKeys(transaction, [
    'merchantName',
    'instrumentFingerprint',
    'occurredOn',
  ]);
  const historicalAttributions = array(
    input.historicalAttributions,
    'historicalAttributions'
  ).map((item, index) => {
    const historical = object(item, `historicalAttributions[${index}]`);
    exactKeys(historical, [
      'normalizedMerchant',
      'kidId',
      'assignmentCount',
    ]);
    return {
      normalizedMerchant: boundedString(
        historical.normalizedMerchant,
        `historicalAttributions[${index}].normalizedMerchant`,
        1,
        160
      ),
      kidId: identifier(
        historical.kidId,
        `historicalAttributions[${index}].kidId`
      ),
      assignmentCount: positiveInteger(
        historical.assignmentCount,
        `historicalAttributions[${index}].assignmentCount`
      ),
    };
  });
  let existingManualDecision: ManualAttributionDecisionV1 | null = null;
  if (input.existingManualDecision !== null) {
    const decision = object(input.existingManualDecision, 'existingManualDecision');
    exactKeys(decision, [
      'action',
      'kidId',
      'actorId',
      'decidedAt',
      'explanation',
    ]);
    const action = enumeration(
      decision.action,
      ['assign-kid', 'parent-expense'] as const,
      'existingManualDecision.action'
    );
    const kidId =
      decision.kidId === null
        ? null
        : identifier(decision.kidId, 'existingManualDecision.kidId');
    if (
      (action === 'assign-kid' && kidId === null) ||
      (action === 'parent-expense' && kidId !== null)
    ) {
      invalid('existingManualDecision action and kidId are inconsistent');
    }
    existingManualDecision = {
      action,
      kidId,
      actorId: identifier(decision.actorId, 'existingManualDecision.actorId'),
      decidedAt: timestamp(decision.decidedAt, 'existingManualDecision.decidedAt'),
      explanation: boundedString(
        decision.explanation,
        'existingManualDecision.explanation',
        1,
        240
      ),
    };
  }
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    householdId: identifier(input.householdId, 'householdId'),
    source: {
      system: 'monarch-bridge',
      recordRef: identifier(source.recordRef, 'source.recordRef'),
      observedAt: timestamp(source.observedAt, 'source.observedAt'),
    },
    transaction: {
      merchantName: boundedString(
        transaction.merchantName,
        'transaction.merchantName',
        1,
        160
      ),
      instrumentFingerprint:
        transaction.instrumentFingerprint === null
          ? null
          : boundedString(
              transaction.instrumentFingerprint,
              'transaction.instrumentFingerprint',
              8,
              256
            ),
      occurredOn: calendarDate(transaction.occurredOn, 'transaction.occurredOn'),
    },
    historicalAttributions,
    existingManualDecision,
  };
}

export class ContractValidationError extends Error {
  readonly code = 'invalid_domain_contract';

  constructor(message: string) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  if (value.length > 1_000) invalid(`${field} exceeds the maximum item count`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) invalid(`unexpected field: ${unexpected}`);
  const missing = keys.find((key) => !(key in value));
  if (missing) invalid(`missing field: ${missing}`);
}

function boundedString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    invalid(`${field} has an invalid length`);
  }
  return normalized;
}

function identifier(value: unknown, field: string): string {
  const result = boundedString(value, field, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    invalid(`${field} contains unsupported characters`);
  }
  if (['__proto__', 'constructor', 'prototype'].includes(result)) {
    invalid(`${field} contains a reserved value`);
  }
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = boundedString(value, field, 20, 35);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      result
    );
  if (!match) {
    invalid(`${field} must be an ISO 8601 timestamp with an offset`);
  }
  const [, year, month, day, hour, minute, second, offset] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const offsetHours = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (
    numericMonth < 1 ||
    numericMonth > 12 ||
    numericDay < 1 ||
    numericDay > daysInMonth(numericYear, numericMonth) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59 ||
    !Number.isFinite(Date.parse(result))
  ) {
    invalid(`${field} must be a valid ISO 8601 timestamp with an offset`);
  }
  return result;
}

function calendarDate(value: unknown, field: string): string {
  const result = boundedString(value, field, 10, 10);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  ) {
    invalid(`${field} must be an ISO 8601 calendar date`);
  }
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive integer`);
  }
  return value as number;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number`);
  }
  return value;
}

function ianaTimezone(value: unknown, field: string): string {
  const result = boundedString(value, field, 1, 100);
  if (!SUPPORTED_TIMEZONES.has(result) && result !== 'UTC') {
    invalid(`${field} must be a valid IANA timezone`);
  }
  return result;
}

function isoCurrency(value: unknown, field: string): string {
  const result = boundedString(value, field, 3, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(result) || !SUPPORTED_CURRENCIES.has(result)) {
    invalid(`${field} must be a supported ISO 4217 currency`);
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}

function confidence(
  value: unknown,
  field: string
): Exclude<AttributionConfidenceV1, 'none'> {
  return enumeration(value, ['definite', 'likely'] as const, field);
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

function literal<const T extends string>(
  value: unknown,
  expected: T,
  field: string
): asserts value is T {
  if (value !== expected) invalid(`${field} must be ${expected}`);
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    invalid(`${field} must be unique`);
  }
}

function referencedKid(kidIds: Set<string>, kidId: string, field: string): void {
  if (!kidIds.has(kidId)) invalid(`${field} references an unknown kid`);
}

function invalid(message: string): never {
  throw new ContractValidationError(message);
}
