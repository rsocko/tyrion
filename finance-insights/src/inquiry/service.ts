import { z } from 'zod';
import {
  FINANCE_INQUIRY_MAX_AGE_HOURS,
  FINANCE_INQUIRY_MAX_ANALYSIS_ROWS,
  FINANCE_INQUIRY_MAX_OUTPUT_BYTES,
  budgetInquiryRecordSchema,
  datasetSnapshotSchema,
  exceptionInquiryRecordSchema,
  financeToolInputSchemas,
  recurringInquiryRecordSchema,
  transactionInquiryRecordSchema,
  type DatasetSnapshot,
  type FinanceAnalyzeSpendingInput,
  type FinanceFactDerivation,
  type FinanceFreshnessState,
  type FinanceInquiryMetadata,
  type FinanceInquiryResult,
  type FinanceSearchTransactionsInput,
  type FinanceToolName,
  type TransactionInquiryRecord,
} from './contracts.js';
import { FinanceInquiryError, type FinanceInquiryErrorCode } from './errors.js';
import type {
  FinanceInquiryAuditEvent,
  FinanceInquiryAuditPort,
  FinanceInquiryContext,
  FinanceInquiryProjectionPort,
  ProjectionItem,
  ProjectionPage,
} from './ports.js';

const STATUS_DATASETS = [
  'connector',
  'transactions',
  'recurring',
  'budgets',
  'exceptions',
] as const;

const STATUS_OUTCOME: Readonly<
  Record<FinanceInquiryErrorCode, FinanceInquiryAuditEvent['outcome']>
> = Object.freeze({
  invalid_input: 'invalidInput',
  permission_denied: 'permissionDenied',
  not_found: 'notFound',
  cancelled: 'cancelled',
  timed_out: 'timedOut',
  output_bound_exceeded: 'outputBoundExceeded',
  source_unavailable: 'sourceUnavailable',
});

export interface FinanceInquiryServiceOptions {
  householdScope: string;
  projection: FinanceInquiryProjectionPort;
  audit: FinanceInquiryAuditPort;
  timeoutMs?: number;
  auditTimeoutMs?: number;
  maxOutputBytes?: number;
  clock?: () => Date;
  monotonicClock?: () => number;
}

interface OperationResult<T> {
  result: FinanceInquiryResult<T>;
  itemCount: number;
}

interface SpendingGroup {
  key: string;
  displayName: string;
  currency: string;
  totalMinor: number;
  transactionCount: number;
}

export class FinanceInquiryService {
  private readonly householdScope: string;
  private readonly projection: FinanceInquiryProjectionPort;
  private readonly audit: FinanceInquiryAuditPort;
  private readonly timeoutMs: number;
  private readonly auditTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly clock: () => Date;
  private readonly monotonicClock: () => number;

  constructor(options: FinanceInquiryServiceOptions) {
    if (options.householdScope.trim().length === 0) {
      throw new Error('householdScope is required');
    }
    this.householdScope = options.householdScope;
    this.projection = options.projection;
    this.audit = options.audit;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.auditTimeoutMs =
      options.auditTimeoutMs ?? Math.min(1_000, this.timeoutMs);
    this.maxOutputBytes =
      options.maxOutputBytes ?? FINANCE_INQUIRY_MAX_OUTPUT_BYTES;
    this.clock = options.clock ?? (() => new Date());
    this.monotonicClock = options.monotonicClock ?? (() => Date.now());
    if (this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('timeoutMs must be between 1 and 30000');
    }
    if (this.auditTimeoutMs < 1 || this.auditTimeoutMs > 5_000) {
      throw new Error('auditTimeoutMs must be between 1 and 5000');
    }
    if (
      this.maxOutputBytes < 1_024 ||
      this.maxOutputBytes > FINANCE_INQUIRY_MAX_OUTPUT_BYTES
    ) {
      throw new Error(
        `maxOutputBytes must be between 1024 and ${FINANCE_INQUIRY_MAX_OUTPUT_BYTES}`
      );
    }
  }

  async invoke(
    tool: FinanceToolName,
    input: unknown,
    context: FinanceInquiryContext
  ): Promise<FinanceInquiryResult<unknown>> {
    return this.runAudited(tool, context, async (signal) => {
      switch (tool) {
        case 'finance_get_status':
          return this.getStatus(input, signal);
        case 'finance_search_transactions':
          return this.searchTransactions(input, signal);
        case 'finance_get_transaction':
          return this.getTransaction(input, signal);
        case 'finance_analyze_spending':
          return this.analyzeSpending(input, signal);
        case 'finance_get_recurring_obligations':
          return this.getRecurring(input, signal);
        case 'finance_get_budget_status':
          return this.getBudgetStatus(input, signal);
        case 'finance_get_pending_exceptions':
          return this.getPendingExceptions(input, signal);
      }
    });
  }

  private async getStatus(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    parseInput('finance_get_status', input);
    const raw = await this.projection.getStatus(this.householdScope, signal);
    const datasets = Object.fromEntries(
      STATUS_DATASETS.map((dataset) => [
        dataset,
        snapshotView(datasetSnapshotSchema.parse(raw[dataset]), this.clock()),
      ])
    );
    const snapshots = STATUS_DATASETS.map((dataset) =>
      datasetSnapshotSchema.parse(raw[dataset])
    );
    const result = envelope(
      'finance_get_status',
      combineMetadata(snapshots, 'calculatedByMissionControl', this.clock()),
      { datasets }
    );
    return { result, itemCount: STATUS_DATASETS.length };
  }

  private async searchTransactions(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    const query = parseInput('finance_search_transactions', input);
    const page = parsePage(
      await this.projection.searchTransactions(
        this.householdScope,
        query,
        signal
      ),
      transactionInquiryRecordSchema,
      query.limit
    );
    const items = page.items.map(transactionView);
    const result = envelope(
      'finance_search_transactions',
      metadata(page.snapshot, 'viaMonarch', this.clock()),
      { items, hasMore: page.hasMore }
    );
    return { result, itemCount: items.length };
  }

  private async getTransaction(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    const query = parseInput('finance_get_transaction', input);
    const projectionItem = parseItem(
      await this.projection.getTransaction(
        this.householdScope,
        query.transactionRef,
        query.requireFresh,
        signal
      ),
      transactionInquiryRecordSchema
    );
    if (projectionItem.item === null) {
      throw new FinanceInquiryError('not_found');
    }
    const result = envelope(
      'finance_get_transaction',
      metadata(projectionItem.snapshot, 'viaMonarch', this.clock()),
      { transaction: transactionView(projectionItem.item) }
    );
    return { result, itemCount: 1 };
  }

  private async analyzeSpending(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    const query = parseInput('finance_analyze_spending', input);
    const page = parsePage(
      await this.projection.transactionsForAnalysis(
        this.householdScope,
        query,
        FINANCE_INQUIRY_MAX_ANALYSIS_ROWS,
        signal
      ),
      transactionInquiryRecordSchema,
      FINANCE_INQUIRY_MAX_ANALYSIS_ROWS
    );
    if (page.hasMore) {
      throw new FinanceInquiryError('output_bound_exceeded');
    }

    const current = analyzePeriod(
      page.items,
      query.startDate,
      query.endDate,
      query
    );
    const comparison =
      query.compareStartDate !== undefined && query.compareEndDate !== undefined
        ? analyzePeriod(
            page.items,
            query.compareStartDate,
            query.compareEndDate,
            query
          )
        : null;
    const comparisonByCurrency = new Map(
      comparison?.totals.map((total) => [total.currency, total]) ?? []
    );
    const comparisonTotals =
      comparison === null
        ? null
        : [
            ...new Set([
              ...current.totals.map((total) => total.currency),
              ...comparison.totals.map((total) => total.currency),
            ]),
          ]
            .sort()
            .map((currency) => {
              const currentTotal =
                current.totals.find((total) => total.currency === currency)
                  ?.totalMinor ?? 0;
              const previous = comparisonByCurrency.get(currency);
              const previousTotal = previous?.totalMinor ?? 0;
              const deltaMinor = currentTotal - previousTotal;
              return {
                currency,
                totalMinor: previousTotal,
                transactionCount: previous?.transactionCount ?? 0,
                deltaMinor,
                deltaBasisPoints:
                  previousTotal === 0
                    ? null
                    : Math.round((deltaMinor * 10_000) / previousTotal),
              };
            });
    const result = envelope(
      'finance_analyze_spending',
      metadata(
        page.snapshot,
        'calculatedByMissionControl',
        this.clock()
      ),
      {
        period: {
          startDate: query.startDate,
          endDate: query.endDate,
          totals: current.totals,
        },
        comparison:
          comparison === null
            ? null
            : {
                startDate: query.compareStartDate,
                endDate: query.compareEndDate,
                totals: comparisonTotals,
              },
        groupBy: query.groupBy,
        groups: contributorsPerCurrency(
          current.groups,
          query.contributorLimit
        ),
      }
    );
    return { result, itemCount: current.transactionCount };
  }

  private async getRecurring(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    const query = parseInput('finance_get_recurring_obligations', input);
    const page = parsePage(
      await this.projection.getRecurring(
        this.householdScope,
        query.activeOnly,
        query.limit,
        signal
      ),
      recurringInquiryRecordSchema,
      query.limit
    );
    const result = envelope(
      'finance_get_recurring_obligations',
      metadata(page.snapshot, 'viaMonarch', this.clock()),
      {
        items: page.items.map((item) => ({
          ...item,
          factAttribution: {
            obligation: 'viaMonarch' as const,
            materialChange:
              item.materialChange === null
                ? null
                : ('derivedByTyrion' as const),
          },
        })),
        hasMore: page.hasMore,
      }
    );
    return { result, itemCount: page.items.length };
  }

  private async getBudgetStatus(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    const query = parseInput('finance_get_budget_status', input);
    const page = parsePage(
      await this.projection.getBudgets(
        this.householdScope,
        query.period,
        query.warningsOnly,
        query.limit,
        signal
      ),
      budgetInquiryRecordSchema,
      query.limit
    );
    const result = envelope(
      'finance_get_budget_status',
      metadata(page.snapshot, 'viaMonarch', this.clock()),
      {
        items: page.items,
        hasMore: page.hasMore,
        managementSurface: 'Monarch' as const,
      }
    );
    return { result, itemCount: page.items.length };
  }

  private async getPendingExceptions(
    input: unknown,
    signal: AbortSignal
  ): Promise<OperationResult<unknown>> {
    const query = parseInput('finance_get_pending_exceptions', input);
    const page = parsePage(
      await this.projection.getPendingExceptions(
        this.householdScope,
        query.kinds,
        query.limit,
        signal
      ),
      exceptionInquiryRecordSchema,
      query.limit
    );
    const result = envelope(
      'finance_get_pending_exceptions',
      metadata(page.snapshot, 'derivedByTyrion', this.clock()),
      { items: page.items, hasMore: page.hasMore }
    );
    return { result, itemCount: page.items.length };
  }

  private async runAudited(
    tool: FinanceToolName,
    context: FinanceInquiryContext,
    operation: (signal: AbortSignal) => Promise<OperationResult<unknown>>
  ): Promise<FinanceInquiryResult<unknown>> {
    const started = this.monotonicClock();
    let completed: OperationResult<unknown>;
    try {
      this.authorize(context);
      completed = await withDeadline(
        operation,
        context.signal,
        this.timeoutMs
      );
      enforceOutputBound(completed.result, this.maxOutputBytes);
    } catch (error) {
      const safeError = normalizeError(error, context.signal);
      await this.writeAudit(
        context,
        tool,
        STATUS_OUTCOME[safeError.code],
        started,
        null
      );
      throw safeError;
    }
    await this.writeAudit(
      context,
      tool,
      'succeeded',
      started,
      completed.itemCount
    );
    return completed.result;
  }

  private authorize(context: FinanceInquiryContext): void {
    if (
      context.householdScope !== this.householdScope ||
      !context.permissions.has('finance:read')
    ) {
      throw new FinanceInquiryError('permission_denied');
    }
    if (
      !validRequestId(context.requestId)
    ) {
      throw new FinanceInquiryError('invalid_input');
    }
  }

  private async writeAudit(
    context: FinanceInquiryContext,
    tool: FinanceToolName,
    outcome: FinanceInquiryAuditEvent['outcome'],
    started: number,
    itemCount: number | null
  ): Promise<void> {
    try {
      await withDeadline(
        async (signal) =>
          this.audit.record({
            requestId: validRequestId(context.requestId)
              ? context.requestId
              : 'invalid-request',
            householdScope: this.householdScope,
            tool,
            outcome,
            occurredAt: this.clock().toISOString(),
            durationMs: Math.max(
              0,
              Math.round(this.monotonicClock() - started)
            ),
            itemCount,
          }, signal),
        undefined,
        this.auditTimeoutMs
      );
    } catch {
      throw new FinanceInquiryError('source_unavailable');
    }
  }
}

function parseInput<N extends FinanceToolName>(
  tool: N,
  input: unknown
): z.output<(typeof financeToolInputSchemas)[N]> {
  const parsed = financeToolInputSchemas[tool].safeParse(input);
  if (!parsed.success) {
    throw new FinanceInquiryError('invalid_input');
  }
  return parsed.data as z.output<(typeof financeToolInputSchemas)[N]>;
}

function parsePage<T>(
  page: ProjectionPage<T>,
  itemSchema: z.ZodType<T>,
  limit: number
): ProjectionPage<T> {
  const snapshot = datasetSnapshotSchema.safeParse(page.snapshot);
  const hasMore = z.boolean().safeParse(page.hasMore);
  const items = z.array(itemSchema).max(limit).safeParse(page.items);
  if (!snapshot.success || !hasMore.success || !items.success) {
    throw new FinanceInquiryError('source_unavailable');
  }
  return {
    snapshot: snapshot.data,
    hasMore: hasMore.data,
    items: items.data,
  };
}

function parseItem<T>(
  value: ProjectionItem<T>,
  itemSchema: z.ZodType<T>
): ProjectionItem<T> {
  const snapshot = datasetSnapshotSchema.safeParse(value.snapshot);
  const item = itemSchema.nullable().safeParse(value.item);
  if (!snapshot.success || !item.success) {
    throw new FinanceInquiryError('source_unavailable');
  }
  return { snapshot: snapshot.data, item: item.data };
}

function transactionView(item: TransactionInquiryRecord) {
  return {
    ...item,
    factAttribution: {
      transaction: 'viaMonarch' as const,
      attribution:
        item.kidRef === null ? null : ('derivedByTyrion' as const),
    },
  };
}

function analyzePeriod(
  transactions: readonly TransactionInquiryRecord[],
  startDate: string,
  endDate: string,
  query: FinanceAnalyzeSpendingInput
) {
  const groups = new Map<string, SpendingGroup>();
  let transactionCount = 0;
  const totals = new Map<
    string,
    { currency: string; totalMinor: number; transactionCount: number }
  >();
  for (const transaction of transactions) {
    if (
      transaction.occurredOn < startDate ||
      transaction.occurredOn > endDate ||
      !matchesAnalysisFilter(transaction, query)
    ) {
      continue;
    }
    const amountMinor = -transaction.amountMinor;
    if (amountMinor <= 0) {
      continue;
    }
    const grouping = groupValue(transaction, query.groupBy);
    const compoundKey = JSON.stringify([transaction.currency, grouping.key]);
    const existing = groups.get(compoundKey) ?? {
      ...grouping,
      currency: transaction.currency,
      totalMinor: 0,
      transactionCount: 0,
    };
    existing.totalMinor += amountMinor;
    existing.transactionCount += 1;
    groups.set(compoundKey, existing);
    const currencyTotal = totals.get(transaction.currency) ?? {
      currency: transaction.currency,
      totalMinor: 0,
      transactionCount: 0,
    };
    currencyTotal.totalMinor += amountMinor;
    currencyTotal.transactionCount += 1;
    totals.set(transaction.currency, currencyTotal);
    transactionCount += 1;
  }
  return {
    transactionCount,
    totals: [...totals.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency)
    ),
    groups: [...groups.values()].sort(
      (left, right) =>
        left.currency.localeCompare(right.currency) ||
        right.totalMinor - left.totalMinor ||
        left.displayName.localeCompare(right.displayName) ||
        left.key.localeCompare(right.key)
    ),
  };
}

function matchesAnalysisFilter(
  transaction: TransactionInquiryRecord,
  query: FinanceAnalyzeSpendingInput
): boolean {
  const spendClassification =
    transaction.classification === 'postedSpend' ||
    transaction.classification === 'knownRecurring' ||
    (query.includePending && transaction.classification === 'pending');
  return (
    spendClassification &&
    (query.includePending || !transaction.pending) &&
    (query.categoryRef === undefined ||
      transaction.categoryRef === query.categoryRef) &&
    (query.accountRef === undefined ||
      transaction.accountRef === query.accountRef) &&
    (query.kidRef === undefined || transaction.kidRef === query.kidRef)
  );
}

function groupValue(
  transaction: TransactionInquiryRecord,
  groupBy: FinanceAnalyzeSpendingInput['groupBy']
): { key: string; displayName: string } {
  switch (groupBy) {
    case 'merchant':
      return {
        key: transaction.merchantName.toLocaleLowerCase('en-US'),
        displayName: transaction.merchantName,
      };
    case 'category':
      return {
        key: transaction.categoryRef ?? 'uncategorized',
        displayName: transaction.categoryName ?? 'Uncategorized',
      };
    case 'account':
      return {
        key: transaction.accountRef ?? 'unknown-account',
        displayName: transaction.accountName ?? 'Unknown account',
      };
    case 'kid':
      return {
        key: transaction.kidRef ?? 'unassigned',
        displayName: transaction.kidName ?? 'Unassigned',
      };
  }

}

function contributorsPerCurrency(
  groups: readonly SpendingGroup[],
  limit: number
): readonly SpendingGroup[] {
  const counts = new Map<string, number>();
  return groups.filter((group) => {
    const count = counts.get(group.currency) ?? 0;
    if (count >= limit) {
      return false;
    }
    counts.set(group.currency, count + 1);
    return true;
  });
}

function snapshotView(snapshot: DatasetSnapshot, now: Date) {
  const view = metadata(snapshot, 'viaMonarch', now);
  return {
    asOf: view.asOf,
    coverage: view.coverage,
    freshness: view.freshness,
    warnings: view.warnings,
  };
}

function metadata(
  snapshot: DatasetSnapshot,
  derivation: FinanceFactDerivation,
  now: Date
): FinanceInquiryMetadata {
  const freshness = freshnessState(snapshot, now);
  return {
    source: 'missionControlProjection',
    derivation,
    asOf: snapshot.sourceAsOf,
    coverage: {
      start: snapshot.coverageStart,
      end: snapshot.coverageEnd,
    },
    freshness,
    warnings:
      freshness === 'fresh' ? [] : [`finance_source_${freshness}`],
  };
}

function combineMetadata(
  snapshots: readonly DatasetSnapshot[],
  derivation: FinanceFactDerivation,
  now: Date
): FinanceInquiryMetadata {
  const rank: Readonly<Record<FinanceFreshnessState, number>> = {
    fresh: 0,
    stale: 1,
    partial: 2,
    unavailable: 3,
  };
  const freshness = snapshots
    .map((snapshot) => freshnessState(snapshot, now))
    .sort((left, right) => rank[right] - rank[left])[0]!;
  const asOfValues = snapshots
    .flatMap((snapshot) =>
      snapshot.sourceAsOf === null ? [] : [snapshot.sourceAsOf]
    )
    .sort();
  const starts = snapshots
    .flatMap((snapshot) =>
      snapshot.coverageStart === null ? [] : [snapshot.coverageStart]
    )
    .sort();
  const ends = snapshots
    .flatMap((snapshot) =>
      snapshot.coverageEnd === null ? [] : [snapshot.coverageEnd]
    )
    .sort();
  return {
    source: 'missionControlProjection',
    derivation,
    asOf: asOfValues[0] ?? null,
    coverage: {
      start: starts.at(-1) ?? null,
      end: ends[0] ?? null,
    },
    freshness,
    warnings:
      freshness === 'fresh' ? [] : [`finance_source_${freshness}`],
  };
}

function freshnessState(
  snapshot: DatasetSnapshot,
  now: Date
): FinanceFreshnessState {
  if (
    snapshot.completeness === 'unavailable' ||
    snapshot.sourceAsOf === null
  ) {
    return 'unavailable';
  }
  if (snapshot.completeness === 'partial') {
    return 'partial';
  }
  const ageHours =
    (now.getTime() - Date.parse(snapshot.sourceAsOf)) / 3_600_000;
  if (ageHours < -5 / 60) {
    return 'partial';
  }
  return ageHours > FINANCE_INQUIRY_MAX_AGE_HOURS ? 'stale' : 'fresh';
}

function validRequestId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 160 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function envelope<T>(
  tool: FinanceToolName,
  resultMetadata: FinanceInquiryMetadata,
  data: T
): FinanceInquiryResult<T> {
  return { tool, metadata: resultMetadata, data };
}

function enforceOutputBound(value: unknown, maxBytes: number): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
    throw new FinanceInquiryError('output_bound_exceeded');
  }
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  if (callerSignal?.aborted) {
    throw new FinanceInquiryError('cancelled');
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;
  try {
    const cancellation =
      callerSignal === undefined
        ? null
        : new Promise<never>((_, reject) => {
            cancelListener = () => {
              reject(new FinanceInquiryError('cancelled'));
              controller.abort();
            };
            callerSignal.addEventListener('abort', cancelListener, {
              once: true,
            });
          });
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new FinanceInquiryError('timed_out'));
          controller.abort();
        }, timeoutMs);
      }),
      ...(cancellation === null ? [] : [cancellation]),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (cancelListener !== undefined) {
      callerSignal?.removeEventListener('abort', cancelListener);
    }
  }
}

function normalizeError(
  error: unknown,
  callerSignal: AbortSignal | undefined
): FinanceInquiryError {
  if (error instanceof FinanceInquiryError) {
    return error;
  }
  if (callerSignal?.aborted) {
    return new FinanceInquiryError('cancelled');
  }
  if (error instanceof z.ZodError) {
    return new FinanceInquiryError('source_unavailable');
  }
  return new FinanceInquiryError('source_unavailable');
}
