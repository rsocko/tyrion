import { z } from 'zod';
import {
  contractVersionSchema,
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  parseContractV1,
} from './primitives.js';

export const insightErrorCodeSchema = z.enum([
  'invalid_request',
  'invalid_filter',
  'invalid_cursor',
  'invalid_date_range',
  'unsupported_target',
  'unsupported_action',
  'insight_auth_required',
  'insight_auth_invalid',
  'insight_forbidden',
  'insight_route_not_available',
  'occurrence_not_found',
  'idempotency_conflict',
  'source_generation_conflict',
  'source_batch_conflict',
  'source_currency_conflict',
  'stale_source_generation',
  'stale_evaluation',
  'occurrence_revision_conflict',
  'policy_conflict',
  'payload_too_large',
  'page_too_large',
  'source_generation_too_large',
  'unsupported_media_type',
  'evaluation_in_progress',
  'insight_service_not_configured',
  'insight_source_unavailable',
  'insight_store_unavailable',
  'insight_operation_failed',
]);

export type InsightErrorCodeV1 = z.infer<typeof insightErrorCodeSchema>;

export const INSIGHT_ERROR_STATUS_V1: Readonly<
  Record<InsightErrorCodeV1, number>
> = Object.freeze({
  invalid_request: 400,
  invalid_filter: 400,
  invalid_cursor: 400,
  invalid_date_range: 422,
  unsupported_target: 422,
  unsupported_action: 422,
  insight_auth_required: 401,
  insight_auth_invalid: 401,
  insight_forbidden: 403,
  insight_route_not_available: 404,
  occurrence_not_found: 404,
  idempotency_conflict: 409,
  source_generation_conflict: 409,
  source_batch_conflict: 409,
  source_currency_conflict: 409,
  stale_source_generation: 409,
  stale_evaluation: 409,
  occurrence_revision_conflict: 409,
  policy_conflict: 409,
  payload_too_large: 413,
  page_too_large: 413,
  source_generation_too_large: 413,
  unsupported_media_type: 415,
  evaluation_in_progress: 429,
  insight_service_not_configured: 503,
  insight_source_unavailable: 503,
  insight_store_unavailable: 503,
  insight_operation_failed: 500,
});

export const INSIGHT_ERROR_MESSAGES_V1: Readonly<
  Record<InsightErrorCodeV1, string>
> = Object.freeze({
  invalid_request: 'Finance insight request is invalid',
  invalid_filter: 'Finance insight filter is invalid',
  invalid_cursor: 'Finance insight cursor is invalid',
  invalid_date_range: 'Finance insight date range is invalid',
  unsupported_target: 'Finance insight target is unsupported',
  unsupported_action: 'Finance insight action is unsupported',
  insight_auth_required: 'Finance insight authentication is required',
  insight_auth_invalid: 'Finance insight authentication is invalid',
  insight_forbidden: 'Finance insight request is forbidden',
  insight_route_not_available: 'Finance insight route is not available',
  occurrence_not_found: 'Finance insight occurrence was not found',
  idempotency_conflict: 'Finance insight idempotency key conflicts with prior input',
  source_generation_conflict: 'Finance insight source generation conflicts with prior input',
  source_batch_conflict: 'Finance insight source batch conflicts with prior input',
  source_currency_conflict: 'Finance insight source currency conflicts with policy',
  stale_source_generation: 'Finance insight source generation is stale',
  stale_evaluation: 'Finance insight evaluation is stale',
  occurrence_revision_conflict: 'Finance insight occurrence revision has changed',
  policy_conflict: 'Finance insight policy version has changed',
  payload_too_large: 'Finance insight request payload is too large',
  page_too_large: 'Finance insight page exceeds the allowed size',
  source_generation_too_large: 'Finance insight source generation exceeds the allowed size',
  unsupported_media_type: 'Finance insight media type is unsupported',
  evaluation_in_progress: 'Finance insight evaluation is in progress',
  insight_service_not_configured: 'Finance insight service is not configured',
  insight_source_unavailable: 'Finance insight source data is unavailable',
  insight_store_unavailable: 'Finance insight store is unavailable',
  insight_operation_failed: 'Finance insight operation failed',
});

const insightErrorVariants = Object.entries(INSIGHT_ERROR_MESSAGES_V1).map(
  ([code, message]) =>
    z.strictObject({
      contractVersion: contractVersionSchema,
      error: z.strictObject({
        code: z.literal(code as InsightErrorCodeV1),
        message: z.literal(message),
      }),
    })
);

export const insightErrorResponseSchema = z.union(
  insightErrorVariants as [
    (typeof insightErrorVariants)[number],
    (typeof insightErrorVariants)[number],
    ...(typeof insightErrorVariants)[number][],
  ]
);

export type InsightErrorResponseV1 = z.infer<
  typeof insightErrorResponseSchema
>;

export interface InsightErrorDescriptorV1 {
  status: number;
  body: InsightErrorResponseV1;
  retryAfterSeconds: number | null;
}

export function createInsightErrorV1(
  code: InsightErrorCodeV1,
  retryAfterSeconds?: number
): InsightErrorDescriptorV1 {
  if (code === 'evaluation_in_progress') {
    if (
      !Number.isInteger(retryAfterSeconds) ||
      retryAfterSeconds === undefined ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds > 300
    ) {
      throw new RangeError(
        'evaluation_in_progress requires Retry-After from 1 to 300 seconds'
      );
    }
  } else if (retryAfterSeconds !== undefined) {
    throw new RangeError('Retry-After is supported only for evaluation_in_progress');
  }
  return {
    status: INSIGHT_ERROR_STATUS_V1[code],
    body: {
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      error: {
        code,
        message: INSIGHT_ERROR_MESSAGES_V1[code],
      },
    },
    retryAfterSeconds: retryAfterSeconds ?? null,
  };
}

export function parseInsightErrorResponseV1(
  value: unknown
): InsightErrorResponseV1 {
  const parsed = parseContractV1(
    insightErrorResponseSchema,
    value,
    'insight error response'
  );
  return parsed;
}
