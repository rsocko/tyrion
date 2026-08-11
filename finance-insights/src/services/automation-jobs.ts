import type { CanonicalJsonValue } from '../core/canonical.js';
import { canonicalDigestV1 } from '../core/canonical.js';
import {
  parseFinanceAutomationDeliveryAckRequestV1,
  parseFinanceAutomationJobRequestV1,
  type FinanceAutomationDeliveryAckRequestV1,
  type FinanceAutomationDeliveryAckResultV1,
  type FinanceAutomationJobRequestV1,
  type FinanceAutomationJobResultV1,
} from '../automation/contracts-v1.js';
import { normalizeFinanceAutomationJobRequestV1 } from '../automation/canonical-input-v1.js';
import { evaluateFinanceAutomationJobV1 } from '../automation/evaluators-v1.js';
import type { FinanceAutomationSqliteStoreV1 } from '../persistence/automation-store.js';

export interface FinanceAutomationJobServiceOptionsV1 {
  readonly store: FinanceAutomationSqliteStoreV1;
  readonly identityKey: Uint8Array;
}

export class FinanceAutomationJobServiceV1 {
  private readonly store: FinanceAutomationSqliteStoreV1;
  private readonly identityKey: Uint8Array;

  constructor(options: FinanceAutomationJobServiceOptionsV1) {
    if (options.identityKey.byteLength < 32) {
      throw new RangeError(
        'Finance automation identity key must contain at least 32 bytes'
      );
    }
    this.store = options.store;
    this.identityKey = Uint8Array.from(options.identityKey);
  }

  async run(
    input: FinanceAutomationJobRequestV1
  ): Promise<FinanceAutomationJobResultV1> {
    const request = parseFinanceAutomationJobRequestV1(input);
    const requestDigest = durableRequestDigestV1(
      normalizeFinanceAutomationJobRequestV1(request)
    );
    const plan = evaluateFinanceAutomationJobV1(request, this.identityKey);
    return this.store.applyEvaluation(requestDigest, plan);
  }

  async acknowledgeDeliveries(
    input: FinanceAutomationDeliveryAckRequestV1
  ): Promise<FinanceAutomationDeliveryAckResultV1> {
    return this.store.acknowledgeDeliveries(
      parseFinanceAutomationDeliveryAckRequestV1(input)
    );
  }
}

function durableRequestDigestV1(
  request: FinanceAutomationJobRequestV1
): string {
  const { evaluatedAt: _evaluatedAt, ...durableInput } = request;
  return canonicalDigestV1(durableInput as CanonicalJsonValue);
}
