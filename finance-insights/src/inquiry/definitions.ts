import type { z } from 'zod';
import {
  financeToolInputSchemas,
  type FinanceToolName,
} from './contracts.js';

export interface FinanceInquiryToolDefinition {
  name: FinanceToolName;
  description: string;
  readOnly: true;
  inputSchema: z.ZodType;
  inputKeys: readonly string[];
}

export const FINANCE_INQUIRY_TOOL_DEFINITIONS: readonly FinanceInquiryToolDefinition[] =
  Object.freeze([
    {
      name: 'finance_get_status',
      description:
        'Report synchronized finance dataset coverage and freshness without credentials or session details.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_get_status,
      inputKeys: [],
    },
    {
      name: 'finance_search_transactions',
      description:
        'Search the bounded synchronized transaction projection. Private notes are never returned.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_search_transactions,
      inputKeys: [
        'startDate',
        'endDate',
        'merchant',
        'categoryRef',
        'accountRef',
        'kidRef',
        'amountMinorMin',
        'amountMinorMax',
        'pending',
        'recurring',
        'reviewState',
        'limit',
      ],
    },
    {
      name: 'finance_get_transaction',
      description:
        'Get one normalized transaction and its Tyrion attribution, with an optional bounded freshness check.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_get_transaction,
      inputKeys: ['transactionRef', 'requireFresh'],
    },
    {
      name: 'finance_analyze_spending',
      description:
        'Calculate bounded spending totals, comparisons, groups, and contributors deterministically.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_analyze_spending,
      inputKeys: [
        'startDate',
        'endDate',
        'compareStartDate',
        'compareEndDate',
        'groupBy',
        'categoryRef',
        'accountRef',
        'kidRef',
        'includePending',
        'contributorLimit',
      ],
    },
    {
      name: 'finance_get_recurring_obligations',
      description:
        'List bounded recurring obligations and material changes from the synchronized snapshot.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_get_recurring_obligations,
      inputKeys: ['activeOnly', 'limit'],
    },
    {
      name: 'finance_get_budget_status',
      description:
        'Report compact current budget status and warnings; budget management remains in Monarch.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_get_budget_status,
      inputKeys: ['period', 'warningsOnly', 'limit'],
    },
    {
      name: 'finance_get_pending_exceptions',
      description:
        'List bounded actionable Tyrion attribution, anomaly, reconciliation, write-back, and policy exceptions.',
      readOnly: true,
      inputSchema: financeToolInputSchemas.finance_get_pending_exceptions,
      inputKeys: ['kinds', 'limit'],
    },
  ]);
