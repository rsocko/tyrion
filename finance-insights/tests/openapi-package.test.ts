import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFinanceInsightsOpenApiV1 } from '../src/openapi.js';

describe('executable contract and internal package boundary', () => {
  it('keeps the generated OpenAPI document synchronized with runtime schemas', async () => {
    const document = JSON.parse(
      await readFile(
        new URL('../../docs/finance-insights-service-v1.openapi.json', import.meta.url),
        'utf8'
      )
    );
    expect(document).toEqual(createFinanceInsightsOpenApiV1());
    expect(Object.keys(document.paths)).toHaveLength(10);
    expect(JSON.stringify(document)).not.toContain('monarch-bridge/contract.py');
  });

  it('documents strict DTO schemas and no server URL', () => {
    const document = createFinanceInsightsOpenApiV1() as {
      servers?: unknown;
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{
              name?: string;
              required?: boolean;
              schema?: {
                pattern?: string;
                items?: { enum?: string[] };
              };
            }>;
            responses?: Record<string, unknown>;
          }
        >
      >;
      components: {
        schemas: Record<string, { additionalProperties?: boolean }>;
      };
    };
    expect(document.servers).toBeUndefined();
    expect(
      document.components.schemas.SourceGenerationCreateRequestV1
        ?.additionalProperties
    ).toBe(false);
    expect(
      document.components.schemas.InsightOccurrenceDetailV1?.additionalProperties
    ).toBe(false);
    expect(
      document.components.schemas.DocumentExpectationSignalsV1
        ?.additionalProperties
    ).toBe(false);
    const expectationSignal = (
      document.components.schemas.DocumentExpectationSignalsV1 as {
        properties?: {
          signals?: {
            items?: {
              anyOf?: Array<{
                additionalProperties?: boolean;
                properties?: {
                  kind?: { const?: string };
                  basis?: { minItems?: number; maxItems?: number };
                  accountName?: { minLength?: number; maxLength?: number };
                  institutionName?: { minLength?: number; maxLength?: number };
                  accountType?: { enum?: string[] };
                  accountLastFour?: {
                    minLength?: number;
                    maxLength?: number;
                    pattern?: string;
                  };
                };
              }>;
              properties?: {
                basis?: { minItems?: number; maxItems?: number };
              };
            };
          };
        };
      }
    ).properties?.signals?.items;
    expect(expectationSignal?.anyOf).toHaveLength(2);
    expect(
       expectationSignal?.anyOf?.every(
         (variant) =>
           variant.additionalProperties === false &&
           variant.properties?.basis?.minItems === 1 &&
           variant.properties?.basis?.maxItems === 20
       )
    ).toBe(true);
    const accountSignalSchema = expectationSignal?.anyOf?.find(
       (variant) =>
         variant.properties?.kind?.const === 'accountStatementCandidate'
    );
    expect(accountSignalSchema?.properties?.accountName).toMatchObject({
       minLength: 1,
       maxLength: 120,
    });
    expect(accountSignalSchema?.properties?.institutionName).toMatchObject({
       minLength: 1,
       maxLength: 120,
    });
    expect(accountSignalSchema?.properties?.accountType?.enum).toEqual([
       'checking',
       'savings',
       'credit',
       'cash',
       'loan',
       'investment',
       'other',
    ]);
    expect(accountSignalSchema?.properties?.accountLastFour).toMatchObject({
       minLength: 4,
       maxLength: 4,
       pattern: '^[0-9]{4}$',
    });
    const recurringSignalSchema = expectationSignal?.anyOf?.find(
       (variant) =>
         variant.properties?.kind?.const === 'recurringDocumentCandidate'
    );
    expect(recurringSignalSchema?.properties).not.toHaveProperty('accountName');
    expect(recurringSignalSchema?.properties).not.toHaveProperty(
       'institutionName'
    );
    expect(recurringSignalSchema?.properties).not.toHaveProperty('accountType');
    expect(recurringSignalSchema?.properties).not.toHaveProperty(
       'accountLastFour'
    );
    expect(JSON.stringify(document)).not.toContain(
      '"minimum":-9007199254740991'
    );
    expect(
      (
        document.components.schemas.SourceGenerationCreateRequestV1 as {
          allOf?: unknown[];
          'x-runtime-constraints'?: string[];
        }
      ).allOf
    ).toHaveLength(5);
    expect(
      (
        document.components.schemas.SourceGenerationCreateRequestV1 as {
          'x-runtime-constraints'?: string[];
        }
      )['x-runtime-constraints']
    ).toContain(
      'batchCount is zero exactly for an empty kind and otherwise can hold itemCount in batches of at most 250'
    );
    expect(
      (
        document.components.schemas.InsightOccurrenceSummaryV1 as {
          allOf?: unknown[];
        }
      ).allOf
    ).toHaveLength(4);
    const listOperation =
      document.paths['/api/internal/v1/finance/insights/occurrences']!.get!;
    expect(listOperation.responses).toHaveProperty('422');
    const retryResponse = listOperation.responses?.['429'] as {
      headers?: {
        'Retry-After'?: {
          required?: boolean;
          schema?: { minimum?: number; maximum?: number };
        };
      };
    };
    expect(retryResponse.headers?.['Retry-After']).toMatchObject({
      required: true,
      schema: { minimum: 1, maximum: 300 },
    });
    expect(
      listOperation.parameters?.find((parameter) => parameter.name === 'kind')
        ?.schema?.items?.enum
    ).toEqual([
      'recurringAmountChange',
      'largeTransaction',
      'categoryVariance',
      'merchantVariance',
    ]);
    expect(
      listOperation.parameters?.find(
        (parameter) => parameter.name === 'connectorRef'
      )?.schema?.pattern
    ).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]*$');
    const expectationOperation =
      document.paths[
        '/api/internal/v1/finance/insights/document-expectation-signals/{generationId}'
      ]!.get!;
    expect(
      expectationOperation.parameters?.find(
        (parameter) => parameter.name === 'connectorRef'
      )
    ).toMatchObject({
      required: true,
      schema: { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
    });
    const timestampSchemas = collectTimestampSchemas(
      document.components.schemas
    );
    expect(timestampSchemas.length).toBeGreaterThan(10);
    expect(
      timestampSchemas.every((schema) => schema.format === 'date-time')
    ).toBe(true);
    const error400 = document.components.schemas.InsightErrorResponse400V1 as {
      allOf?: Array<{
        properties?: {
          error?: {
            properties?: {
              code?: { enum?: string[] };
            };
          };
        };
      }>;
    };
    const statusCodes =
      error400.allOf?.[1]?.properties?.error?.properties?.code?.enum;
    expect(statusCodes).toContain('invalid_request');
    expect(statusCodes).not.toContain('insight_operation_failed');
  });

  it('cannot be published and exposes only reviewed internal entry points', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      name: string;
      version: string;
      private: boolean;
      publishConfig?: unknown;
      exports: Record<string, unknown>;
    };
    expect(manifest).toMatchObject({
      name: '@rsocko/tyrion-finance-insights',
      version: '1.0.0',
      private: true,
    });
    expect(manifest.publishConfig).toBeUndefined();
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './automation',
      './contracts/v1',
      './core',
      './detectors',
      './evidence',
      './inquiry',
      './mutations',
      './persistence',
      './policy',
      './ports',
      './projection',
      './services',
    ]);
  });
});

function collectTimestampSchemas(
  value: unknown
): Array<{ pattern: string; format?: string }> {
  if (Array.isArray(value)) {
    return value.flatMap(collectTimestampSchemas);
  }
  if (typeof value !== 'object' || value === null) return [];
  const object = value as Record<string, unknown>;
  const current =
    typeof object.pattern === 'string' &&
    object.pattern.includes('T(?:\\d{2})') &&
    object.pattern.endsWith('Z$')
      ? [
          {
            pattern: object.pattern,
            format:
              typeof object.format === 'string' ? object.format : undefined,
          },
        ]
      : [];
  return [
    ...current,
    ...Object.values(object).flatMap(collectTimestampSchemas),
  ];
}
