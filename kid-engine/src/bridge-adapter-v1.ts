import {
  ContractValidationError,
  TYRION_DOMAIN_CONTRACT_VERSION,
  parseAttributionInputV1,
  parseTimestampV1,
  type AttributionInputV1,
  type HistoricalAttributionV1,
  type ManualAttributionDecisionV1,
} from './contracts/v1.js';

export interface NormalizedBridgeTransactionV1 {
  id: string;
  date: string;
  amount: number;
  merchant: { name: string; logoUrl: string | null };
  category: { id: string; name: string } | null;
  account: { id: string; displayName: string; mask: string | null };
  isPending: boolean;
  isRecurring: boolean;
  notes: string | null;
  tags: string[];
}

export interface NormalizedBridgeTransactionsPageV1 {
  contractVersion: '1.0';
  provenance: {
    provider: 'demo' | 'live';
    fetchedAt: string;
  };
  transactions: NormalizedBridgeTransactionV1[];
  total: number;
  page: {
    limit: number;
    nextCursor: string | null;
  };
}

export interface AttributionInputAdapterContextV1 {
  householdId: string;
  sourceRef: string;
  observedAt: string;
  accountRef: string;
  historicalAttributions: HistoricalAttributionV1[];
  existingManualDecision: ManualAttributionDecisionV1 | null;
}

export type AttributionPageRecordContextV1 = Omit<
  AttributionInputAdapterContextV1,
  'householdId' | 'observedAt'
>;

export function createAttributionInputFromBridgeTransactionV1(
  transactionValue: unknown,
  context: AttributionInputAdapterContextV1
): AttributionInputV1 {
  const transaction = parseNormalizedBridgeTransactionV1(transactionValue);
  const parsedContext = object(context, 'adapter context');
  exactKeys(parsedContext, [
    'householdId',
    'sourceRef',
    'observedAt',
    'accountRef',
    'historicalAttributions',
    'existingManualDecision',
  ]);
  return buildAttributionInput(transaction, parsedContext);
}

export function createAttributionInputsFromBridgePageV1(
  pageValue: unknown,
  householdId: string,
  recordContexts: AttributionPageRecordContextV1[]
): AttributionInputV1[] {
  const page = parseNormalizedBridgeTransactionsPageV1(pageValue);
  if (!Array.isArray(recordContexts) || recordContexts.length > 5_000) {
    invalid('recordContexts must be an array with at most 5000 items');
  }
  if (recordContexts.length !== page.transactions.length) {
    invalid('recordContexts must contain one item per bridge transaction');
  }
  const sourceRefs = new Set<string>();
  return page.transactions.map((transaction, index) => {
    const context = object(recordContexts[index], `recordContexts[${index}]`);
    exactKeys(context, [
      'sourceRef',
      'accountRef',
      'historicalAttributions',
      'existingManualDecision',
    ]);
    const input = buildAttributionInput(transaction, {
      householdId,
      sourceRef: context.sourceRef,
      observedAt: page.provenance.fetchedAt,
      accountRef: context.accountRef,
      historicalAttributions: context.historicalAttributions,
      existingManualDecision: context.existingManualDecision,
    });
    if (sourceRefs.has(input.source.recordRef)) {
      invalid('recordContexts sourceRef values must be unique');
    }
    sourceRefs.add(input.source.recordRef);
    return input;
  });
}

function buildAttributionInput(
  transaction: NormalizedBridgeTransactionV1,
  context: Record<string, unknown>
): AttributionInputV1 {
  return parseAttributionInputV1({
    contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
    householdId: context.householdId,
    source: {
      system: 'monarch-bridge',
      recordRef: context.sourceRef,
      observedAt: context.observedAt,
    },
    transaction: {
      merchantName: transaction.merchant.name,
      accountRef: context.accountRef,
      occurredOn: transaction.date,
    },
    historicalAttributions: context.historicalAttributions,
    existingManualDecision: context.existingManualDecision,
  });
}

export function parseNormalizedBridgeTransactionV1(
  value: unknown
): NormalizedBridgeTransactionV1 {
  const transaction = object(value, 'bridge transaction');
  const merchant = object(transaction.merchant, 'merchant');
  const account = object(transaction.account, 'account');
  let category: NormalizedBridgeTransactionV1['category'] = null;
  if (transaction.category !== null) {
    const categoryValue = object(transaction.category, 'category');
    category = {
      id: string(categoryValue.id, 'category.id', 1, 256),
      name: string(categoryValue.name, 'category.name', 1, 160),
    };
  }
  if (typeof transaction.amount !== 'number' || !Number.isFinite(transaction.amount)) {
    invalid('amount must be a finite number');
  }
  if (!Array.isArray(transaction.tags) || transaction.tags.length > 1_000) {
    invalid('tags must be a bounded array');
  }
  return {
    id: string(transaction.id, 'id', 1, 256),
    date: calendarDate(transaction.date, 'date'),
    amount: transaction.amount,
    merchant: {
      name: string(merchant.name, 'merchant.name', 1, 160),
      logoUrl:
        merchant.logoUrl === null
          ? null
          : string(merchant.logoUrl, 'merchant.logoUrl', 1, 2_000),
    },
    category,
    account: {
      id: string(account.id, 'account.id', 1, 256),
      displayName: string(account.displayName, 'account.displayName', 1, 160),
      mask:
        account.mask === null
          ? null
          : string(account.mask, 'account.mask', 1, 32),
    },
    isPending: boolean(transaction.isPending, 'isPending'),
    isRecurring: boolean(transaction.isRecurring, 'isRecurring'),
    notes:
      transaction.notes === null
        ? null
        : string(transaction.notes, 'notes', 0, 10_000),
    tags: transaction.tags.map((tag, index) =>
      string(tag, `tags[${index}]`, 1, 100)
    ),
  };
}

export function parseNormalizedBridgeTransactionsPageV1(
  value: unknown
): NormalizedBridgeTransactionsPageV1 {
  const response = object(value, 'bridge transactions response');
  if (response.contractVersion !== '1.0') {
    invalid('contractVersion must be 1.0');
  }
  const provenance = object(response.provenance, 'provenance');
  if (provenance.provider !== 'demo' && provenance.provider !== 'live') {
    invalid('provenance.provider must be demo or live');
  }
  const fetchedAt = parseTimestampV1(provenance.fetchedAt, 'provenance.fetchedAt');
  if (
    !Array.isArray(response.transactions) ||
    response.transactions.length > 5_000
  ) {
    invalid('transactions must be an array with at most 5000 items');
  }
  if (
    !Number.isSafeInteger(response.total) ||
    (response.total as number) < 0
  ) {
    invalid('total must be a non-negative integer');
  }
  const page = object(response.page, 'page');
  if (
    !Number.isSafeInteger(page.limit) ||
    (page.limit as number) < 1 ||
    (page.limit as number) > 5_000
  ) {
    invalid('page.limit must be between 1 and 5000');
  }
  return {
    contractVersion: '1.0',
    provenance: { provider: provenance.provider, fetchedAt },
    transactions: response.transactions.map(parseNormalizedBridgeTransactionV1),
    total: response.total as number,
    page: {
      limit: page.limit as number,
      nextCursor:
        page.nextCursor === null
          ? null
          : string(page.nextCursor, 'page.nextCursor', 1, 2_000),
    },
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) invalid(`unexpected field: ${unexpected}`);
  const missing = keys.find((key) => !(key in value));
  if (missing) invalid(`missing field: ${missing}`);
}

function string(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  if (value.length < minimum || value.length > maximum) {
    invalid(`${field} has an invalid length`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}

function calendarDate(value: unknown, field: string): string {
  const result = string(value, field, 10, 10);
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

function invalid(message: string): never {
  throw new ContractValidationError(message);
}
