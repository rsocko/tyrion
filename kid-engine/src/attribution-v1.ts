import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  parseAttributionInputV1,
  parsePolicySnapshotV1,
  parseTimestampV1,
  type AttributionConfidenceV1,
  type AttributionInputV1,
  type AttributionResultV1,
  type AttributionReviewReasonV1,
  type PolicySnapshotV1,
} from './contracts/v1.js';

export interface AttributionEvaluationOptionsV1 {
  evaluatedAt: string;
  minimumHistoricalAssignments?: number;
}

interface RuleCandidate {
  kidId: string;
  confidence: Exclude<AttributionConfidenceV1, 'none'>;
  ruleId: string;
}

export function attributeTransactionV1(
  inputValue: AttributionInputV1,
  policyValue: PolicySnapshotV1,
  options: AttributionEvaluationOptionsV1
): AttributionResultV1 {
  const input = parseAttributionInputV1(inputValue);
  const policy = parsePolicySnapshotV1(policyValue);
  const evaluatedAt = requireTimestamp(options.evaluatedAt);
  if (input.householdId !== policy.householdId) {
    throw new AttributionEvaluationError(
      'household_mismatch',
      'Attribution input and policy belong to different households'
    );
  }
  if (input.existingManualDecision) {
    return manualResult(input, policy, evaluatedAt);
  }

  const activeKidIds = new Set(
    policy.kids.filter((kid) => kid.active).map((kid) => kid.id)
  );
  const cardCandidates =
    input.transaction.instrumentFingerprint === null
      ? []
      : policy.cardRules
          .filter(
            (rule) =>
              rule.enabled &&
              activeKidIds.has(rule.kidId) &&
              rule.instrumentFingerprint === input.transaction.instrumentFingerprint
          )
          .map(toCandidate);
  const cardResult = evaluateCandidates(
    input,
    policy,
    evaluatedAt,
    cardCandidates,
    'card-rule',
    'card-rule-conflict'
  );
  if (cardResult) return cardResult;

  const normalizedMerchant = normalizeMerchant(input.transaction.merchantName);
  const merchantCandidates = policy.merchantRules
    .filter(
      (rule) =>
        rule.enabled &&
        activeKidIds.has(rule.kidId) &&
        normalizedMerchant.includes(normalizeMerchant(rule.pattern))
    )
    .map(toCandidate);
  const merchantResult = evaluateCandidates(
    input,
    policy,
    evaluatedAt,
    merchantCandidates,
    'merchant-rule',
    'merchant-rule-conflict'
  );
  if (merchantResult) return merchantResult;

  const minimum = options.minimumHistoricalAssignments ?? 3;
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new AttributionEvaluationError(
      'invalid_options',
      'minimumHistoricalAssignments must be a positive integer'
    );
  }
  const history = input.historicalAttributions
    .filter(
      (entry) =>
        activeKidIds.has(entry.kidId) &&
        normalizeMerchant(entry.normalizedMerchant) === normalizedMerchant &&
        entry.assignmentCount >= minimum
    )
    .sort(
      (left, right) =>
        right.assignmentCount - left.assignmentCount ||
        left.kidId.localeCompare(right.kidId)
    );
  if (history.length > 0) {
    const tied = history.filter(
      (entry) => entry.assignmentCount === history[0].assignmentCount
    );
    if (new Set(tied.map((entry) => entry.kidId)).size > 1) {
      return pendingResult(
        input,
        policy,
        evaluatedAt,
        'historical-attribution-tie',
        'Historical decisions are tied across multiple kids.'
      );
    }
    return automatedResult(
      input,
      policy,
      evaluatedAt,
      history[0].kidId,
      'likely',
      'historical-pattern',
      [],
      'Historical decisions suggest this kid.',
      ['low-confidence']
    );
  }

  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: input.source.recordRef,
    status: 'unassigned',
    kidId: null,
    confidence: 'none',
    method: 'unassigned',
    explanation: 'No attribution rule or established historical pattern matched.',
    review: { status: 'pending', reasons: ['no-match'] },
    provenance: provenance(policy.policyVersion, evaluatedAt, 'automated', []),
  };
}

export function createUnavailableAttributionResultV1(
  inputValue: AttributionInputV1,
  reason: Extract<
    AttributionReviewReasonV1,
    'engine-unavailable' | 'policy-unavailable' | 'policy-version-mismatch'
  >,
  evaluatedAtValue: string,
  policyVersion: number | null = null
): AttributionResultV1 {
  const input = parseAttributionInputV1(inputValue);
  const evaluatedAt = requireTimestamp(evaluatedAtValue);
  if (input.existingManualDecision) {
    return {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      sourceRef: input.source.recordRef,
      status:
        input.existingManualDecision.action === 'assign-kid'
          ? 'attributed'
          : 'unassigned',
      kidId: input.existingManualDecision.kidId,
      confidence: 'definite',
      method: 'manual',
      explanation: input.existingManualDecision.explanation,
      review: { status: 'resolved', reasons: [] },
      provenance: provenance(policyVersion, evaluatedAt, 'manual', []),
    };
  }
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: input.source.recordRef,
    status: 'pending',
    kidId: null,
    confidence: 'none',
    method: 'unavailable',
    explanation:
      'Attribution is pending; transaction synchronization completed without an attribution decision.',
    review: { status: 'pending', reasons: [reason] },
    provenance: provenance(policyVersion, evaluatedAt, 'fallback', []),
  };
}

export class AttributionEvaluationError extends Error {
  constructor(
    readonly code: 'household_mismatch' | 'invalid_options',
    message: string
  ) {
    super(message);
    this.name = 'AttributionEvaluationError';
  }
}

function manualResult(
  input: AttributionInputV1,
  policy: PolicySnapshotV1,
  evaluatedAt: string
): AttributionResultV1 {
  const decision = input.existingManualDecision!;
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: input.source.recordRef,
    status: decision.action === 'assign-kid' ? 'attributed' : 'unassigned',
    kidId: decision.kidId,
    confidence: 'definite',
    method: 'manual',
    explanation: decision.explanation,
    review: { status: 'resolved', reasons: [] },
    provenance: provenance(policy.policyVersion, evaluatedAt, 'manual', []),
  };
}

function evaluateCandidates(
  input: AttributionInputV1,
  policy: PolicySnapshotV1,
  evaluatedAt: string,
  candidates: RuleCandidate[],
  method: 'card-rule' | 'merchant-rule',
  conflictReason: 'card-rule-conflict' | 'merchant-rule-conflict'
): AttributionResultV1 | null {
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort(
    (left, right) =>
      left.kidId.localeCompare(right.kidId) ||
      left.ruleId.localeCompare(right.ruleId)
  );
  if (new Set(ordered.map((candidate) => candidate.kidId)).size > 1) {
    return pendingResult(
      input,
      policy,
      evaluatedAt,
      conflictReason,
      'Multiple attribution rules assign this transaction to different kids.',
      ordered.map((candidate) => candidate.ruleId)
    );
  }
  const confidence = ordered.some(
    (candidate) => candidate.confidence === 'definite'
  )
    ? 'definite'
    : 'likely';
  const reviewReasons: AttributionReviewReasonV1[] =
    confidence === 'likely' ? ['low-confidence'] : [];
  return automatedResult(
    input,
    policy,
    evaluatedAt,
    ordered[0].kidId,
    confidence,
    method,
    ordered.map((candidate) => candidate.ruleId),
    method === 'card-rule'
      ? 'A configured payment instrument rule matched.'
      : 'A configured merchant rule matched.',
    reviewReasons
  );
}

function automatedResult(
  input: AttributionInputV1,
  policy: PolicySnapshotV1,
  evaluatedAt: string,
  kidId: string,
  confidence: Exclude<AttributionConfidenceV1, 'none'>,
  method: 'card-rule' | 'merchant-rule' | 'historical-pattern',
  ruleIds: string[],
  explanation: string,
  reasons: AttributionReviewReasonV1[]
): AttributionResultV1 {
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: input.source.recordRef,
    status: reasons.length === 0 ? 'attributed' : 'pending',
    kidId,
    confidence,
    method,
    explanation,
    review: {
      status: reasons.length === 0 ? 'not-required' : 'pending',
      reasons,
    },
    provenance: provenance(policy.policyVersion, evaluatedAt, 'automated', ruleIds),
  };
}

function pendingResult(
  input: AttributionInputV1,
  policy: PolicySnapshotV1,
  evaluatedAt: string,
  reason: AttributionReviewReasonV1,
  explanation: string,
  ruleIds: string[] = []
): AttributionResultV1 {
  return {
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    sourceRef: input.source.recordRef,
    status: 'pending',
    kidId: null,
    confidence: 'none',
    method: 'unassigned',
    explanation,
    review: { status: 'pending', reasons: [reason] },
    provenance: provenance(policy.policyVersion, evaluatedAt, 'automated', ruleIds),
  };
}

function provenance(
  policyVersion: number | null,
  evaluatedAt: string,
  decisionSource: 'manual' | 'automated' | 'fallback',
  ruleIds: string[]
): AttributionResultV1['provenance'] {
  return {
    decisionSource,
    policyVersion,
    engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
    ruleIds: [...ruleIds].sort(),
    evaluatedAt,
  };
}

function toCandidate(
  rule: PolicySnapshotV1['cardRules'][number] | PolicySnapshotV1['merchantRules'][number]
): RuleCandidate {
  return {
    kidId: rule.kidId,
    confidence: rule.confidence,
    ruleId: rule.id,
  };
}

function normalizeMerchant(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-US');
}

function requireTimestamp(value: string): string {
  try {
    return parseTimestampV1(value, 'evaluatedAt');
  } catch {
    throw new AttributionEvaluationError(
      'invalid_options',
      'evaluatedAt must be an ISO 8601 timestamp with an offset'
    );
  }
}
