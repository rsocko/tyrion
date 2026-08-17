import type { z } from 'zod';
import {
  financeMutationToolInputSchemas,
  type FinanceMutationToolName,
} from './contracts.js';

export interface FinanceMutationToolDefinition {
  name: FinanceMutationToolName;
  description: string;
  readOnly: false;
  inputSchema: z.ZodType;
  inputKeys: readonly string[];
}

export const FINANCE_MUTATION_TOOL_DEFINITIONS: readonly FinanceMutationToolDefinition[] =
  Object.freeze([
    {
      name: 'finance_prepare_category_change',
      description:
        'Prepare an expiring confirmation proposal for one Monarch transaction category change. This does not mutate data.',
      readOnly: false,
      inputSchema:
        financeMutationToolInputSchemas.finance_prepare_category_change,
      inputKeys: ['transactionRef', 'categoryRef'],
    },
    {
      name: 'finance_prepare_kid_assignment',
      description:
        'Prepare an expiring confirmation proposal for one Tyrion-owned transaction kid assignment. This does not mutate data.',
      readOnly: false,
      inputSchema:
        financeMutationToolInputSchemas.finance_prepare_kid_assignment,
      inputKeys: ['transactionRef', 'kidRef'],
    },
    {
      name: 'finance_execute_mutation',
      description:
        'Execute one confirmed, unexpired finance mutation proposal after rechecking current state. Proposal tokens are single-use.',
      readOnly: false,
      inputSchema: financeMutationToolInputSchemas.finance_execute_mutation,
      inputKeys: ['proposalToken', 'confirm'],
    },
  ]);

