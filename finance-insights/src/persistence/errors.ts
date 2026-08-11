import {
  createInsightErrorV1,
  type InsightErrorCodeV1,
  type InsightErrorDescriptorV1,
} from '../contracts/errors-v1.js';

export class FinanceInsightStoreError extends Error {
  readonly descriptor: InsightErrorDescriptorV1;

  constructor(code: InsightErrorCodeV1) {
    const descriptor =
      code === 'evaluation_in_progress'
        ? createInsightErrorV1(code, 30)
        : createInsightErrorV1(code);
    super(descriptor.body.error.message);
    this.name = 'FinanceInsightStoreError';
    this.descriptor = descriptor;
  }
}

export function storeError(code: InsightErrorCodeV1): never {
  throw new FinanceInsightStoreError(code);
}

export function isFinanceInsightStoreError(
  value: unknown
): value is FinanceInsightStoreError {
  return value instanceof FinanceInsightStoreError;
}
