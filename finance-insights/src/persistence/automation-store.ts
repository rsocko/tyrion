import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type {
  FinanceAutomationDeliveryAckRequestV1,
  FinanceAutomationDeliveryAckResultV1,
  FinanceAutomationDeliveryV1,
  FinanceAutomationJobResultV1,
  FinanceAutomationSignalV1,
} from '../automation/contracts-v1.js';
import type {
  FinanceAutomationEvaluationPlanV1,
  FinanceAutomationSignalDraftV1,
} from '../automation/evaluators-v1.js';
import { rebaseConnectorHealthPlanV1 } from '../automation/evaluators-v1.js';
import { automationDeliveryKeyV1 } from '../automation/identity-v1.js';
import { migrateFinanceInsightStoreV1 } from './migrations.js';

export interface FinanceAutomationStoreOptionsV1 {
  readonly path: string;
}

interface SignalRowV1 {
  signal_id: string;
  kind: FinanceAutomationSignalV1['kind'];
  connector_ref: string;
  state: FinanceAutomationSignalV1['state'];
  attention: FinanceAutomationSignalV1['attention'];
  fingerprint: string;
  signal_json: string;
  opened_at: string;
  updated_at: string;
  settled_at: string | null;
}

interface RunRowV1 {
  request_digest: string;
  result_json: string;
}

interface JobWatermarkRowV1 {
  latest_observed_at: string;
  latest_scheduled_for: string | null;
  latest_source_as_of: string | null;
  latest_source_sequence: number | null;
  latest_source_generation: string | null;
  observation_digest: string;
}

interface DeliveryOutboxRowV1 {
  delivery_json: string;
  version: number;
  action: FinanceAutomationDeliveryV1['action'];
  acknowledged_at: string | null;
}

export class FinanceAutomationIdempotencyConflictError extends Error {
  readonly code = 'automation_idempotency_conflict';

  constructor() {
    super('A scheduled automation run already exists with different input');
    this.name = 'FinanceAutomationIdempotencyConflictError';
  }
}

export class FinanceAutomationSqliteStoreV1 {
  private readonly database: Database.Database;

  constructor(options: FinanceAutomationStoreOptionsV1) {
    if (!isAbsolute(options.path) || options.path === ':memory:') {
      throw new RangeError(
        'Finance automation state path must be an absolute external file path'
      );
    }
    const path = resolve(options.path);
    const stateDirectory = dirname(path);
    const createdDirectory = mkdirSync(stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    if (createdDirectory !== undefined && process.platform !== 'win32') {
      chmodSync(stateDirectory, 0o700);
    }

    const database = new Database(path);
    try {
      restrictAutomationStateFilesV1(path);
      migrateFinanceInsightStoreV1(database, new Date().toISOString());
      restrictAutomationStateFilesV1(path);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
  }

  close(): void {
    this.database.close();
  }

  applyEvaluation(
    requestDigest: string,
    plan: FinanceAutomationEvaluationPlanV1
  ): FinanceAutomationJobResultV1 {
    return this.database.transaction(() => {
      const existingRun = this.database
        .prepare(
          `SELECT request_digest, result_json
           FROM finance_automation_job_runs
           WHERE run_id = ?`
        )
        .get(plan.runId) as RunRowV1 | undefined;
      if (existingRun) {
        if (existingRun.request_digest !== requestDigest) {
          throw new FinanceAutomationIdempotencyConflictError();
        }
        const prior = JSON.parse(
          existingRun.result_json
        ) as FinanceAutomationJobResultV1;
        return {
          ...prior,
          deliveries: this.pendingDeliveries(prior.connectorRef),
          replayed: true,
        };
      }

      const outOfOrderReason = this.outOfOrderReason(plan);
      const effectivePlan =
        outOfOrderReason === null
          ? this.rebaseHealthFreshness(plan)
          : plan;
      const signals: FinanceAutomationSignalV1[] = [];
      if (outOfOrderReason === null && effectivePlan.status === 'completed') {
        this.recordWatermark(effectivePlan);
        for (const draft of effectivePlan.desiredSignals) {
          signals.push(this.upsertSignal(effectivePlan, draft));
        }
        if (effectivePlan.settleAbsent) {
          const desiredIds = new Set(
            effectivePlan.desiredSignals.map((signal) => signal.signalId)
          );
          for (const row of this.openSignalRows(effectivePlan)) {
            if (desiredIds.has(row.signal_id)) continue;
            if (!this.canSettleSignal(effectivePlan, row)) continue;
            signals.push(this.settleSignal(effectivePlan, row));
          }
        }
      }

      const result: FinanceAutomationJobResultV1 = {
        contractVersion: '1.0',
        runId: plan.runId,
        jobKind: effectivePlan.jobKind,
        connectorRef: effectivePlan.connectorRef,
        scheduledFor: effectivePlan.scheduledFor,
        status: outOfOrderReason === null ? effectivePlan.status : 'ignored',
        skipReason: outOfOrderReason ?? effectivePlan.skipReason,
        sourceAsOf: effectivePlan.sourceAsOf,
        candidateCount:
          outOfOrderReason === null ? effectivePlan.candidateCount : 0,
        exclusionSummary: effectivePlan.exclusionSummary,
        signals: signals.sort((left, right) =>
          left.signalId.localeCompare(right.signalId)
        ),
        deliveries: this.pendingDeliveries(effectivePlan.connectorRef),
        replayed: false,
        completedAt: plan.completedAt,
      };
      this.database
        .prepare(
          `INSERT INTO finance_automation_job_runs(
             run_id, job_kind, connector_ref, scheduled_for, request_digest,
             source_as_of, completed_at, result_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          effectivePlan.runId,
          effectivePlan.jobKind,
          effectivePlan.connectorRef,
          effectivePlan.scheduledFor,
          requestDigest,
          effectivePlan.sourceAsOf,
          effectivePlan.completedAt,
          JSON.stringify(result)
        );
      return result;
    }).immediate();
  }

  acknowledgeDeliveries(
    request: FinanceAutomationDeliveryAckRequestV1
  ): FinanceAutomationDeliveryAckResultV1 {
    return this.database.transaction(() => {
      const acknowledged: string[] = [];
      const conflicts: string[] = [];
      for (const delivery of request.deliveries) {
        const row = this.database
          .prepare(
            `SELECT version, action, acknowledged_at
             FROM finance_automation_delivery_outbox
             WHERE delivery_key = ?`
          )
          .get(delivery.deliveryKey) as DeliveryOutboxRowV1 | undefined;
        if (!row || row.version !== delivery.expectedVersion) {
          conflicts.push(delivery.deliveryKey);
          continue;
        }
        if (row.acknowledged_at === null) {
          this.database
            .prepare(
              `UPDATE finance_automation_delivery_outbox
               SET acknowledged_at = ?, updated_at = ?
               WHERE delivery_key = ? AND version = ? AND acknowledged_at IS NULL`
            )
            .run(
              request.acknowledgedAt,
              request.acknowledgedAt,
              delivery.deliveryKey,
              delivery.expectedVersion
            );
        }
        acknowledged.push(delivery.deliveryKey);
      }
      const result: FinanceAutomationDeliveryAckResultV1 = {
        contractVersion: '1.0',
        acknowledged: acknowledged.sort(),
        conflicts: conflicts.sort(),
      };
      return result;
    }).immediate();
  }

  getSignal(signalId: string): FinanceAutomationSignalV1 | null {
    const row = this.database
      .prepare(
        `SELECT signal_id, kind, connector_ref, state, attention, fingerprint,
                signal_json, opened_at, updated_at, settled_at
         FROM finance_automation_signals
         WHERE signal_id = ?`
      )
      .get(signalId) as SignalRowV1 | undefined;
    return row ? parseStoredSignal(row) : null;
  }

  private outOfOrderReason(
    plan: FinanceAutomationEvaluationPlanV1
  ):
    | 'out_of_order_observation'
    | 'out_of_order_source_generation'
    | null {
    const current = this.database
      .prepare(
        `SELECT latest_observed_at, latest_scheduled_for, latest_source_as_of,
                latest_source_sequence, latest_source_generation,
                observation_digest
         FROM finance_automation_job_watermarks
         WHERE connector_ref = ? AND job_kind = ?`
      )
      .get(plan.connectorRef, plan.jobKind) as JobWatermarkRowV1 | undefined;
    if (!current) return null;
    if (plan.jobKind === 'connectorHealth') {
      const observationOrdering =
        Date.parse(plan.observedAt) - Date.parse(current.latest_observed_at);
      const scheduleOrdering =
        current.latest_scheduled_for === null
          ? 0
          : Date.parse(plan.scheduledFor) -
            Date.parse(current.latest_scheduled_for);
      return observationOrdering < 0 ||
        (observationOrdering === 0 &&
          (scheduleOrdering < 0 ||
            plan.inputFingerprint !== current.observation_digest))
        ? 'out_of_order_observation'
        : null;
    }
    if (
      plan.sourceSequence === null ||
      current.latest_source_sequence === null ||
      plan.sourceSequence < current.latest_source_sequence ||
      (plan.sourceSequence === current.latest_source_sequence &&
        (plan.sourceGeneration !== current.latest_source_generation ||
          plan.inputFingerprint !== current.observation_digest))
    ) {
      return 'out_of_order_source_generation';
    }
    return null;
  }

  private rebaseHealthFreshness(
    plan: FinanceAutomationEvaluationPlanV1
  ): FinanceAutomationEvaluationPlanV1 {
    if (plan.jobKind !== 'connectorHealth') return plan;
    const current = this.database
      .prepare(
        `SELECT latest_observed_at, latest_scheduled_for, latest_source_as_of,
                latest_source_sequence, latest_source_generation,
                observation_digest
         FROM finance_automation_job_watermarks
         WHERE connector_ref = ? AND job_kind = 'connectorHealth'`
      )
      .get(plan.connectorRef) as JobWatermarkRowV1 | undefined;
    return rebaseConnectorHealthPlanV1(
      plan,
      laterTimestamp(current?.latest_source_as_of ?? null, plan.sourceAsOf)
    );
  }

  private recordWatermark(plan: FinanceAutomationEvaluationPlanV1): void {
    const current = this.database
      .prepare(
        `SELECT latest_observed_at, latest_scheduled_for, latest_source_as_of,
                latest_source_sequence, latest_source_generation,
                observation_digest
         FROM finance_automation_job_watermarks
         WHERE connector_ref = ? AND job_kind = ?`
      )
      .get(plan.connectorRef, plan.jobKind) as JobWatermarkRowV1 | undefined;
    const latestSourceAsOf = laterTimestamp(
      current?.latest_source_as_of ?? null,
      plan.sourceAsOf
    );
    const latestScheduledFor = laterTimestamp(
      current?.latest_scheduled_for ?? null,
      plan.scheduledFor
    );
    this.database
      .prepare(
        `INSERT INTO finance_automation_job_watermarks(
           connector_ref, job_kind, latest_observed_at, latest_scheduled_for,
           latest_source_as_of,
           latest_source_sequence, latest_source_generation,
           observation_digest, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connector_ref, job_kind) DO UPDATE SET
           latest_observed_at = excluded.latest_observed_at,
           latest_scheduled_for = excluded.latest_scheduled_for,
           latest_source_as_of = excluded.latest_source_as_of,
           latest_source_sequence = excluded.latest_source_sequence,
           latest_source_generation = excluded.latest_source_generation,
           observation_digest = excluded.observation_digest,
           updated_at = excluded.updated_at`
      )
      .run(
        plan.connectorRef,
        plan.jobKind,
        plan.observedAt,
        latestScheduledFor,
        latestSourceAsOf,
        plan.sourceSequence,
        plan.sourceGeneration,
        plan.inputFingerprint,
        plan.completedAt
      );
  }

  private upsertSignal(
    plan: FinanceAutomationEvaluationPlanV1,
    draft: FinanceAutomationSignalDraftV1
  ): FinanceAutomationSignalV1 {
    const existing = this.database
      .prepare(
        `SELECT signal_id, kind, connector_ref, state, attention, fingerprint,
                signal_json, opened_at, updated_at, settled_at
         FROM finance_automation_signals
         WHERE signal_id = ?`
      )
      .get(draft.signalId) as SignalRowV1 | undefined;
    const reopened = existing?.state === 'settled';
    const materiallyChanged =
      existing !== undefined && existing.fingerprint !== draft.fingerprint;
    const openedAt =
      existing === undefined || reopened ? plan.completedAt : existing.opened_at;
    const signal: FinanceAutomationSignalV1 = {
      contractVersion: '1.0',
      signalId: draft.signalId,
      kind: draft.kind,
      connectorRef: draft.connectorRef,
      state: 'open',
      severity: draft.severity,
      confidence: draft.confidence,
      attention: draft.attention,
      reasonCodes: draft.reasonCodes,
      relatedSourceRefs: draft.relatedSourceRefs,
      evidence: draft.evidence,
      freshness: draft.freshness,
      provenance: draft.provenance,
      openedAt,
      updatedAt: plan.completedAt,
      settledAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO finance_automation_signals(
           signal_id, kind, connector_ref, state, attention, fingerprint,
           signal_json, opened_at, updated_at, settled_at
         ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(signal_id) DO UPDATE SET
           state = 'open',
           attention = excluded.attention,
           fingerprint = excluded.fingerprint,
           signal_json = excluded.signal_json,
           opened_at = excluded.opened_at,
           updated_at = excluded.updated_at,
           settled_at = NULL`
      )
      .run(
        signal.signalId,
        signal.kind,
        signal.connectorRef,
        signal.attention,
        draft.fingerprint,
        JSON.stringify(signal),
        signal.openedAt,
        signal.updatedAt
      );

    const action =
      existing === undefined ? 'create' : reopened ? 'reopen' : materiallyChanged ? 'update' : null;
    if (action !== null) {
      this.recordEvent(signal.signalId, action, plan);
      this.queueDelivery(
        signal,
        action === 'reopen' ? 'create' : action,
        plan
      );
    }
    return signal;
  }

  private settleSignal(
    plan: FinanceAutomationEvaluationPlanV1,
    row: SignalRowV1
  ): FinanceAutomationSignalV1 {
    const current = parseStoredSignal(row);
    const signal: FinanceAutomationSignalV1 = {
      ...current,
      state: 'settled',
      reasonCodes: current.reasonCodes.includes('condition_recovered')
        ? current.reasonCodes
        : [...current.reasonCodes, 'condition_recovered'],
      freshness: plan.sourceAsOf === null ? current.freshness : 'fresh',
      provenance: {
        ...current.provenance,
        sourceGeneration: plan.sourceGeneration,
        sourceAsOf: plan.sourceAsOf,
        observedAt: plan.observedAt,
        evaluatedAt: plan.completedAt,
        bridgeContractVersion: plan.bridgeContractVersion,
      },
      updatedAt: plan.completedAt,
      settledAt: plan.completedAt,
    };
    this.database
      .prepare(
        `UPDATE finance_automation_signals
         SET state = 'settled', signal_json = ?, updated_at = ?, settled_at = ?
         WHERE signal_id = ? AND state = 'open'`
      )
      .run(
        JSON.stringify(signal),
        plan.completedAt,
        plan.completedAt,
        signal.signalId
      );
    this.recordEvent(signal.signalId, 'settle', plan);
    this.queueDelivery(signal, 'settle', plan);
    return signal;
  }

  private openSignalRows(
    plan: FinanceAutomationEvaluationPlanV1
  ): SignalRowV1[] {
    const kind =
      plan.jobKind === 'duplicateTransactions'
        ? 'duplicateTransaction'
        : 'connectorHealth';
    return this.database
      .prepare(
        `SELECT signal_id, kind, connector_ref, state, attention, fingerprint,
                signal_json, opened_at, updated_at, settled_at
         FROM finance_automation_signals
         WHERE connector_ref = ? AND kind = ? AND state = 'open'
         ORDER BY signal_id`
      )
      .all(plan.connectorRef, kind) as SignalRowV1[];
  }

  private canSettleSignal(
    plan: FinanceAutomationEvaluationPlanV1,
    row: SignalRowV1
  ): boolean {
    if (plan.jobKind !== 'duplicateTransactions') return true;
    const signal = parseStoredSignal(row);
    const coverageStart = plan.coverageStart;
    const coverageEnd = plan.coverageEnd;
    if (
      signal.evidence.kind !== 'duplicateTransaction' ||
      coverageStart === null ||
      coverageEnd === null
    ) {
      return false;
    }
    return signal.evidence.observedDates.every(
      (date) => date >= coverageStart && date <= coverageEnd
    );
  }

  private recordEvent(
    signalId: string,
    action: 'create' | 'update' | 'settle' | 'reopen',
    plan: FinanceAutomationEvaluationPlanV1
  ): void {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence
         FROM finance_automation_signal_events
         WHERE signal_id = ?`
      )
      .get(signalId) as { sequence: number };
    this.database
      .prepare(
        `INSERT INTO finance_automation_signal_events(
           signal_id, sequence, action, run_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(signalId, row.sequence + 1, action, plan.runId, plan.completedAt);
  }

  private queueDelivery(
    signal: FinanceAutomationSignalV1,
    action: FinanceAutomationDeliveryV1['action'],
    plan: FinanceAutomationEvaluationPlanV1
  ): void {
    const deliveryKey = automationDeliveryKeyV1(signal.signalId);
    const current = this.database
      .prepare(
        `SELECT version, action, acknowledged_at
         FROM finance_automation_delivery_outbox
         WHERE delivery_key = ?`
      )
      .get(deliveryKey) as DeliveryOutboxRowV1 | undefined;
    const version = (current?.version ?? 0) + 1;
    const coalescedAction: FinanceAutomationDeliveryV1['action'] =
      current?.acknowledged_at === null &&
      current.action === 'create' &&
      action === 'update'
        ? 'create'
        : current?.acknowledged_at === null &&
            current.action === 'settle' &&
            action === 'create'
          ? 'update'
          : action;
    const delivery: FinanceAutomationDeliveryV1 = {
      deliveryKey,
      version,
      signalId: signal.signalId,
      target: 'notification',
      action: coalescedAction,
      signal,
    };
    this.database
      .prepare(
        `INSERT INTO finance_automation_delivery_outbox(
           delivery_key, version, signal_id, connector_ref, target, action,
           delivery_json, last_run_id, created_at, updated_at, acknowledged_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(delivery_key) DO UPDATE SET
           version = excluded.version,
           target = excluded.target,
           action = excluded.action,
           delivery_json = excluded.delivery_json,
           last_run_id = excluded.last_run_id,
           updated_at = excluded.updated_at,
           acknowledged_at = NULL`
      )
      .run(
        delivery.deliveryKey,
        delivery.version,
        delivery.signalId,
        signal.connectorRef,
        delivery.target,
        delivery.action,
        JSON.stringify(delivery),
        plan.runId,
        plan.completedAt,
        plan.completedAt
      );
  }

  private pendingDeliveries(
    connectorRef: string
  ): FinanceAutomationDeliveryV1[] {
    const rows = this.database
      .prepare(
        `SELECT delivery_json, version, action, acknowledged_at
         FROM finance_automation_delivery_outbox
         WHERE connector_ref = ? AND acknowledged_at IS NULL
         ORDER BY delivery_key`
      )
      .all(connectorRef) as DeliveryOutboxRowV1[];
    return rows.map(
      (row) => JSON.parse(row.delivery_json) as FinanceAutomationDeliveryV1
    );
  }
}

function parseStoredSignal(row: SignalRowV1): FinanceAutomationSignalV1 {
  return JSON.parse(row.signal_json) as FinanceAutomationSignalV1;
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function restrictAutomationStateFilesV1(path: string): void {
  if (process.platform === 'win32') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}
