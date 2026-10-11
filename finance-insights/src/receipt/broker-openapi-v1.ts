export function createReceiptBrokerOpenApiV1(): Record<string, unknown> {
  const error = {
    description: 'Sanitized broker failure',
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
                code: { type: 'string', maxLength: 80 },
                message: { type: 'string', maxLength: 160 },
              },
            },
          },
        },
      },
    },
  };
  const response = {
    description: 'Bounded Monarch receipt broker status and evidence',
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/ReceiptBrokerResponseV1',
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tyrion Receipt Broker',
      version: '1.0.0',
      description:
        'Private broker-only creation and reconciliation of one Monarch receipt for an already-canonical OWL document.',
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/internal/v1/finance/receipt-broker/replicas': {
        post: {
          operationId: 'submitReceiptBrokerReplicaV1',
          summary: 'Create or return one idempotent Monarch receipt replica',
          parameters: [
            idempotencyKeyHeader(),
            referenceHeader('X-OWL-Canonical-Document-Ref'),
            referenceHeader('X-OWL-Source-Ref'),
            expectedRevisionHeader(false),
          ],
          requestBody: {
            required: true,
            content: Object.fromEntries(
              ['application/pdf', 'image/jpeg', 'image/png'].map(
                (mediaType) => [
                  mediaType,
                  {
                    schema: {
                      type: 'string',
                      format: 'binary',
                      maxLength: 2_097_152,
                    },
                  },
                ]
              )
            ),
          },
          responses: {
            '200': response,
            '201': response,
            '202': response,
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
      '/api/internal/v1/finance/receipt-broker/replicas/{idempotencyKey}/reconcile':
        {
          post: {
            operationId: 'reconcileReceiptBrokerReplicaV1',
            summary:
              'Read authoritative Monarch evidence without creating a replacement',
            parameters: [
              {
                name: 'idempotencyKey',
                in: 'path',
                required: true,
                schema: referenceSchema(16),
              },
              expectedRevisionHeader(false),
            ],
            responses: {
              '200': response,
              '202': response,
              '401': error,
              '403': error,
              '404': error,
              '409': error,
              '422': error,
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
        ReceiptBrokerResponseV1: {
          type: 'object',
          additionalProperties: false,
          required: [
            'brokerContractVersion',
            'idempotencyKey',
            'outcome',
            'acknowledged',
            'retrySafe',
            'reconcileRequired',
            'replicaRef',
            'replicaLifecycle',
            'revision',
            'nativeEvidence',
            'reasonCodes',
          ],
          properties: {
            brokerContractVersion: { const: '1.0' },
            idempotencyKey: referenceSchema(16),
            outcome: {
              enum: [
                'acknowledged',
                'processing',
                'duplicate',
                'retryable',
                'unknown',
              ],
            },
            acknowledged: { type: 'boolean' },
            retrySafe: { type: 'boolean' },
            reconcileRequired: { type: 'boolean' },
            replicaRef: { type: ['string', 'null'], maxLength: 160 },
            replicaLifecycle: { type: 'string', maxLength: 32 },
            revision: { type: 'integer', minimum: 0 },
            nativeEvidence: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'receiptSource',
                    'receiptState',
                    'transactionRef',
                    'attachmentCount',
                    'sourceAsOf',
                    'observedAt',
                  ],
                  properties: {
                    receiptSource: { enum: ['upload', 'email'] },
                    receiptState: {
                      enum: [
                        'processing',
                        'awaiting_match',
                        'matched',
                        'failed',
                      ],
                    },
                    transactionRef: {
                      type: ['string', 'null'],
                      maxLength: 160,
                      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
                    },
                    attachmentCount: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 8,
                    },
                    sourceAsOf: {
                      type: ['string', 'null'],
                      format: 'date-time',
                    },
                    observedAt: {
                      type: 'string',
                      format: 'date-time',
                    },
                  },
                },
              ],
            },
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

function idempotencyKeyHeader() {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: referenceSchema(16),
  };
}

function referenceHeader(name: string) {
  return {
    name,
    in: 'header',
    required: true,
    schema: referenceSchema(1),
  };
}

function referenceSchema(minLength: number) {
  return {
    type: 'string',
    minLength,
    maxLength: 160,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
  };
}

function expectedRevisionHeader(required: boolean) {
  return {
    name: 'X-Tyrion-Expected-Revision',
    in: 'header',
    required,
    schema: { type: 'integer', minimum: 0, maximum: 9_999_999_999 },
  };
}
