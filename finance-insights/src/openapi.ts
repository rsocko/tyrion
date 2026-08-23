import { z } from 'zod';
import {
  occurrenceActionRequestSchema,
  occurrenceActionResultSchema,
} from './contracts/actions-v1.js';
import {
  INSIGHT_ERROR_STATUS_V1,
  insightErrorResponseSchema,
} from './contracts/errors-v1.js';
import {
  insightOccurrenceDetailSchema,
  insightOccurrenceSummarySchema,
} from './contracts/occurrence-v1.js';
import {
  occurrenceListQuerySchema,
  occurrenceListResponseSchema,
} from './contracts/list-v1.js';
import {
  documentExpectationSignalsSchema,
} from './contracts/document-expectations-v1.js';
import {
  evaluationRequestSchema,
  evaluationResultSchema,
  SOURCE_GENERATION_ITEM_LIMITS_V1,
  sourceBatchReceiptSchema,
  sourceFactBatchSchema,
  sourceGenerationCommitRequestSchema,
  sourceGenerationCreateRequestSchema,
  sourceGenerationResultSchema,
} from './contracts/source-v1.js';
import {
  financeAutomationDeliveryAckRequestSchema,
  financeAutomationDeliveryAckResultSchema,
  financeAutomationJobRequestSchema,
  financeAutomationJobResultSchema,
} from './automation/contracts-v1.js';

const schemas = {
  SourceGenerationCreateRequestV1: sourceGenerationCreateRequestSchema,
  SourceFactBatchV1: sourceFactBatchSchema,
  SourceGenerationCommitRequestV1: sourceGenerationCommitRequestSchema,
  EvaluationRequestV1: evaluationRequestSchema,
  SourceGenerationResultV1: sourceGenerationResultSchema,
  SourceBatchReceiptV1: sourceBatchReceiptSchema,
  EvaluationResultV1: evaluationResultSchema,
  OccurrenceListQueryV1: occurrenceListQuerySchema,
  OccurrenceListResponseV1: occurrenceListResponseSchema,
  InsightOccurrenceSummaryV1: insightOccurrenceSummarySchema,
  InsightOccurrenceDetailV1: insightOccurrenceDetailSchema,
  OccurrenceActionRequestV1: occurrenceActionRequestSchema,
  OccurrenceActionResultV1: occurrenceActionResultSchema,
  InsightErrorResponseV1: insightErrorResponseSchema,
  FinanceAutomationJobRequestV1: financeAutomationJobRequestSchema,
  FinanceAutomationJobResultV1: financeAutomationJobResultSchema,
  FinanceAutomationDeliveryAckRequestV1:
    financeAutomationDeliveryAckRequestSchema,
  FinanceAutomationDeliveryAckResultV1:
    financeAutomationDeliveryAckResultSchema,
  DocumentExpectationSignalsV1: documentExpectationSignalsSchema,
} as const;

const errorResponses = {
  '400': errorResponse('Invalid request', 400),
  '401': errorResponse('Authentication required or invalid', 401),
  '403': errorResponse('Request forbidden', 403),
  '404': errorResponse('Route or occurrence not found', 404),
  '409': errorResponse('Version, sequence, or idempotency conflict', 409),
  '422': errorResponse('Semantically invalid request', 422),
  '413': errorResponse('Request or generation exceeds a safety bound', 413),
  '415': errorResponse('Unsupported media type', 415),
  '429': errorResponse('Evaluation is already in progress', 429),
  '500': errorResponse('Sanitized operation failure', 500),
  '503': errorResponse('Service, source, or store unavailable', 503),
};

export function createFinanceInsightsOpenApiV1(): Record<string, unknown> {
  const generatedSchemas = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { target: 'draft-2020-12' }),
    ])
  );
  applyUtcTimestampFormats(generatedSchemas);
  applySemanticSchemaConstraints(generatedSchemas);
  applyStatusSpecificErrorSchemas(generatedSchemas);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tyrion Internal Finance Insights Service',
      version: '1.0.0',
      description:
        'Private server-to-server contract. It accepts only normalized publication facts and never exposes Monarch sessions, raw upstream responses, or arbitrary URLs.',
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/internal/v1/finance/insights/document-expectation-signals/{generationId}':
        {
          get: {
            operationId: 'getDocumentExpectationSignalsV1',
            summary:
              'Pull one bounded OWL document-expectation projection for an immutable source generation',
            parameters: [
              pathParameter('generationId', 160),
              {
                name: 'connectorRef',
                in: 'query',
                required: true,
                schema: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 160,
                  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
                },
              },
            ],
            responses: {
              '200': jsonResponse(
                'Bounded generation-addressed expectation signals',
                'DocumentExpectationSignalsV1'
              ),
              ...errorResponses,
            },
          },
        },
      '/api/internal/v1/finance/insights/source-generations': {
        post: operation(
          'createSourceGenerationV1',
          'Idempotently begin one normalized source generation',
          'SourceGenerationCreateRequestV1',
          'SourceGenerationResultV1',
          202
        ),
      },
      '/api/internal/v1/finance/insights/source-generations/{generationId}/batches/{batchIndex}':
        {
          put: {
            ...operation(
              'putSourceFactBatchV1',
              'Idempotently upload one bounded source fact batch',
              'SourceFactBatchV1',
              'SourceBatchReceiptV1',
              200
            ),
            parameters: [
              pathParameter('generationId', 160),
              {
                name: 'batchIndex',
                in: 'path',
                required: true,
                schema: { type: 'integer', minimum: 0 },
              },
            ],
          },
        },
      '/api/internal/v1/finance/insights/source-generations/{generationId}/commit':
        {
          post: {
            ...operation(
              'commitSourceGenerationV1',
              'Validate and atomically promote a complete source generation',
              'SourceGenerationCommitRequestV1',
              'SourceGenerationResultV1',
              200
            ),
            parameters: [pathParameter('generationId', 160)],
          },
        },
      '/api/internal/v1/finance/insights/evaluations': {
        post: operation(
          'retryFinanceInsightEvaluationV1',
          'Idempotently retry a generation under its assigned versions',
          'EvaluationRequestV1',
          'EvaluationResultV1',
          202
        ),
      },
      '/api/internal/v1/finance/insights/automation/jobs': {
        post: operation(
          'runFinanceAutomationJobV1',
          'Run one durable scheduled automation evaluation without overlapping the same connector job',
          'FinanceAutomationJobRequestV1',
          'FinanceAutomationJobResultV1',
          200
        ),
      },
      '/api/internal/v1/finance/insights/automation/deliveries/ack': {
        post: operation(
          'acknowledgeFinanceAutomationDeliveriesV1',
          'Acknowledge exact delivery versions after Mission Control applies them',
          'FinanceAutomationDeliveryAckRequestV1',
          'FinanceAutomationDeliveryAckResultV1',
          200
        ),
      },
      '/api/internal/v1/finance/insights/occurrences': {
        get: {
          operationId: 'listFinanceInsightOccurrencesV1',
          summary: 'Read a bounded snapshot page of occurrence summaries',
          parameters: [
            queryArrayParameter(
              'kind',
              4,
              [
                'recurringAmountChange',
                'largeTransaction',
                'categoryVariance',
                'merchantVariance',
              ]
            ),
            queryArrayParameter(
              'sourceLifecycle',
              3,
              ['open', 'resolved', 'superseded']
            ),
            queryArrayParameter(
              'analysisState',
              4,
              ['analyzing', 'qualified', 'insufficientBaseline', 'unavailable']
            ),
            queryArrayParameter('severity', 3, ['info', 'medium', 'high']),
            queryArrayParameter(
              'baselineSufficiency',
              3,
              ['insufficient', 'limited', 'sufficient']
            ),
            queryStringParameter(
              'connectorRef',
              160,
              '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
            ),
            {
              name: 'updatedAfter',
              in: 'query',
              schema: {
                type: 'string',
                format: 'date-time',
                minLength: 20,
                maxLength: 30,
                pattern:
                  '^(?:\\d{4})-(?:\\d{2})-(?:\\d{2})T(?:\\d{2}):(?:\\d{2}):(?:\\d{2})(?:\\.\\d{1,3})?Z$',
              },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
            queryStringParameter('cursor', 512),
          ],
          responses: {
            '200': jsonResponse(
              'Bounded occurrence page',
              'OccurrenceListResponseV1'
            ),
            ...errorResponses,
          },
        },
      },
      '/api/internal/v1/finance/insights/occurrences/{occurrenceId}': {
        get: {
          operationId: 'getFinanceInsightOccurrenceV1',
          summary:
            'Read the shared detail DTO used by notification detail and the finance drawer',
          parameters: [pathParameter('occurrenceId', 64)],
          responses: {
            '200': jsonResponse(
              'Bounded occurrence detail',
              'InsightOccurrenceDetailV1'
            ),
            ...errorResponses,
          },
        },
      },
      '/api/internal/v1/finance/insights/occurrences/{occurrenceId}/actions':
        {
          post: {
            ...operation(
              'applyFinanceInsightActionV1',
              'Apply one confirmed structured Tyrion action',
              'OccurrenceActionRequestV1',
              'OccurrenceActionResultV1',
              200
            ),
            parameters: [pathParameter('occurrenceId', 64)],
          },
        },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Server-only private-service credential.',
        },
      },
      schemas: generatedSchemas,
    },
  };
}

function operation(
  operationId: string,
  summary: string,
  requestSchema: keyof typeof schemas,
  responseSchema: keyof typeof schemas,
  successStatus: number
): Record<string, unknown> {
  return {
    operationId,
    summary,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${requestSchema}` },
        },
      },
    },
    responses: {
      [String(successStatus)]: jsonResponse('Successful operation', responseSchema),
      ...errorResponses,
    },
  };
}

function jsonResponse(
  description: string,
  schema: string
): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  };
}

function errorResponse(
  description: string,
  status: number
): Record<string, unknown> {
  const response = jsonResponse(
    description,
    `InsightErrorResponse${status}V1`
  );
  if (status === 429) {
    response.headers = {
      'Retry-After': {
        required: true,
        description: 'Bounded retry delay in seconds.',
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 300,
        },
      },
    };
  }
  return response;
}

function pathParameter(name: string, maxLength: number): Record<string, unknown> {
  return {
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength },
  };
}

function queryStringParameter(
  name: string,
  maxLength: number,
  pattern?: string
): Record<string, unknown> {
  return {
    name,
    in: 'query',
    schema: {
      type: 'string',
      minLength: 1,
      maxLength,
      ...(pattern ? { pattern } : {}),
    },
  };
}

function applySemanticSchemaConstraints(
  generatedSchemas: Record<string, unknown>
): void {
  const sourceGeneration = schemaObject(
    generatedSchemas,
    'SourceGenerationCreateRequestV1'
  );
  sourceGeneration.allOf = Object.entries(SOURCE_GENERATION_ITEM_LIMITS_V1).map(
    ([kind, maximum]) => ({
      properties: {
        capturedConstituents: {
          contains: {
            properties: {
              kind: { const: kind },
              itemCount: { maximum },
            },
            required: ['kind', 'itemCount'],
          },
          minContains: 1,
          maxContains: 1,
        },
        manifest: {
          contains: {
            properties: {
              kind: { const: kind },
              itemCount: { maximum },
            },
            required: ['kind', 'itemCount'],
          },
          minContains: 1,
          maxContains: 1,
        },
      },
    })
  );
  sourceGeneration['x-runtime-constraints'] = [
    'sourceAsOf equals the earliest captured constituent sourceAsOf instant',
    'manifest itemCount matches its captured constituent itemCount',
    'batchCount is zero exactly for an empty kind and otherwise can hold itemCount in batches of at most 250',
  ];

  const kindEntityConstraints = [
    ['recurringAmountChange', 'recurring'],
    ['largeTransaction', 'transaction'],
    ['categoryVariance', 'category'],
    ['merchantVariance', 'merchant'],
  ].map(([kind, entityKind]) => ({
    if: {
      properties: { kind: { const: kind } },
      required: ['kind'],
    },
    then: {
      properties: {
        entity: {
          properties: { kind: { const: entityKind } },
          required: ['kind'],
        },
      },
    },
  }));
  schemaObject(
    generatedSchemas,
    'InsightOccurrenceSummaryV1'
  ).allOf = kindEntityConstraints;
  schemaObject(
    generatedSchemas,
    'InsightOccurrenceDetailV1'
  ).allOf = kindEntityConstraints;
}

function applyUtcTimestampFormats(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) applyUtcTimestampFormats(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const object = value as Record<string, unknown>;
  if (
    typeof object.pattern === 'string' &&
    object.pattern.includes('T(?:\\d{2})') &&
    object.pattern.endsWith('Z$')
  ) {
    object.format = 'date-time';
  }
  for (const nested of Object.values(object)) {
    applyUtcTimestampFormats(nested);
  }
}

function applyStatusSpecificErrorSchemas(
  generatedSchemas: Record<string, unknown>
): void {
  const statuses = [...new Set(Object.values(INSIGHT_ERROR_STATUS_V1))];
  for (const status of statuses) {
    const codes = Object.entries(INSIGHT_ERROR_STATUS_V1)
      .filter(([, mappedStatus]) => mappedStatus === status)
      .map(([code]) => code);
    generatedSchemas[`InsightErrorResponse${status}V1`] = {
      allOf: [
        { $ref: '#/components/schemas/InsightErrorResponseV1' },
        {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { enum: codes },
              },
              required: ['code'],
            },
          },
          required: ['error'],
        },
      ],
    };
  }
}

function schemaObject(
  generatedSchemas: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const schema = generatedSchemas[name];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new TypeError(`Generated schema ${name} must be an object`);
  }
  return schema as Record<string, unknown>;
}

function queryArrayParameter(
  name: string,
  maxItems: number,
  values: readonly string[]
): Record<string, unknown> {
  return {
    name,
    in: 'query',
    explode: true,
    schema: {
      type: 'array',
      maxItems,
      uniqueItems: true,
      items: { type: 'string', enum: values },
    },
  };
}
