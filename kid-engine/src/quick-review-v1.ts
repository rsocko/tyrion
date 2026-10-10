export const QUICK_REVIEW_MAX_ITEMS = 100;
export const QUICK_REVIEW_CONTRACT_VERSION = '1.0' as const;

const SIGNAL_WEIGHTS = {
  'kid-attribution-ambiguous': 35,
  'payee-ambiguous': 25,
  'category-mismatch': 20,
  'unknown-merchant': 15,
  'new-merchant': 10,
  'monarch-needs-review': 40,
} as const;

type ReviewSignal = keyof typeof SIGNAL_WEIGHTS;
type AttributionStatus = 'assigned' | 'parent-expense' | 'unassigned';
type AttributionConfidence = 'definite' | 'likely' | 'unknown';
type ReviewStatus = 'none' | 'needs-review' | 'deferred';

export interface QuickReviewRankItemV1 {
  sourceRef: string;
  occurredOn: string;
  merchantName: string;
  isPending: boolean;
  monarchReviewStatus: 'needs_review' | 'reviewed';
  attribution: {
    status: AttributionStatus;
    confidence: AttributionConfidence;
    reviewStatus: ReviewStatus;
  };
  signals: ReviewSignal[];
}

export interface QuickReviewRankRequestV1 {
  contractVersion: typeof QUICK_REVIEW_CONTRACT_VERSION;
  items: QuickReviewRankItemV1[];
}

export interface QuickReviewRankResponseV1 {
  contractVersion: typeof QUICK_REVIEW_CONTRACT_VERSION;
  rankedItems: Array<{
    sourceRef: string;
    rank: number;
    score: number;
    reasons: ReviewSignal[];
  }>;
}

export interface VendorResearchRequestV1 {
  contractVersion: typeof QUICK_REVIEW_CONTRACT_VERSION;
  vendorName: string;
  coarseLocation: {
    locality: string | null;
    region: string | null;
    countryCode: string | null;
  } | null;
  sensitiveContext: {
    amount: number;
    occurredOn: string;
  } | null;
  disclosure: {
    shown: boolean;
    confirmedAt: string | null;
  };
}

export interface VendorResearchEnvelopeV1 {
  contractVersion: typeof QUICK_REVIEW_CONTRACT_VERSION;
  query: {
    vendorName: string;
    coarseLocation: VendorResearchRequestV1['coarseLocation'];
    amount: number | null;
    occurredOn: string | null;
  };
  outputPolicy: {
    factsRequireSources: true;
    inferencesMustBeLabeled: true;
    fraudAssertionAllowed: false;
  };
}

export interface MerchantRuleSuggestionRequestV1 {
  contractVersion: typeof QUICK_REVIEW_CONTRACT_VERSION;
  merchantName: string;
  businessEntityName?: string | null;
  accountRef?: string | null;
  scope?: 'global' | 'accounts';
  kidId: string;
  suggestReusableRule: boolean;
}

export interface MerchantRuleSuggestionResponseV1 {
  contractVersion: typeof QUICK_REVIEW_CONTRACT_VERSION;
  suggestion: {
    kind: 'merchant';
    outcome: 'kid';
    merchantPattern: string;
    businessEntityPattern: string | null;
    scope: 'global' | 'accounts';
    accountRefs: string[];
    kidId: string;
    confidence: 'likely';
    requiresConfirmation: true;
  } | null;
}

export class QuickReviewValidationError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'batch_too_large'
      | 'research_disclosure_required',
    message: string
  ) {
    super(message);
    this.name = 'QuickReviewValidationError';
  }
}

export function rankQuickReviewV1(value: unknown): QuickReviewRankResponseV1 {
  const request = strictObject(value, ['contractVersion', 'items']);
  contractVersion(request.contractVersion);
  if (!Array.isArray(request.items) || request.items.length < 1) {
    invalid(`items must contain between 1 and ${QUICK_REVIEW_MAX_ITEMS} entries`);
  }
  if (request.items.length > QUICK_REVIEW_MAX_ITEMS) {
    throw new QuickReviewValidationError(
      'batch_too_large',
      `Quick Review batch exceeds ${QUICK_REVIEW_MAX_ITEMS} items`
    );
  }
  const items = request.items.map(parseRankItem);
  if (new Set(items.map((item) => item.sourceRef)).size !== items.length) {
    invalid('items must have unique sourceRef values');
  }

  const ranked = items
    .map((item) => {
      const reasons = [...item.signals];
      if (
        item.monarchReviewStatus === 'needs_review' &&
        !reasons.includes('monarch-needs-review')
      ) {
        reasons.push('monarch-needs-review');
      }
      if (
        item.attribution.reviewStatus === 'needs-review' &&
        !reasons.includes('kid-attribution-ambiguous')
      ) {
        reasons.push('kid-attribution-ambiguous');
      }
      const attributionScore =
        item.attribution.status === 'unassigned'
          ? 25
          : item.attribution.confidence === 'unknown'
            ? 20
            : item.attribution.confidence === 'likely'
              ? 10
              : 0;
      const reviewScore =
        item.attribution.reviewStatus === 'needs-review'
          ? 30
          : item.attribution.reviewStatus === 'deferred'
            ? -15
            : 0;
      const signalScore = reasons.reduce(
        (total, reason) => total + SIGNAL_WEIGHTS[reason],
        0
      );
      return {
        sourceRef: item.sourceRef,
        occurredOn: item.occurredOn,
        score: Math.max(
          0,
          Math.min(
            100,
            attributionScore + reviewScore + signalScore - (item.isPending ? 20 : 0)
          )
        ),
        reasons: [...new Set(reasons)].sort(),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.occurredOn.localeCompare(left.occurredOn) ||
        left.sourceRef.localeCompare(right.sourceRef)
    );

  return {
    contractVersion: QUICK_REVIEW_CONTRACT_VERSION,
    rankedItems: ranked.map(({ sourceRef, score, reasons }, index) => ({
      sourceRef,
      rank: index + 1,
      score,
      reasons,
    })),
  };
}

export function prepareVendorResearchV1(
  value: unknown
): VendorResearchEnvelopeV1 {
  const request = strictObject(value, [
    'contractVersion',
    'vendorName',
    'coarseLocation',
    'sensitiveContext',
    'disclosure',
  ]);
  contractVersion(request.contractVersion);
  const vendorName = normalizedText(request.vendorName, 'vendorName', 120);
  const coarseLocation =
    request.coarseLocation === null
      ? null
      : parseCoarseLocation(request.coarseLocation);
  const disclosure = strictObject(request.disclosure, ['shown', 'confirmedAt']);
  if (typeof disclosure.shown !== 'boolean') invalid('disclosure.shown is invalid');
  const confirmedAt =
    disclosure.confirmedAt === null
      ? null
      : timestamp(disclosure.confirmedAt, 'disclosure.confirmedAt');

  let amount: number | null = null;
  let occurredOn: string | null = null;
  if (request.sensitiveContext !== null) {
    if (!disclosure.shown || confirmedAt === null) {
      throw new QuickReviewValidationError(
        'research_disclosure_required',
        'Visible confirmation is required before sharing amount or date'
      );
    }
    const context = strictObject(request.sensitiveContext, [
      'amount',
      'occurredOn',
    ]);
    if (
      typeof context.amount !== 'number' ||
      !Number.isFinite(context.amount) ||
      Math.abs(context.amount) > 999_999_999.99
    ) {
      invalid('sensitiveContext.amount is invalid');
    }
    amount = Math.round(context.amount * 100) / 100;
    occurredOn = calendarDate(context.occurredOn, 'sensitiveContext.occurredOn');
  }

  return {
    contractVersion: QUICK_REVIEW_CONTRACT_VERSION,
    query: { vendorName, coarseLocation, amount, occurredOn },
    outputPolicy: {
      factsRequireSources: true,
      inferencesMustBeLabeled: true,
      fraudAssertionAllowed: false,
    },
  };
}

export function suggestMerchantRuleV1(
  value: unknown
): MerchantRuleSuggestionResponseV1 {
  const request = objectWithOptionalKeys(
    value,
    ['contractVersion', 'merchantName', 'kidId', 'suggestReusableRule'],
    ['businessEntityName', 'accountRef', 'scope']
  );
  contractVersion(request.contractVersion);
  const merchantName = normalizedText(request.merchantName, 'merchantName', 120);
  const businessEntityName =
    request.businessEntityName === undefined ||
    request.businessEntityName === null
      ? null
      : normalizedText(
          request.businessEntityName,
          'businessEntityName',
          160
        );
  const scope =
    request.scope === 'accounts' ? 'accounts' : 'global';
  if (
    request.scope !== undefined &&
    request.scope !== 'global' &&
    request.scope !== 'accounts'
  ) {
    invalid('scope is invalid');
  }
  const accountRef =
    request.accountRef === undefined || request.accountRef === null
      ? null
      : opaqueIdentifier(request.accountRef, 'accountRef');
  if (
    (scope === 'accounts' && accountRef === null) ||
    (scope === 'global' && accountRef !== null)
  ) {
    invalid('accountRef is inconsistent with scope');
  }
  const kidId = opaqueIdentifier(request.kidId, 'kidId');
  if (typeof request.suggestReusableRule !== 'boolean') {
    invalid('suggestReusableRule is invalid');
  }
  return {
    contractVersion: QUICK_REVIEW_CONTRACT_VERSION,
    suggestion: request.suggestReusableRule
      ? {
          kind: 'merchant',
          outcome: 'kid',
          merchantPattern: merchantName.toLocaleUpperCase('en-US'),
          businessEntityPattern: businessEntityName
            ? businessEntityName.toLocaleUpperCase('en-US')
            : null,
          scope,
          accountRefs: accountRef ? [accountRef] : [],
          kidId,
          confidence: 'likely',
          requiresConfirmation: true,
        }
      : null,
  };
}

function parseRankItem(value: unknown): QuickReviewRankItemV1 {
  const item = strictObject(value, [
    'sourceRef',
    'occurredOn',
    'merchantName',
    'isPending',
    'monarchReviewStatus',
    'attribution',
    'signals',
  ]);
  const attribution = strictObject(item.attribution, [
    'status',
    'confidence',
    'reviewStatus',
  ]);
  const status = enumeration(
    attribution.status,
    ['assigned', 'parent-expense', 'unassigned'] as const,
    'attribution.status'
  );
  const confidence = enumeration(
    attribution.confidence,
    ['definite', 'likely', 'unknown'] as const,
    'attribution.confidence'
  );
  const reviewStatus = enumeration(
    attribution.reviewStatus,
    ['none', 'needs-review', 'deferred'] as const,
    'attribution.reviewStatus'
  );
  if (typeof item.isPending !== 'boolean') invalid('isPending is invalid');
  const monarchReviewStatus = enumeration(
    item.monarchReviewStatus,
    ['needs_review', 'reviewed'] as const,
    'monarchReviewStatus'
  );
  if (!Array.isArray(item.signals) || item.signals.length > 5) {
    invalid('signals is invalid');
  }
  const signals = item.signals.map((signal) =>
    enumeration(
      signal,
      [
        'kid-attribution-ambiguous',
        'payee-ambiguous',
        'category-mismatch',
        'unknown-merchant',
        'new-merchant',
        'monarch-needs-review',
      ] as const,
      'signals'
    )
  );
  if (new Set(signals).size !== signals.length) invalid('signals must be unique');
  return {
    sourceRef: opaqueIdentifier(item.sourceRef, 'sourceRef'),
    occurredOn: calendarDate(item.occurredOn, 'occurredOn'),
    merchantName: normalizedText(item.merchantName, 'merchantName', 120),
    isPending: item.isPending,
    monarchReviewStatus,
    attribution: { status, confidence, reviewStatus },
    signals,
  };
}

function parseCoarseLocation(
  value: unknown
): NonNullable<VendorResearchRequestV1['coarseLocation']> {
  const location = strictObject(value, ['locality', 'region', 'countryCode']);
  const locality =
    location.locality === null
      ? null
      : normalizedText(location.locality, 'coarseLocation.locality', 80);
  const region =
    location.region === null
      ? null
      : normalizedText(location.region, 'coarseLocation.region', 80);
  let countryCode: string | null = null;
  if (location.countryCode !== null) {
    if (
      typeof location.countryCode !== 'string' ||
      !/^[A-Za-z]{2}$/.test(location.countryCode)
    ) {
      invalid('coarseLocation.countryCode is invalid');
    }
    countryCode = location.countryCode.toUpperCase();
  }
  return { locality, region, countryCode };
}

function contractVersion(value: unknown): void {
  if (value !== QUICK_REVIEW_CONTRACT_VERSION) {
    invalid('contractVersion is unsupported');
  }
}

function normalizedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') invalid(`${name} is invalid`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    invalid(`${name} is invalid`);
  }
  return normalized;
}

function opaqueIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function calendarDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid(`${name} is invalid`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') invalid(`${name} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !value.includes('T')) {
    invalid(`${name} is invalid`);
  }
  return parsed.toISOString();
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  accepted: T,
  name: string
): T[number] {
  if (typeof value !== 'string' || !accepted.includes(value)) {
    invalid(`${name} is invalid`);
  }
  return value as T[number];
}

function strictObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  const objectValue = plainObject(value);
  const actualKeys = Object.keys(objectValue);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    invalid('request fields are invalid');
  }
  return objectValue;
}

function objectWithOptionalKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[]
): Record<string, unknown> {
  const objectValue = plainObject(value);
  const actualKeys = Object.keys(objectValue);
  if (
    requiredKeys.some((key) => !Object.hasOwn(objectValue, key)) ||
    actualKeys.some(
      (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key)
    )
  ) {
    invalid('request fields are invalid');
  }
  return objectValue;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid('request must be an object');
  }
  return value as Record<string, unknown>;
}

function invalid(message: string): never {
  throw new QuickReviewValidationError('invalid_request', message);
}
