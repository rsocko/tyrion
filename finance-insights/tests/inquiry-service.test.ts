import { describe, expect, it, vi } from 'vitest';
import {
  FINANCE_INQUIRY_TOOL_DEFINITIONS,
  FinanceInquiryError,
  FinanceInquiryService,
  financeSearchTransactionsInputSchema,
  type DatasetSnapshot,
  type FinanceInquiryAuditEvent,
  type FinanceInquiryAuditPort,
  type FinanceInquiryContext,
  type FinanceInquiryProjectionPort,
  type TransactionInquiryRecord,
} from '../src/inquiry/index.js';

const NOW = new Date('2026-08-11T18:00:00.000Z');
const FRESH: DatasetSnapshot = {
  sourceAsOf: '2026-08-11T17:00:00.000Z',
  coverageStart: '2026-01-01',
  coverageEnd: '2026-08-11',
  completeness: 'complete',
};
const CONTEXT: FinanceInquiryContext = {
  requestId: 'request-1',
  householdScope: 'household-1',
  permissions: new Set(['finance:read']),
};

function transaction(
  overrides: Partial<TransactionInquiryRecord> = {}
): TransactionInquiryRecord {
  return {
    transactionRef: 'transaction-1',
    occurredOn: '2026-08-10',
    amountMinor: -2_500,
    currency: 'USD',
    merchantName: 'Invented Market',
    categoryRef: 'category-groceries',
    categoryName: 'Groceries',
    accountRef: 'account-card',
    accountName: 'Household card',
    pending: false,
    recurring: false,
    classification: 'postedSpend',
    reviewState: 'none',
    kidRef: 'kid-synthetic',
    kidName: 'Example Kid',
    attributionExplanation: 'Matched the configured synthetic card rule.',
    ...overrides,
  };
}

function projection(
  overrides: Partial<FinanceInquiryProjectionPort> = {}
): FinanceInquiryProjectionPort {
  return {
    getStatus: vi.fn(async () => ({
      connector: FRESH,
      transactions: FRESH,
      recurring: FRESH,
      budgets: FRESH,
      exceptions: FRESH,
    })),
    searchTransactions: vi.fn(async () => ({
      snapshot: FRESH,
      items: [transaction()],
      hasMore: false,
    })),
    getTransaction: vi.fn(async () => ({
      snapshot: FRESH,
      item: transaction(),
    })),
    transactionsForAnalysis: vi.fn(async () => ({
      snapshot: FRESH,
      items: [
        transaction(),
        transaction({
          transactionRef: 'transaction-2',
          amountMinor: -1_000,
          merchantName: 'Invented Fuel',
          categoryRef: 'category-transport',
          categoryName: 'Transport',
          kidRef: null,
          kidName: null,
          attributionExplanation: null,
        }),
        transaction({
          transactionRef: 'transaction-credit',
          amountMinor: 900,
          classification: 'refund',
        }),
        transaction({
          transactionRef: 'transaction-previous',
          occurredOn: '2026-07-10',
          amountMinor: -2_000,
        }),
      ],
      hasMore: false,
    })),
    getRecurring: vi.fn(async () => ({
      snapshot: FRESH,
      items: [
        {
          recurringRef: 'recurring-1',
          displayName: 'Invented Internet',
          amountMinor: -7_500,
          currency: 'USD',
          cadence: 'monthly',
          nextDate: '2026-08-20',
          active: true,
          materialChange: 'The normalized amount increased.',
        },
      ],
      hasMore: false,
    })),
    getBudgets: vi.fn(async () => ({
      snapshot: FRESH,
      items: [
        {
          budgetRef: 'budget-1',
          period: '2026-08',
          categoryName: 'Groceries',
          budgetedMinor: 50_000,
          spentMinor: 42_000,
          remainingMinor: 8_000,
          currency: 'USD',
          status: 'warning',
        },
      ],
      hasMore: false,
    })),
    getPendingExceptions: vi.fn(async () => ({
      snapshot: FRESH,
      items: [
        {
          exceptionRef: 'exception-1',
          kind: 'attribution',
          title: 'Review household attribution',
          summary: 'A synthetic transaction did not match a configured rule.',
          occurredAt: '2026-08-11T16:00:00.000Z',
          severity: 'medium',
          actionable: true,
        },
      ],
      hasMore: false,
    })),
    ...overrides,
  };
}

function harness(
  projectionOverrides: Partial<FinanceInquiryProjectionPort> = {},
  options: {
    timeoutMs?: number;
    auditTimeoutMs?: number;
    maxOutputBytes?: number;
  } = {}
) {
  const events: FinanceInquiryAuditEvent[] = [];
  const audit: FinanceInquiryAuditPort = {
    record: vi.fn(async (event) => {
      events.push(event);
    }),
  };
  const source = projection(projectionOverrides);
  const service = new FinanceInquiryService({
    householdScope: 'household-1',
    projection: source,
    audit,
    clock: () => NOW,
    monotonicClock: () => 10,
    ...options,
  });
  return { service, source, audit, events };
}

describe('Houston finance inquiry contracts', () => {
  it('registers exactly the reviewed read-only tool set', () => {
    expect(FINANCE_INQUIRY_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'finance_get_status',
      'finance_search_transactions',
      'finance_get_transaction',
      'finance_analyze_spending',
      'finance_get_recurring_obligations',
      'finance_get_budget_status',
      'finance_get_pending_exceptions',
    ]);
    expect(
      FINANCE_INQUIRY_TOOL_DEFINITIONS.every((tool) => tool.readOnly)
    ).toBe(true);
    expect(
      FINANCE_INQUIRY_TOOL_DEFINITIONS.every(
        (tool) => tool.inputSchema.safeParse({}).success || tool.inputKeys.length > 0
      )
    ).toBe(true);
  });

  it('rejects unknown fields and invalid bounds', () => {
    expect(
      financeSearchTransactionsInputSchema.safeParse({ notes: true }).success
    ).toBe(false);
    expect(
      financeSearchTransactionsInputSchema.safeParse({
        startDate: '2025-01-01',
        endDate: '2026-08-11',
      }).success
    ).toBe(false);
    expect(
      financeSearchTransactionsInputSchema.safeParse({
        amountMinorMin: 10,
        amountMinorMax: 5,
      }).success
    ).toBe(false);
    expect(
      financeSearchTransactionsInputSchema.safeParse({
        startDate: '2026-02-31',
      }).success
    ).toBe(false);
  });
});

describe('FinanceInquiryService', () => {
  it('returns provenance, coverage, freshness, and bounded data for every tool', async () => {
    const { service, events } = harness();
    const calls = [
      ['finance_get_status', {}],
      ['finance_search_transactions', {}],
      [
        'finance_get_transaction',
        { transactionRef: 'transaction-1' },
      ],
      [
        'finance_analyze_spending',
        {
          startDate: '2026-08-01',
          endDate: '2026-08-11',
          groupBy: 'category',
        },
      ],
      ['finance_get_recurring_obligations', {}],
      ['finance_get_budget_status', {}],
      ['finance_get_pending_exceptions', {}],
    ] as const;

    for (const [tool, input] of calls) {
      const result = await service.invoke(tool, input, CONTEXT);
      expect(result.metadata.source).toBe('missionControlProjection');
      expect(result.metadata.asOf).toBe(FRESH.sourceAsOf);
      expect(result.metadata.coverage).toEqual({
        start: FRESH.coverageStart,
        end: FRESH.coverageEnd,
      });
      expect(result.metadata.freshness).toBe('fresh');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        64 * 1024
      );
    }
    expect(events).toHaveLength(7);
    expect(events.every((event) => event.outcome === 'succeeded')).toBe(true);
  });

  it('calculates spending and comparisons without returning raw records', async () => {
    const { service } = harness();
    const result = await service.invoke(
      'finance_analyze_spending',
      {
        startDate: '2026-08-01',
        endDate: '2026-08-11',
        compareStartDate: '2026-07-01',
        compareEndDate: '2026-07-31',
        groupBy: 'category',
        contributorLimit: 5,
      },
      CONTEXT
    );

    expect(result.metadata.derivation).toBe('calculatedByMissionControl');
    expect(result.data).toEqual({
      period: {
        startDate: '2026-08-01',
        endDate: '2026-08-11',
        totals: [
          { currency: 'USD', totalMinor: 3_500, transactionCount: 2 },
        ],
      },
      comparison: {
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        totals: [
          {
            currency: 'USD',
            totalMinor: 2_000,
            transactionCount: 1,
            deltaMinor: 1_500,
            deltaBasisPoints: 7_500,
          },
        ],
      },
      groupBy: 'category',
      groups: [
        {
          key: 'category-groceries',
          displayName: 'Groceries',
          currency: 'USD',
          totalMinor: 2_500,
          transactionCount: 1,
        },
        {
          key: 'category-transport',
          displayName: 'Transport',
          currency: 'USD',
          totalMinor: 1_000,
          transactionCount: 1,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('transaction-1');
  });

  it('partitions spending totals and contributors by currency', async () => {
      const { service } = harness({
        transactionsForAnalysis: vi.fn(async () => ({
          snapshot: FRESH,
          items: [
            transaction(),
            transaction({
              transactionRef: 'transaction-eur',
              currency: 'EUR',
              amountMinor: -1_500,
            }),
            transaction({
              transactionRef: 'transaction-eur-2',
              currency: 'EUR',
              amountMinor: -500,
              categoryRef: 'category-eur-other',
              categoryName: 'EUR Other',
            }),
            transaction({
              transactionRef: 'transaction-usd-2',
              amountMinor: -1_000,
              categoryRef: 'category-usd-other',
              categoryName: 'USD Other',
            }),
          ],
          hasMore: false,
        })),
      });
      const result = await service.invoke(
        'finance_analyze_spending',
        {
          startDate: '2026-08-01',
          endDate: '2026-08-11',
          groupBy: 'category',
          contributorLimit: 1,
        },
        CONTEXT
      );
      expect(result.data).toMatchObject({
        period: {
          totals: [
            { currency: 'EUR', totalMinor: 2_000 },
            { currency: 'USD', totalMinor: 3_500 },
          ],
        },
        groups: [
          { currency: 'EUR', totalMinor: 1_500 },
          { currency: 'USD', totalMinor: 2_500 },
        ],
      });
  });

  it('distinguishes Monarch and Tyrion facts without exposing notes', async () => {
    const { service } = harness();
    const result = await service.invoke(
      'finance_get_transaction',
      { transactionRef: 'transaction-1' },
      CONTEXT
    );
    expect(result.metadata.derivation).toBe('viaMonarch');
    expect(result.data).toMatchObject({
      transaction: {
        factAttribution: {
          transaction: 'viaMonarch',
          attribution: 'derivedByTyrion',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('note');
  });

  it('reports stale, partial, and unavailable datasets without claiming freshness', async () => {
    const stale = {
      ...FRESH,
      sourceAsOf: '2026-08-01T00:00:00.000Z',
    };
    const partial = { ...FRESH, completeness: 'partial' as const };
    const unavailable: DatasetSnapshot = {
      sourceAsOf: null,
      coverageStart: null,
      coverageEnd: null,
      completeness: 'unavailable',
    };
    const { service } = harness({
      getStatus: vi.fn(async () => ({
        connector: FRESH,
        transactions: stale,
        recurring: partial,
        budgets: unavailable,
        exceptions: FRESH,
      })),
    });

    const result = await service.invoke('finance_get_status', {}, CONTEXT);
    expect(result.metadata.freshness).toBe('unavailable');
    expect(result.metadata.warnings).toEqual(['finance_source_unavailable']);
    expect(result.data).toMatchObject({
      datasets: {
        transactions: {
          freshness: 'stale',
          warnings: ['finance_source_stale'],
        },
        recurring: {
          freshness: 'partial',
          warnings: ['finance_source_partial'],
        },
        budgets: {
          freshness: 'unavailable',
          warnings: ['finance_source_unavailable'],
        },
      },
    });
  });

  it('fails closed before projection access for a different household or missing permission', async () => {
    const { service, source, events } = harness();
    await expect(
      service.invoke('finance_get_status', {}, {
        ...CONTEXT,
        householdScope: 'household-2',
      })
    ).rejects.toMatchObject({
      code: 'permission_denied',
      message: 'Finance inquiry permission is required.',
    });
    await expect(
      service.invoke('finance_get_status', {}, {
        ...CONTEXT,
        permissions: new Set(),
      })
    ).rejects.toBeInstanceOf(FinanceInquiryError);
    expect(source.getStatus).not.toHaveBeenCalled();
    expect(events.map((event) => event.outcome)).toEqual([
      'permissionDenied',
      'permissionDenied',
    ]);
  });

  it('returns stable invalid-input and not-found errors and audits both', async () => {
    const { service, events } = harness({
      getTransaction: vi.fn(async () => ({
        snapshot: FRESH,
        item: null,
      })),
    });

    await expect(
      service.invoke(
        'finance_search_transactions',
        { limit: 101 },
        CONTEXT
      )
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'The finance inquiry request is invalid.',
    });
    await expect(
      service.invoke(
        'finance_get_transaction',
        { transactionRef: 'missing' },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(events.map((event) => event.outcome)).toEqual([
      'invalidInput',
      'notFound',
    ]);
  });

  it('replaces a malformed request ID before writing the rejection audit', async () => {
    const { service, events } = harness();
    await expect(
      service.invoke('finance_get_status', {}, {
        ...CONTEXT,
        requestId: 'unsafe request\nvalue',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(events[0]).toMatchObject({
      requestId: 'invalid-request',
      outcome: 'invalidInput',
    });
    expect(JSON.stringify(events)).not.toContain('unsafe request');
  });

  it('rejects projection schema drift instead of leaking extra private fields', async () => {
    const { service, events } = harness({
      getTransaction: vi.fn(async () => ({
        snapshot: FRESH,
        item: {
          ...transaction(),
          note: 'private synthetic note',
        } as TransactionInquiryRecord,
      })),
    });
    await expect(
      service.invoke(
        'finance_get_transaction',
        { transactionRef: 'transaction-1' },
        CONTEXT
      )
    ).rejects.toMatchObject({
      code: 'source_unavailable',
      message: 'Finance data is temporarily unavailable.',
    });
    expect(events[0]).toMatchObject({
      outcome: 'sourceUnavailable',
      itemCount: null,
    });
    expect(JSON.stringify(events)).not.toContain('private synthetic note');
  });

  it('cancels an in-flight query and propagates the internal abort signal', async () => {
    let internalSignal: AbortSignal | undefined;
    const { service, events } = harness({
      getStatus: vi.fn(
        async (_householdScope, signal) =>
          new Promise((resolve) => {
            internalSignal = signal;
            signal.addEventListener('abort', () => resolve({} as never), {
              once: true,
            });
          })
      ),
    });
    const controller = new AbortController();
    const pending = service.invoke('finance_get_status', {}, {
      ...CONTEXT,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(internalSignal?.aborted).toBe(true);
    expect(events[0]?.outcome).toBe('cancelled');
  });

  it('times out an unresponsive projection query with a safe error', async () => {
    const { service, events } = harness(
      {
        getStatus: vi.fn(
          async () => new Promise<never>(() => undefined)
        ),
      },
      { timeoutMs: 5 }
    );
    await expect(
      service.invoke('finance_get_status', {}, CONTEXT)
    ).rejects.toMatchObject({
      code: 'timed_out',
      message: 'The finance inquiry timed out.',
    });
    expect(events[0]?.outcome).toBe('timedOut');
  });

  it('bounds a stalled audit adapter instead of hanging the invocation', async () => {
      const record = vi.fn(async () => new Promise<void>(() => undefined));
      const service = new FinanceInquiryService({
        householdScope: 'household-1',
        projection: projection(),
        audit: { record },
        clock: () => NOW,
        timeoutMs: 50,
        auditTimeoutMs: 5,
      });
      await expect(
        service.invoke('finance_get_status', {}, CONTEXT)
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      expect(record).toHaveBeenCalledTimes(1);
  });

  it('marks implausibly future projection timestamps as partial', async () => {
      const future: DatasetSnapshot = {
        ...FRESH,
        sourceAsOf: '2026-08-12T18:00:00.000Z',
      };
      const { service } = harness({
        searchTransactions: vi.fn(async () => ({
          snapshot: future,
          items: [transaction()],
          hasMore: false,
        })),
      });
      const result = await service.invoke(
        'finance_search_transactions',
        {},
        CONTEXT
      );
      expect(result.metadata.freshness).toBe('partial');
      expect(result.metadata.warnings).toEqual(['finance_source_partial']);
  });

  it('rejects pages and analyses that exceed their approved bounds', async () => {
    const { service, events } = harness({
      transactionsForAnalysis: vi.fn(async () => ({
        snapshot: FRESH,
        items: [transaction()],
        hasMore: true,
      })),
    });
    await expect(
      service.invoke(
        'finance_analyze_spending',
        {
          startDate: '2026-08-01',
          endDate: '2026-08-11',
          groupBy: 'merchant',
        },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'output_bound_exceeded' });
    expect(events[0]?.outcome).toBe('outputBoundExceeded');
  });

  it('enforces serialized byte limits after projection validation', async () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      transaction({
        transactionRef: `transaction-${index}`,
        merchantName: `Invented merchant ${index} with a deliberately long display label`,
      })
    );
    const { service, events } = harness(
      {
        searchTransactions: vi.fn(async () => ({
          snapshot: FRESH,
          items,
          hasMore: false,
        })),
      },
      { maxOutputBytes: 1_024 }
    );
    await expect(
      service.invoke(
        'finance_search_transactions',
        { limit: 20 },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'output_bound_exceeded' });
    expect(events[0]?.outcome).toBe('outputBoundExceeded');
  });

  it('sanitizes arbitrary adapter failures and never audits exception text', async () => {
    const { service, events } = harness({
      getStatus: vi.fn(async () => {
        throw new Error('upstream secret response and session path');
      }),
    });
    await expect(
      service.invoke('finance_get_status', {}, CONTEXT)
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'source_unavailable',
        message: 'Finance data is temporarily unavailable.',
      })
    );
    expect(JSON.stringify(events)).not.toContain('upstream secret');
    expect(events[0]?.outcome).toBe('sourceUnavailable');
  });
});
