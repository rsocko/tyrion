export function createReceiptEvidenceOpenApiV1(): Record<string, unknown> {
  const error = {
    description: 'Sanitized receipt evidence failure',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tyrion Receipt Evidence Service',
      version: '1.0.0',
      description:
        'Private fixed-authority orchestration for OWL canonical receipt intake and bounded Monarch replica evidence.',
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/internal/v1/finance/receipt-evidence/occurrences': {
        post: {
          operationId: 'submitReceiptEvidenceV1',
          summary:
            'Stream one OWL occurrence to canonical intake, then conditionally create one Monarch replica',
          parameters: receiptHeaders(),
          requestBody: {
            required: true,
            content: Object.fromEntries(
              [
                'application/pdf',
                'image/jpeg',
                'image/png',
                'image/tiff',
              ].map((mediaType) => [
                mediaType,
                { schema: { type: 'string', format: 'binary' } },
              ])
            ),
          },
          responses: {
            '202': jsonResponse(),
            '401': error,
            '403': error,
            '409': error,
            '413': error,
            '415': error,
            '422': error,
            '503': error,
          },
        },
      },
      '/api/internal/v1/finance/receipt-evidence/occurrences/{intakeRef}': {
        get: {
          operationId: 'getReceiptEvidenceV1',
          parameters: [intakeRefParameter()],
          responses: {
            '200': jsonResponse(),
            '401': error,
            '403': error,
            '404': error,
            '503': error,
          },
        },
      },
      '/api/internal/v1/finance/receipt-evidence/occurrences/{intakeRef}/reconcile':
        {
          post: {
            operationId: 'reconcileReceiptEvidenceV1',
            parameters: [intakeRefParameter()],
            responses: {
              '200': jsonResponse(),
              '401': error,
              '403': error,
              '404': error,
              '503': error,
            },
          },
        },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        ReceiptEvidenceResponseV1: {
          type: 'object',
          additionalProperties: false,
          required: [
            'receiptContractVersion',
            'intake',
            'replicaRef',
            'replicaLifecycle',
            'revision',
            'nativeEvidence',
            'reviewRequired',
            'reasonCodes',
          ],
          properties: {
            receiptContractVersion: { const: '1.0' },
            intake: { type: 'object' },
            replicaRef: { type: ['string', 'null'], maxLength: 160 },
            replicaLifecycle: { type: 'string' },
            revision: { type: 'integer', minimum: 0 },
            nativeEvidence: { type: ['object', 'null'] },
            reviewRequired: { type: 'boolean' },
            reasonCodes: {
              type: 'array',
              maxItems: 12,
              items: { type: 'string', maxLength: 80 },
            },
          },
        },
      },
    },
  };
}

function receiptHeaders(): Record<string, unknown>[] {
  return [
    header('X-OWL-Source-Channel', true),
    header('X-OWL-Source-Occurrence', true, '^[a-f0-9]{64}$'),
    header('X-OWL-Source-Occurrence-Version', false),
    header('X-OWL-Connector-Ref', false),
    header('X-OWL-Source-Observed-At', false),
    header('X-OWL-Transform-Version', false),
    header('X-OWL-Normalized-Fingerprint', false, '^[a-f0-9]{64}$'),
    header('X-OWL-Normalized-Version', false),
    header('X-OWL-Semantic-Fingerprint', false, '^[a-f0-9]{64}$'),
    header('X-OWL-Semantic-Version', false),
  ];
}

function header(name: string, required: boolean, pattern?: string) {
  return {
    name,
    in: 'header',
    required,
    schema: { type: 'string', ...(pattern ? { pattern } : {}) },
  };
}

function intakeRefParameter() {
  return {
    name: 'intakeRef',
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 160 },
  };
}

function jsonResponse() {
  return {
    description: 'Bounded receipt evidence',
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/ReceiptEvidenceResponseV1',
        },
      },
    },
  };
}
