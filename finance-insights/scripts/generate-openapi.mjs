import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFinanceInsightsOpenApiV1 } from '../dist/openapi.js';

const output = fileURLToPath(
  new URL('../../docs/finance-insights-service-v1.openapi.json', import.meta.url)
);
await writeFile(
  output,
  `${JSON.stringify(createFinanceInsightsOpenApiV1(), null, 2)}\n`,
  'utf8'
);
