import type {
  BudgetInquiryRecord,
  DatasetSnapshot,
  ExceptionInquiryRecord,
  FinanceAnalyzeSpendingInput,
  FinanceSearchTransactionsInput,
  FinanceToolName,
  RecurringInquiryRecord,
  TransactionInquiryRecord,
} from './contracts.js';

export type FinanceInquiryDataset =
  | 'connector'
  | 'transactions'
  | 'recurring'
  | 'budgets'
  | 'exceptions';

export interface ProjectionPage<T> {
  snapshot: DatasetSnapshot;
  items: readonly T[];
  hasMore: boolean;
}

export interface ProjectionItem<T> {
  snapshot: DatasetSnapshot;
  item: T | null;
}

export interface FinanceInquiryProjectionPort {
  getStatus(
    householdScope: string,
    signal: AbortSignal
  ): Promise<Readonly<Record<FinanceInquiryDataset, DatasetSnapshot>>>;
  searchTransactions(
    householdScope: string,
    query: FinanceSearchTransactionsInput,
    signal: AbortSignal
  ): Promise<ProjectionPage<TransactionInquiryRecord>>;
  getTransaction(
    householdScope: string,
    transactionRef: string,
    requireFresh: boolean,
    signal: AbortSignal
  ): Promise<ProjectionItem<TransactionInquiryRecord>>;
  transactionsForAnalysis(
    householdScope: string,
    query: FinanceAnalyzeSpendingInput,
    rowLimit: number,
    signal: AbortSignal
  ): Promise<ProjectionPage<TransactionInquiryRecord>>;
  getRecurring(
    householdScope: string,
    activeOnly: boolean,
    limit: number,
    signal: AbortSignal
  ): Promise<ProjectionPage<RecurringInquiryRecord>>;
  getBudgets(
    householdScope: string,
    period: string | undefined,
    warningsOnly: boolean,
    limit: number,
    signal: AbortSignal
  ): Promise<ProjectionPage<BudgetInquiryRecord>>;
  getPendingExceptions(
    householdScope: string,
    kinds: readonly ExceptionInquiryRecord['kind'][] | undefined,
    limit: number,
    signal: AbortSignal
  ): Promise<ProjectionPage<ExceptionInquiryRecord>>;
}

export interface FinanceInquiryAuditEvent {
  requestId: string;
  householdScope: string;
  tool: FinanceToolName;
  outcome:
    | 'succeeded'
    | 'invalidInput'
    | 'permissionDenied'
    | 'notFound'
    | 'cancelled'
    | 'timedOut'
    | 'outputBoundExceeded'
    | 'sourceUnavailable';
  occurredAt: string;
  durationMs: number;
  itemCount: number | null;
}

export interface FinanceInquiryAuditPort {
  record(
    event: FinanceInquiryAuditEvent,
    signal: AbortSignal
  ): Promise<void>;
}

export interface FinanceInquiryContext {
  requestId: string;
  householdScope: string;
  permissions: ReadonlySet<'finance:read'>;
  signal?: AbortSignal;
}
