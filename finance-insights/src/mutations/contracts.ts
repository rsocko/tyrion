import { z } from 'zod';
import {
  normalizedDisplayNameSchema,
  sourceReferenceSchema,
  utcTimestampSchema,
} from '../contracts/primitives.js';

export const FINANCE_MUTATION_PROPOSAL_TTL_MS = 5 * 60 * 1_000;

export const financeMutationToolNameSchema = z.enum([
  'finance_prepare_category_change',
  'finance_prepare_kid_assignment',
  'finance_execute_mutation',
]);

export const financeMutationOperationSchema = z.enum([
  'changeCategory',
  'assignKid',
]);

export const financePrepareCategoryChangeInputSchema = z.strictObject({
  transactionRef: sourceReferenceSchema,
  categoryRef: sourceReferenceSchema,
});

export const financePrepareKidAssignmentInputSchema = z.strictObject({
  transactionRef: sourceReferenceSchema,
  kidRef: sourceReferenceSchema,
});

export const financeExecuteMutationInputSchema = z.strictObject({
  proposalToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  confirm: z.literal(true),
});

export const financeMutationToolInputSchemas = Object.freeze({
  finance_prepare_category_change: financePrepareCategoryChangeInputSchema,
  finance_prepare_kid_assignment: financePrepareKidAssignmentInputSchema,
  finance_execute_mutation: financeExecuteMutationInputSchema,
});

export const financeMutationValueSchema = z.strictObject({
  ref: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
});

export const financeMutationConnectorStateSchema = z.enum([
  'connected',
  'degraded',
  'unauthenticated',
  'expired',
  'unavailable',
]);

export const financeMutationCurrentStateSchema = z.strictObject({
  transactionRef: sourceReferenceSchema,
  category: financeMutationValueSchema.nullable(),
  categoryVersion: z.string().trim().min(1).max(160),
  kid: financeMutationValueSchema.nullable(),
  attributionStateVersion: z.number().int().min(1),
  connectorState: financeMutationConnectorStateSchema,
  sourceAsOf: utcTimestampSchema,
});

export type FinanceMutationToolName = z.infer<
  typeof financeMutationToolNameSchema
>;
export type FinanceMutationOperation = z.infer<
  typeof financeMutationOperationSchema
>;
export type FinanceMutationValue = z.infer<typeof financeMutationValueSchema>;
export type FinanceMutationCurrentState = z.infer<
  typeof financeMutationCurrentStateSchema
>;

export interface FinanceMutationProposalView {
  proposalToken: string;
  operation: FinanceMutationOperation;
  transactionRef: string;
  oldValue: FinanceMutationValue | null;
  newValue: FinanceMutationValue;
  proposedAt: string;
  expiresAt: string;
  provenance: 'viaMonarch' | 'derivedByTyrion';
}

export interface FinanceMutationPrepareResult {
  tool:
    | 'finance_prepare_category_change'
    | 'finance_prepare_kid_assignment';
  proposal: FinanceMutationProposalView;
}

export interface FinanceMutationExecuteResult {
  tool: 'finance_execute_mutation';
  operation: FinanceMutationOperation;
  transactionRef: string;
  value: FinanceMutationValue;
  executedAt: string;
  provenance: 'viaMonarch' | 'derivedByTyrion';
}

