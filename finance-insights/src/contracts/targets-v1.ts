import { z } from 'zod';
import {
  merchantKeySchema,
  parseContractV1,
  periodSchema,
  sourceReferenceSchema,
} from './primitives.js';

export const monarchTransactionTargetSchema = z.strictObject({
  system: z.literal('monarch'),
  targetKind: z.literal('transaction'),
  sourceRef: sourceReferenceSchema,
});

export const monarchRecurringTargetSchema = z.strictObject({
  system: z.literal('monarch'),
  targetKind: z.literal('recurring'),
  sourceRef: sourceReferenceSchema,
});

export const monarchReportFilterTargetSchema = z
  .strictObject({
    system: z.literal('monarch'),
    targetKind: z.literal('reportFilter'),
    reportKind: z.literal('spending'),
    period: periodSchema,
    categorySourceRef: sourceReferenceSchema.nullable(),
    merchantKey: merchantKeySchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.categorySourceRef !== null && value.merchantKey !== null) {
      context.addIssue({
        code: 'custom',
        message: 'report filter may select a category or merchant, not both',
      });
    }
  });

export const monarchSafeRootTargetSchema = z.strictObject({
  system: z.literal('monarch'),
  targetKind: z.literal('safeRoot'),
  root: z.enum(['transactions', 'recurring', 'reports']),
});

export const owlDocumentTargetSchema = z.strictObject({
  system: z.literal('owl'),
  targetKind: z.literal('document'),
  sourceRef: sourceReferenceSchema,
});

export const externalTargetSchema = z.union([
  monarchTransactionTargetSchema,
  monarchRecurringTargetSchema,
  monarchReportFilterTargetSchema,
  monarchSafeRootTargetSchema,
  owlDocumentTargetSchema,
]);

export type MonarchTransactionTargetV1 = z.infer<
  typeof monarchTransactionTargetSchema
>;
export type MonarchRecurringTargetV1 = z.infer<
  typeof monarchRecurringTargetSchema
>;
export type MonarchReportFilterTargetV1 = z.infer<
  typeof monarchReportFilterTargetSchema
>;
export type MonarchSafeRootTargetV1 = z.infer<
  typeof monarchSafeRootTargetSchema
>;
export type OwlDocumentTargetV1 = z.infer<typeof owlDocumentTargetSchema>;
export type ExternalTargetV1 = z.infer<typeof externalTargetSchema>;

export function parseExternalTargetV1(value: unknown): ExternalTargetV1 {
  return parseContractV1(externalTargetSchema, value, 'external target');
}

export function fallbackTargetForV1(
  target: ExternalTargetV1
): MonarchSafeRootTargetV1 | null {
  const parsed = parseExternalTargetV1(target);
  if (parsed.system === 'owl') return null;
  if (parsed.targetKind === 'safeRoot') return parsed;
  if (parsed.targetKind === 'transaction') {
    return { system: 'monarch', targetKind: 'safeRoot', root: 'transactions' };
  }
  if (parsed.targetKind === 'recurring') {
    return { system: 'monarch', targetKind: 'safeRoot', root: 'recurring' };
  }
  return { system: 'monarch', targetKind: 'safeRoot', root: 'reports' };
}
