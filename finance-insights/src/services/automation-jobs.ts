import { randomUUID } from 'node:crypto';
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
import { FinanceAutomationJobInProgressError } from '../persistence/automation-store.js';

const DEFAULT_LEASE_SECONDS_V1 = 5 * 60;

export type FinanceAutomationTelemetryEventV1 =
  | {
      readonly name: 'automation_job_started';
      readonly jobKind: FinanceAutomationJobRequestV1['jobKind'];
    }
  | {
      readonly name: 'automation_job_completed';
      readonly jobKind: FinanceAutomationJobRequestV1['jobKind'];
      readonly status: FinanceAutomationJobResultV1['status'];
      readonly replayed: boolean;
      readonly signalCount: number;
      readonly deliveryCount: number;
    }
  | {
      readonly name: 'automation_job_rejected';
      readonly jobKind: FinanceAutomationJobRequestV1['jobKind'];
      readonly code: 'job_in_progress';
    }
  | {
      readonly name: 'automation_job_failed';
      readonly jobKind: FinanceAutomationJobRequestV1['jobKind'];
      readonly code: 'idempotency_conflict' | 'operation_failed';
    };

export interface FinanceAutomationTelemetrySinkV1 {
  emit(event: FinanceAutomationTelemetryEventV1): void;
}

export interface FinanceAutomationJobServiceOptionsV1 {
  readonly store: FinanceAutomationSqliteStoreV1;
  readonly identityKey: Uint8Array;
  readonly clock?: () => Date;
  readonly leaseSeconds?: number;
  readonly telemetry?: FinanceAutomationTelemetrySinkV1;
}

export class FinanceAutomationJobServiceV1 {
  private readonly store: FinanceAutomationSqliteStoreV1;
  private readonly identityKey: Uint8Array;
  private readonly clock: () => Date;
  private readonly leaseSeconds: number;
  private readonly telemetry: FinanceAutomationTelemetrySinkV1 | undefined;

  constructor(options: FinanceAutomationJobServiceOptionsV1) {
    if (options.identityKey.byteLength < 32) {
      throw new RangeError(
        'Finance automation identity key must contain at least 32 bytes'
      );
    }
    if (
      options.leaseSeconds !== undefined &&
      (!Number.isInteger(options.leaseSeconds) ||
        options.leaseSeconds < 30 ||
        options.leaseSeconds > 30 * 60)
    ) {
      throw new RangeError(
        'Finance automation lease must be between 30 and 1800 seconds'
      );
    }
    this.store = options.store;
    this.identityKey = Uint8Array.from(options.identityKey);
    this.clock = options.clock ?? (() => new Date());
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS_V1;
    this.telemetry = options.telemetry;
  }

  async run(
    input: FinanceAutomationJobRequestV1
  ): Promise<FinanceAutomationJobResultV1> {
    const request = parseFinanceAutomationJobRequestV1(input);
    const requestDigest = durableRequestDigestV1(
      normalizeFinanceAutomationJobRequestV1(request)
    );
    const plan = evaluateFinanceAutomationJobV1(request, this.identityKey);
    const acquiredAt = this.clock();
    const lease = {
      connectorRef: request.connectorRef,
      jobKind: request.jobKind,
      ownerToken: randomUUID(),
    };
    const acquired = this.store.acquireJobLease({
      ...lease,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(
        acquiredAt.getTime() + this.leaseSeconds * 1_000
      ).toISOString(),
    });
    if (!acquired) {
      this.emit({
        name: 'automation_job_rejected',
        jobKind: request.jobKind,
        code: 'job_in_progress',
      });
      throw new FinanceAutomationJobInProgressError();
    }
    this.emit({ name: 'automation_job_started', jobKind: request.jobKind });
    try {
      const result = this.store.applyEvaluation(requestDigest, plan);
      this.emit({
        name: 'automation_job_completed',
        jobKind: request.jobKind,
        status: result.status,
        replayed: result.replayed,
        signalCount: result.signals.length,
        deliveryCount: result.deliveries.length,
      });
      return result;
    } catch (error) {
      this.emit({
        name: 'automation_job_failed',
        jobKind: request.jobKind,
        code:
          error instanceof Error &&
          error.name === 'FinanceAutomationIdempotencyConflictError'
            ? 'idempotency_conflict'
            : 'operation_failed',
      });
      throw error;
    } finally {
      this.store.releaseJobLease(lease);
    }
  }

  async acknowledgeDeliveries(
    input: FinanceAutomationDeliveryAckRequestV1
  ): Promise<FinanceAutomationDeliveryAckResultV1> {
    return this.store.acknowledgeDeliveries(
      parseFinanceAutomationDeliveryAckRequestV1(input)
    );
  }

  private emit(event: FinanceAutomationTelemetryEventV1): void {
    try {
      this.telemetry?.emit(event);
    } catch {
      // Metadata-only telemetry must not alter durable automation state.
    }
  }
}

function durableRequestDigestV1(
  request: FinanceAutomationJobRequestV1
): string {
  const { evaluatedAt: _evaluatedAt, ...durableInput } = request;
  return canonicalDigestV1(durableInput as CanonicalJsonValue);
}
