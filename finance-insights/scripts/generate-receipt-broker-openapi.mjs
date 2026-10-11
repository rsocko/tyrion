import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReceiptBrokerOpenApiV1 } from '../dist/receipt/index.js';

const target = resolve(
  process.cwd(),
  '..',
  'docs',
  'receipt-broker-v1.openapi.json'
);
await writeFile(
  target,
  `${JSON.stringify(createReceiptBrokerOpenApiV1(), null, 2)}\n`,
  'utf8'
);
