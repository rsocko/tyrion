import { z } from 'zod';
import {
  analysisStateSchema,
  baselineSufficiencySchema,
  insightKindSchema,
  insightOccurrenceSummarySchema,
  severitySchema,
  sourceLifecycleSchema,
} from './occurrence-v1.js';
import {
  contractVersionSchema,
  parseContractV1,
  sourceReferenceSchema,
  utcTimestampSchema,
} from './primitives.js';

const uniqueArray = <T extends z.ZodType>(schema: T, maximum: number) =>
  z
    .array(schema)
    .max(maximum)
    .refine(
      (values) => new Set(values).size === values.length,
      'must contain unique values'
    );

export const occurrenceListQuerySchema = z.strictObject({
  kind: uniqueArray(insightKindSchema, 4),
  sourceLifecycle: uniqueArray(sourceLifecycleSchema, 3),
  analysisState: uniqueArray(analysisStateSchema, 4),
  severity: uniqueArray(severitySchema, 3),
  baselineSufficiency: uniqueArray(baselineSufficiencySchema, 3),
  connectorRef: sourceReferenceSchema.nullable(),
  updatedAfter: utcTimestampSchema.nullable(),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).max(512).nullable(),
});

export const occurrenceListResponseSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  items: z.array(insightOccurrenceSummarySchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
});

export type OccurrenceListQueryV1 = z.infer<typeof occurrenceListQuerySchema>;
export type OccurrenceListResponseV1 = z.infer<
  typeof occurrenceListResponseSchema
>;

export function defaultOccurrenceListQueryV1(): OccurrenceListQueryV1 {
  return {
    kind: [],
    sourceLifecycle: ['open'],
    analysisState: ['qualified'],
    severity: [],
    baselineSufficiency: [],
    connectorRef: null,
    updatedAfter: null,
    limit: 50,
    cursor: null,
  };
}

export function parseOccurrenceListQueryV1(
  value: unknown
): OccurrenceListQueryV1 {
  return parseContractV1(occurrenceListQuerySchema, value, 'occurrence list query');
}

export function parseOccurrenceListResponseV1(
  value: unknown
): OccurrenceListResponseV1 {
  return parseContractV1(
    occurrenceListResponseSchema,
    value,
    'occurrence list response'
  );
}
