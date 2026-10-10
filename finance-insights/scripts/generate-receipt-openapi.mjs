import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReceiptEvidenceOpenApiV1 } from '../dist/receipt/openapi-v1.js';

await writeFile(
  resolve('../docs/receipt-evidence-service-v1.openapi.json'),
  `${JSON.stringify(createReceiptEvidenceOpenApiV1(), null, 2)}\n`,
  'utf8'
);
