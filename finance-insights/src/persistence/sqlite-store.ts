import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import Database from 'better-sqlite3';
import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  SOURCE_GENERATION_ITEM_LIMITS_V1,
  type AssignedEvaluationV1,
  type EvaluationIdentityV1,
  type EvaluationRequestV1,
  type InsightOccurrenceDetailV1,
  type InsightOccurrenceSummaryV1,
  type OccurrenceActionRequestV1,
  type OccurrenceActionResultV1,
  type OccurrenceListQueryV1,
  type OccurrenceListResponseV1,
  type ReasonCodeV1,
  type SourceFactBatchV1,
  type SourceFactKindV1,
  type SourceGenerationCommitRequestV1,
  type SourceGenerationCreateRequestV1,
  type SuppressionStatusV1,
  accountSourceFactSchema,
  categorySourceFactSchema,
  evidenceRecordSchema,
  evaluationKeyV1,
  parseInsightOccurrenceDetailV1,
  parseInsightOccurrenceSummaryV1,
  parseOccurrenceActionRequestV1,
  parseOccurrenceListQueryV1,
  parseSourceFactBatchV1,
  parseSourceGenerationCommitRequestV1,
  parseSourceGenerationCreateRequestV1,
  parseContractV1,
  recurringSourceFactSchema,
  tagSourceFactSchema,
  transactionSourceFactSchema,
} from '../contracts/v1.js';
import {
  canonicalDigestV1,
  canonicalizeV1,
  type CanonicalJsonValue,
} from '../core/canonical.js';
import type {
  EvaluationRecordV1,
  EvaluationRepositoryV1,
  EvaluationTerminalResultV1,
  FinanceInsightPolicyRepositoryV1,
  FinanceInsightUnitOfWorkV1,
  OccurrenceRepositoryV1,
  SourceGenerationRecordV1,
  SourceGenerationRepositoryV1,
  SuppressionRepositoryV1,
} from '../ports/repositories.js';
import {
  parseFinanceInsightPolicySnapshotV1,
  type FinanceInsightPolicySnapshotV1,
} from '../policy/v1.js';
import {
  SOURCE_FACT_KIND_ORDER_V1,
  sourceBatchDigestV1,
  sourceGenerationInputDigestV1,
  sourceManifestDigestV1,
  sourceManifestKindDigestV1,
} from '../projection/digests.js';
import {
  classifyTransactionV1,
  type TransactionClassificationResultV1,
} from '../projection/classification.js';
import { storeError } from './errors.js';
import { migrateFinanceInsightStoreV1 } from './migrations.js';
import type { DocumentEvidencePortV1 } from '../evidence/port.js';

const STAGING_RETENTION_MS = 24 * 60 * 60 * 1_000;
const HISTORICAL_SOURCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const EVALUATION_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const TERMINAL_OCCURRENCE_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const CURSOR_TTL_MS = 15 * 60 * 1_000;
const EVALUATION_CLAIM_LEASE_MS = 5 * 60 * 1_000;
const MAX_POLICY_SNAPSHOTS = 100;
const MAX_LIST_SNAPSHOT_ITEMS = 10_000;

export interface FinanceInsightStoreOptionsV1 {
  path: string;
  cursorChecksumNamespace: Uint8Array;
  clock?: () => string;
  testHook?: (
    point: 'beforePromotion' | 'afterProjection' | 'afterPromotion'
  ) => void;
}

export interface SourceProjectionV1 {
  transactions: readonly Extract<
    SourceFactBatchV1,
    { kind: 'transaction' }
  >['facts'][number][];
  recurring: readonly Extract<
    SourceFactBatchV1,
    { kind: 'recurring' }
  >['facts'][number][];
  categories: readonly Extract<
    SourceFactBatchV1,
    { kind: 'category' }
  >['facts'][number][];
  accounts: readonly Extract<
    SourceFactBatchV1,
    { kind: 'account' }
  >['facts'][number][];
  tags: readonly Extract<
    SourceFactBatchV1,
    { kind: 'tag' }
  >['facts'][number][];
}

export interface OccurrencePublicationV1 {
  detail: InsightOccurrenceDetailV1;
  sourceRevisionRef: string | null;
}

export interface OccurrenceTransitionV1 {
  occurrenceId: string;
  state: 'resolved' | 'superseded';
  reasonCode: Extract<
    ReasonCodeV1,
    | 'correction_resolved'
    | 'correction_superseded'
    | 'variance_rank_omitted'
    | 'variance_period_closed'
  >;
  replacementOccurrenceId: string | null;
  occurredAt: string;
}

export interface EvaluationPublicationV1 {
  occurrences: readonly OccurrencePublicationV1[];
  transitions: readonly OccurrenceTransitionV1[];
  recurringAssociations?: readonly RecurringAssociationV1[];
  exclusionSummary?: Readonly<Record<string, number>>;
}

export interface CommitSourceGenerationResultV1 {
  generation: SourceGenerationRecordV1;
  evaluation: EvaluationRecordV1 | null;
}

export interface CleanupResultV1 {
  expiredStaging: number;
  deletedHistoricalSources: number;
  deletedEvaluations: number;
  deletedOccurrences: number;
  deletedPolicies: number;
}

export interface RecurringAssociationV1 {
  connectorRef: string;
  transactionSourceRef: string;
  recurringSourceRef: string;
  associationVersion: string;
  confidence: 'exact' | 'configured' | 'ambiguous';
  sourceSequence: number;
  createdAt: string;
}

export interface MerchantIdentityAssociationV1 {
  connectorRef: string;
  normalizedMerchantKey: string;
  canonicalMerchantKey: string;
  aliasVersion: string;
  createdAt: string;
}

export interface PersistedTransactionClassificationV1
  extends TransactionClassificationResultV1 {
  sourceRef: string;
  policyVersion: number;
  classifiedAt: string;
}

interface SourceGenerationRow {
  connector_ref: string;
  source_generation: string;
  source_sequence: number;
  request_json: string;
  request_digest: string;
  idempotency_key: string;
  state: SourceGenerationRecordV1['state'];
  assigned_detector_set_version: string | null;
  assigned_policy_version: number | null;
  commit_idempotency_key: string | null;
  commit_digest: string | null;
  created_at: string;
  promoted_at: string | null;
  expires_at: string;
}

interface EvaluationRow {
  evaluation_key: string;
  household_scope: string;
  connector_ref: string;
  source_generation: string;
  detector_set_version: string;
  policy_version: number;
  source_sequence: number;
  evaluation_sequence: number;
  state: EvaluationRecordV1['state'];
  accepted_at: string;
  completed_at: string | null;
  claim_expires_at: string | null;
  request_idempotency_key: string | null;
  request_digest: string | null;
}

interface OccurrenceRow {
  rowid: number;
  occurrence_id: string;
  insight_id: string;
  connector_ref: string;
  source_revision_ref: string | null;
  source_sequence: number;
  evaluation_sequence: number;
  delivery_revision: number;
  analysis_state: string;
  source_lifecycle: string | null;
  resolution_reason: string | null;
  superseded_by_occurrence_id: string | null;
  detail_json: string;
  detail_digest: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface CursorPayloadV1 {
  version: 1;
  filterDigest: string;
  snapshotId: number;
  nextPosition: number;
  expiresAt: string;
}

export class FinanceInsightSqliteStoreV1 implements FinanceInsightUnitOfWorkV1 {
  readonly sourceGenerations: SourceGenerationRepositoryV1;
  readonly evaluations: EvaluationRepositoryV1;
  readonly occurrences: OccurrenceRepositoryV1;
  readonly policies: FinanceInsightPolicyRepositoryV1;
  readonly suppressions: SuppressionRepositoryV1;
  readonly documentEvidence: DocumentEvidencePortV1;

  private readonly database: Database.Database;
  private readonly cursorChecksumNamespace: Uint8Array;
  private readonly clock: () => string;
  private readonly testHook:
    | ((
        point: 'beforePromotion' | 'afterProjection' | 'afterPromotion'
      ) => void)
    | undefined;
  private connectionTail: Promise<void> = Promise.resolve();
  private readonly connectionContext = new AsyncLocalStorage<boolean>();
  private readonly transactionContext = new AsyncLocalStorage<boolean>();

  constructor(options: FinanceInsightStoreOptionsV1) {
    if (!isAbsolute(options.path) || options.path === ':memory:') {
      throw new RangeError(
        'Finance insight state path must be an absolute external file path'
      );
    }
    if (options.cursorChecksumNamespace.byteLength < 16) {
      throw new RangeError('Finance insight cursor checksum namespace must contain at least 16 bytes');
    }
    const path = resolve(options.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // Windows does not implement POSIX mode enforcement.
    }
    this.database = new Database(path);
    this.cursorChecksumNamespace = Uint8Array.from(options.cursorChecksumNamespace);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.testHook = options.testHook;
    migrateFinanceInsightStoreV1(this.database, this.now());
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows access control remains an operator/deployment responsibility.
    }

    this.sourceGenerations = {
      find: async (connectorRef, sourceGeneration) =>
        this.withConnection(() =>
          this.findSourceGeneration(connectorRef, sourceGeneration)
        ),
      begin: async (request) => this.beginSourceGeneration(request),
      putBatch: async (batch) => this.putSourceBatch(batch),
      promote: async (
        connectorRef,
        sourceGeneration,
        expectedSourceSequence,
        detectorSetVersion,
        policyVersion
      ) =>
        (
          await this.commitSourceGeneration(
            connectorRef,
            {
              contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
              sourceGeneration,
              expectedSourceSequence,
              manifestDigest: this.manifestDigestFor(sourceGeneration),
              idempotencyKey: `internal-promote-${canonicalDigestV1([
                connectorRef,
                sourceGeneration,
                expectedSourceSequence,
              ]).slice(7, 39)}`,
            },
            detectorSetVersion,
            policyVersion,
            'homelab-household'
          )
        ).generation,
    };
    this.evaluations = {
      find: async (identity) =>
        this.withConnection(() => this.findEvaluation(identity)),
      assign: async (assignment) =>
        this.withConnection(() => this.assignEvaluation(assignment)),
      finish: async (assignment, result) =>
        this.finishEvaluation(assignment, result),
    };
    this.occurrences = {
      getSummary: async (occurrenceId) => this.getOccurrenceSummary(occurrenceId),
      getDetail: async (occurrenceId) => this.getOccurrenceDetail(occurrenceId),
      list: async (query) => this.listOccurrences(query),
      applyAction: async (request) => this.applyOccurrenceAction(request),
    };
    this.policies = {
      current: async () => this.withConnection(() => this.currentPolicy()),
      latest: async () => this.withConnection(() => this.latestPolicy()),
      find: async (policyVersion) =>
        this.withConnection(() => this.findPolicy(policyVersion)),
      append: async (snapshot) => this.appendPolicy(snapshot),
    };
    this.suppressions = {
      findActiveForOccurrence: async (occurrenceId, at) =>
        this.withConnection(() =>
          this.findSuppressionForOccurrence(occurrenceId, at)
        ),
    };
    this.documentEvidence = {
      find: async (query) =>
        this.withConnection(() =>
          this.findDocumentEvidence(
            query.connectorRef,
            query.sourceGeneration,
            query.entitySourceRef
          )
        ),
    };
  }

  close(): void {
    this.database.close();
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.withConnection(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.transactionContext.run(true, operation);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async beginSourceGeneration(
    input: SourceGenerationCreateRequestV1
  ): Promise<SourceGenerationRecordV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.beginSourceGeneration(input));
    }
    const request = parseSourceGenerationCreateRequestV1(input);
    const requestDigest = sourceGenerationInputDigestV1(request);
    return this.inImmediateTransaction(() => {
      const byIdempotency = this.database
        .prepare(
          'SELECT * FROM finance_insight_source_generations WHERE idempotency_key = ?'
        )
        .get(request.idempotencyKey) as SourceGenerationRow | undefined;
      if (byIdempotency) {
        if (byIdempotency.request_digest !== requestDigest) {
          return storeError('idempotency_conflict');
        }
        return sourceRecord(byIdempotency);
      }
      const existing = this.database
        .prepare(
          'SELECT * FROM finance_insight_source_generations WHERE source_generation = ?'
        )
        .get(request.sourceGeneration) as SourceGenerationRow | undefined;
      if (existing) {
        if (
          existing.connector_ref !== request.connectorRef ||
          existing.request_digest !== requestDigest
        ) {
          return storeError('source_generation_conflict');
        }
        return sourceRecord(existing);
      }
      const sequence = this.database
        .prepare(
          'SELECT * FROM finance_insight_source_generations WHERE connector_ref = ? AND source_sequence = ?'
        )
        .get(request.connectorRef, request.sourceSequence) as
        | SourceGenerationRow
        | undefined;
      if (sequence) return storeError('source_generation_conflict');
      const createdAt = this.now();
      this.database
        .prepare(
          `INSERT INTO finance_insight_source_generations(
            connector_ref, source_generation, source_sequence, request_json,
            request_digest, idempotency_key, state, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?)`
        )
        .run(
          request.connectorRef,
          request.sourceGeneration,
          request.sourceSequence,
          canonicalizeV1(request as CanonicalJsonValue),
          requestDigest,
          request.idempotencyKey,
          createdAt,
          addMilliseconds(createdAt, STAGING_RETENTION_MS)
        );
      return this.findSourceGenerationRequired(
        request.connectorRef,
        request.sourceGeneration
      );
    });
  }

  async findSourceGenerationById(
    sourceGeneration: string
  ): Promise<SourceGenerationRecordV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.findSourceGenerationById(sourceGeneration)
      );
    }
    const row = this.database
      .prepare(
        'SELECT * FROM finance_insight_source_generations WHERE source_generation = ?'
      )
      .get(sourceGeneration) as SourceGenerationRow | undefined;
    return row ? sourceRecord(row) : null;
  }

  async findCurrentSourceGeneration(
    connectorRef: string
  ): Promise<SourceGenerationRecordV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.findCurrentSourceGeneration(connectorRef)
      );
    }
    const row = this.database
      .prepare(
        `SELECT generation.*
         FROM finance_insight_connector_state AS connector
         JOIN finance_insight_source_generations AS generation
           ON generation.connector_ref = connector.connector_ref
          AND generation.source_generation = connector.current_source_generation
         WHERE connector.connector_ref = ? AND generation.state = 'promoted'`
      )
      .get(connectorRef) as SourceGenerationRow | undefined;
    return row ? sourceRecord(row) : null;
  }

  async findLatestSourceGeneration(
    connectorRef: string
  ): Promise<SourceGenerationRecordV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.findLatestSourceGeneration(connectorRef)
      );
    }
    const row = this.database
      .prepare(
        `SELECT *
         FROM finance_insight_source_generations
         WHERE connector_ref = ?
         ORDER BY source_sequence DESC
         LIMIT 1`
      )
      .get(connectorRef) as SourceGenerationRow | undefined;
    return row ? sourceRecord(row) : null;
  }

  async findLatestPromotedSourceGeneration(): Promise<SourceGenerationRecordV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.findLatestPromotedSourceGeneration()
      );
    }
    const row = this.database
      .prepare(
        `SELECT *
         FROM finance_insight_source_generations
         WHERE state = 'promoted'
         ORDER BY promoted_at DESC, connector_ref ASC, source_generation ASC
         LIMIT 1`
      )
      .get() as SourceGenerationRow | undefined;
    return row ? sourceRecord(row) : null;
  }

  async putSourceBatch(input: SourceFactBatchV1): Promise<void> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.putSourceBatch(input));
    }
    const batch = parseSourceFactBatchV1(input);
    const contentDigest = sourceBatchDigestV1(batch);
    if (contentDigest !== batch.digest) return storeError('source_batch_conflict');
    this.inImmediateTransaction(() => {
      const generation = this.database
        .prepare(
          'SELECT * FROM finance_insight_source_generations WHERE source_generation = ?'
        )
        .get(batch.sourceGeneration) as SourceGenerationRow | undefined;
      if (!generation || generation.state !== 'staging') {
        return storeError('source_generation_conflict');
      }
      if (Date.parse(generation.expires_at) <= Date.parse(this.now())) {
        this.database
          .prepare(
            "UPDATE finance_insight_source_generations SET state = 'expired' WHERE source_generation = ?"
          )
          .run(batch.sourceGeneration);
        return storeError('stale_source_generation');
      }
      const request = parseJson<SourceGenerationCreateRequestV1>(
        generation.request_json
      );
      const manifest = request.manifest.find((entry) => entry.kind === batch.kind)!;
      if (batch.batchIndex >= manifest.batchCount) {
        return storeError('source_batch_conflict');
      }
      const byIdempotency = this.database
        .prepare(
          'SELECT * FROM finance_insight_source_batches WHERE idempotency_key = ?'
        )
        .get(batch.idempotencyKey) as
        | { source_generation: string; kind: string; batch_index: number; content_digest: string }
        | undefined;
      if (byIdempotency) {
        if (
          byIdempotency.source_generation !== batch.sourceGeneration ||
          byIdempotency.kind !== batch.kind ||
          byIdempotency.batch_index !== batch.batchIndex ||
          byIdempotency.content_digest !== contentDigest
        ) {
          return storeError('idempotency_conflict');
        }
        return;
      }
      const existing = this.database
        .prepare(
          `SELECT content_digest FROM finance_insight_source_batches
           WHERE source_generation = ? AND kind = ? AND batch_index = ?`
        )
        .get(batch.sourceGeneration, batch.kind, batch.batchIndex) as
        | { content_digest: string }
        | undefined;
      if (existing) {
        if (existing.content_digest !== contentDigest) {
          return storeError('source_batch_conflict');
        }
        return;
      }
      const insertBatch = this.database.prepare(
        `INSERT INTO finance_insight_source_batches(
          source_generation, kind, batch_index, batch_json, batch_digest,
          content_digest, idempotency_key, fact_count, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertBatch.run(
        batch.sourceGeneration,
        batch.kind,
        batch.batchIndex,
        canonicalizeV1(batch as CanonicalJsonValue),
        batch.digest,
        contentDigest,
        batch.idempotencyKey,
        batch.facts.length,
        this.now()
      );
      const insertRef = this.database.prepare(
        `INSERT INTO finance_insight_staged_source_refs(
          source_generation, kind, source_ref, batch_index
        ) VALUES (?, ?, ?, ?)`
      );
      try {
        for (const fact of batch.facts) {
          insertRef.run(
            batch.sourceGeneration,
            batch.kind,
            fact.sourceRef,
            batch.batchIndex
          );
        }
      } catch (error) {
        if (!isSqliteConstraint(error)) throw error;
        return storeError('source_batch_conflict');
      }
    });
  }

  async commitSourceGeneration(
    connectorRef: string,
    input: SourceGenerationCommitRequestV1,
    detectorSetVersion: string,
    policyVersion: number,
    householdScope: string,
    expectedCurrentSourceGeneration?: string | null
  ): Promise<CommitSourceGenerationResultV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.commitSourceGeneration(
          connectorRef,
          input,
          detectorSetVersion,
          policyVersion,
          householdScope,
          expectedCurrentSourceGeneration
        )
      );
    }
    const request = parseSourceGenerationCommitRequestV1(input);
    return this.inImmediateTransaction(() => {
      const generation = this.findSourceGenerationRowRequired(
        connectorRef,
        request.sourceGeneration
      );
      const commitDigest = canonicalDigestV1(request as CanonicalJsonValue);
      if (generation.commit_idempotency_key !== null) {
        if (
          generation.commit_idempotency_key !== request.idempotencyKey ||
          generation.commit_digest !== commitDigest
        ) {
          return storeError('idempotency_conflict');
        }
        return {
          generation: sourceRecord(generation),
          evaluation:
            generation.state === 'promoted'
              ? this.findEvaluationForGeneration(generation)
              : null,
        };
      }
      const conflictingCommit = this.database
        .prepare(
          `SELECT commit_digest FROM finance_insight_source_generations
           WHERE commit_idempotency_key = ?`
        )
        .get(request.idempotencyKey) as { commit_digest: string } | undefined;
      if (conflictingCommit) return storeError('idempotency_conflict');
      if (generation.state !== 'staging') {
        return storeError('source_generation_conflict');
      }
      if (
        request.expectedSourceSequence !== generation.source_sequence ||
        Date.parse(generation.expires_at) <= Date.parse(this.now())
      ) {
        return storeError('stale_source_generation');
      }
      const sourceRequest = parseJson<SourceGenerationCreateRequestV1>(
        generation.request_json
      );
      if (sourceManifestDigestV1(sourceRequest.manifest) !== request.manifestDigest) {
        return storeError('source_generation_conflict');
      }
      const batches = this.loadBatches(request.sourceGeneration);
      this.validateCompleteManifest(sourceRequest, batches);
      const policy = this.findPolicy(policyVersion);
      const effectivePolicy = this.currentPolicy();
      if (
        !policy ||
        !effectivePolicy ||
        effectivePolicy.policyVersion !== policyVersion
      ) {
        return storeError('policy_conflict');
      }
      if (
        policy.detectorSetVersion !== detectorSetVersion ||
        policy.currency !== sourceRequest.currency
      ) {
        return storeError(
          policy.currency !== sourceRequest.currency
            ? 'source_currency_conflict'
            : 'policy_conflict'
        );
      }
      this.testHook?.('beforePromotion');
      this.ensureConnectorState(connectorRef);
      const connector = this.database
        .prepare(
          'SELECT * FROM finance_insight_connector_state WHERE connector_ref = ?'
        )
        .get(connectorRef) as {
        current_source_sequence: number;
        current_source_generation: string | null;
        current_evaluation_sequence: number;
      };
      if (
        expectedCurrentSourceGeneration !== undefined &&
        connector.current_source_generation !== expectedCurrentSourceGeneration
      ) {
        return storeError('source_generation_conflict');
      }
      if (generation.source_sequence < connector.current_source_sequence) {
        this.insertProjection(generation, batches);
        this.testHook?.('afterProjection');
        this.database
          .prepare(
            `UPDATE finance_insight_source_generations
             SET state = 'historical', assigned_detector_set_version = ?,
                 assigned_policy_version = ?, commit_idempotency_key = ?,
                 commit_digest = ?, promoted_at = ?
             WHERE connector_ref = ? AND source_generation = ? AND state = 'staging'`
          )
          .run(
            detectorSetVersion,
            policyVersion,
            request.idempotencyKey,
            commitDigest,
            this.now(),
            connectorRef,
            request.sourceGeneration
          );
        return {
          generation: this.findSourceGenerationRequired(
            connectorRef,
            request.sourceGeneration
          ),
          evaluation: null,
        };
      }
      if (
        generation.source_sequence === connector.current_source_sequence &&
        connector.current_source_generation !== generation.source_generation
      ) {
        return storeError('source_generation_conflict');
      }
      this.database
        .prepare(
          `UPDATE finance_insight_source_generations
           SET state = 'historical'
           WHERE connector_ref = ? AND state = 'promoted'`
        )
        .run(connectorRef);
      this.insertProjection(generation, batches);
      this.testHook?.('afterProjection');
      const acceptedAt = this.now();
      this.database
        .prepare(
          `UPDATE finance_insight_source_generations
           SET state = 'promoted', assigned_detector_set_version = ?,
               assigned_policy_version = ?, commit_idempotency_key = ?,
               commit_digest = ?, promoted_at = ?
           WHERE connector_ref = ? AND source_generation = ? AND state = 'staging'`
        )
        .run(
          detectorSetVersion,
          policyVersion,
          request.idempotencyKey,
          commitDigest,
          acceptedAt,
          connectorRef,
          request.sourceGeneration
        );
      const nextEvaluationSequence = safeIncrement(
        connector.current_evaluation_sequence,
        'evaluation sequence'
      );
      this.database
        .prepare(
          `UPDATE finance_insight_connector_state
           SET current_source_sequence = ?, current_source_generation = ?,
               current_evaluation_sequence = ?
           WHERE connector_ref = ? AND current_source_sequence = ?`
        )
        .run(
          generation.source_sequence,
          generation.source_generation,
          nextEvaluationSequence,
          connectorRef,
          connector.current_source_sequence
        );
      const identity: EvaluationIdentityV1 = {
        householdScope,
        connectorRef,
        sourceGeneration: generation.source_generation,
        detectorSetVersion,
        policyVersion,
      };
      const assignment: AssignedEvaluationV1 = {
        identity,
        sourceSequence: generation.source_sequence,
        evaluationSequence: nextEvaluationSequence,
        acceptedAt,
      };
      this.insertEvaluation(assignment, null, null);
      this.testHook?.('afterPromotion');
      return {
        generation: this.findSourceGenerationRequired(
          connectorRef,
          request.sourceGeneration
        ),
        evaluation: this.findEvaluationRequired(identity),
      };
    });
  }

  async retryEvaluation(
    request: EvaluationRequestV1,
    householdScope: string
  ): Promise<EvaluationRecordV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.retryEvaluation(request, householdScope)
      );
    }
    const identity: EvaluationIdentityV1 = {
      householdScope,
      connectorRef: request.connectorRef,
      sourceGeneration: request.sourceGeneration,
      detectorSetVersion: request.detectorSetVersion,
      policyVersion: request.expectedPolicyVersion,
    };
    const requestDigest = canonicalDigestV1(request as CanonicalJsonValue);
    const retried = this.inImmediateTransaction<EvaluationRecordV1 | null>(() => {
      const generation = this.findSourceGenerationRowRequired(
        request.connectorRef,
        request.sourceGeneration
      );
      const existing = this.findEvaluationRow(identity);
      if (
        generation.state !== 'promoted' ||
        generation.assigned_detector_set_version !== request.detectorSetVersion ||
        generation.assigned_policy_version !== request.expectedPolicyVersion
      ) {
        if (existing) {
          const completedAt = this.now();
          this.database
            .prepare(
              `UPDATE finance_insight_evaluations
               SET state = 'failed', completed_at = ?, claim_expires_at = NULL
               WHERE evaluation_key = ? AND evaluation_sequence = ?
                 AND state IN ('queued', 'evaluating')`
            )
            .run(
              completedAt,
              existing.evaluation_key,
              existing.evaluation_sequence
            );
          this.markEvaluationAttemptStale(
            existing.evaluation_key,
            existing.evaluation_sequence,
            completedAt
          );
        }
        return null;
      }
      if (!existing) return null;
      const replay = this.database
        .prepare(
          `SELECT evaluation_sequence, state, accepted_at, completed_at,
                  request_digest
           FROM finance_insight_evaluation_attempts
           WHERE request_idempotency_key = ?`
        )
        .get(request.idempotencyKey) as
        | {
            evaluation_sequence: number;
            state:
              | EvaluationRecordV1['state']
              | 'stale';
            accepted_at: string;
            completed_at: string | null;
            request_digest: string;
          }
        | undefined;
      if (replay) {
        if (replay.request_digest !== requestDigest) {
          return storeError('idempotency_conflict');
        }
        const replayState = replay.state;
        if (replayState === 'stale') return storeError('stale_evaluation');
        return evaluationAttemptRecord(existing, {
          ...replay,
          state: replayState,
        });
      }
      const keyConflict = this.database
        .prepare(
          'SELECT request_digest FROM finance_insight_evaluations WHERE request_idempotency_key = ?'
        )
        .get(request.idempotencyKey) as { request_digest: string } | undefined;
      if (keyConflict) return storeError('idempotency_conflict');
      if (existing.state === 'queued') {
        if (existing.request_idempotency_key !== null) {
          return storeError('evaluation_in_progress');
        }
        this.database
          .prepare(
            `UPDATE finance_insight_evaluations
             SET request_idempotency_key = ?, request_digest = ?
             WHERE evaluation_key = ? AND evaluation_sequence = ?`
          )
          .run(
            request.idempotencyKey,
            requestDigest,
            existing.evaluation_key,
            existing.evaluation_sequence
          );
        this.database
          .prepare(
            `UPDATE finance_insight_evaluation_attempts
             SET request_idempotency_key = ?, request_digest = ?
             WHERE evaluation_key = ? AND evaluation_sequence = ?`
          )
          .run(
            request.idempotencyKey,
            requestDigest,
            existing.evaluation_key,
            existing.evaluation_sequence
          );
        return this.findEvaluationRequired(identity);
      }
      if (existing.state === 'evaluating') {
        const now = this.now();
        if (
          existing.claim_expires_at !== null &&
          Date.parse(existing.claim_expires_at) > Date.parse(now)
        ) {
          return storeError('evaluation_in_progress');
        }
        this.database
          .prepare(
            `UPDATE finance_insight_evaluation_attempts
             SET state = 'failed', completed_at = ?
             WHERE evaluation_key = ? AND evaluation_sequence = ?
               AND state = 'evaluating'`
          )
          .run(now, existing.evaluation_key, existing.evaluation_sequence);
      }
      this.ensureConnectorState(request.connectorRef);
      const connector = this.database
        .prepare(
          'SELECT * FROM finance_insight_connector_state WHERE connector_ref = ?'
        )
        .get(request.connectorRef) as {
        current_source_sequence: number;
        current_source_generation: string;
        current_evaluation_sequence: number;
      };
      if (
        connector.current_source_sequence !== generation.source_sequence ||
        connector.current_source_generation !== generation.source_generation
      ) {
        const completedAt = this.now();
        this.database
          .prepare(
            `UPDATE finance_insight_evaluations
             SET state = 'failed', completed_at = ?, claim_expires_at = NULL
             WHERE evaluation_key = ? AND evaluation_sequence = ?
               AND state IN ('queued', 'evaluating')`
          )
          .run(
            completedAt,
            existing.evaluation_key,
            existing.evaluation_sequence
          );
        this.markEvaluationAttemptStale(
          existing.evaluation_key,
          existing.evaluation_sequence,
          completedAt
        );
        return null;
      }
      const evaluationSequence = safeIncrement(
        connector.current_evaluation_sequence,
        'evaluation sequence'
      );
      const acceptedAt = this.now();
      this.database
        .prepare(
          `UPDATE finance_insight_connector_state
           SET current_evaluation_sequence = ?
           WHERE connector_ref = ? AND current_evaluation_sequence = ?`
        )
        .run(
          evaluationSequence,
          request.connectorRef,
          connector.current_evaluation_sequence
        );
      this.database
        .prepare(
          `UPDATE finance_insight_evaluations
           SET evaluation_sequence = ?, state = 'queued', accepted_at = ?,
               completed_at = NULL, claim_expires_at = NULL,
               request_idempotency_key = ?, request_digest = ?
           WHERE evaluation_key = ?`
        )
        .run(
          evaluationSequence,
          acceptedAt,
          request.idempotencyKey,
          requestDigest,
          existing.evaluation_key
        );
      this.database
        .prepare(
          `INSERT INTO finance_insight_evaluation_attempts(
             evaluation_key, evaluation_sequence, state, accepted_at,
             request_idempotency_key, request_digest
           ) VALUES (?, ?, 'queued', ?, ?, ?)`
        )
        .run(
          existing.evaluation_key,
          evaluationSequence,
          acceptedAt,
          request.idempotencyKey,
          requestDigest
        );
      return this.findEvaluationRequired(identity);
    });
    if (!retried) return storeError('stale_evaluation');
    return retried;
  }

  async completeEvaluation(
    assignment: AssignedEvaluationV1,
    result: EvaluationTerminalResultV1,
    publication?: EvaluationPublicationV1
  ): Promise<EvaluationRecordV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.completeEvaluation(assignment, result, publication)
      );
    }
    if (
      (result.state === 'completed' && publication === undefined) ||
      (result.state !== 'completed' && publication !== undefined)
    ) {
      return storeError('invalid_request');
    }
    const completed = this.inImmediateTransaction<EvaluationRecordV1 | null>(() => {
      const evaluation = this.findEvaluationRow(assignment.identity);
      if (!evaluation) return storeError('stale_evaluation');
      if (evaluation.evaluation_sequence !== assignment.evaluationSequence) {
        this.markEvaluationAttemptStale(
          evaluation.evaluation_key,
          assignment.evaluationSequence,
          result.completedAt
        );
        return null;
      }
      const connector = this.database
        .prepare(
          'SELECT * FROM finance_insight_connector_state WHERE connector_ref = ?'
        )
        .get(assignment.identity.connectorRef) as
        | {
            current_source_sequence: number;
            current_source_generation: string;
            current_evaluation_sequence: number;
          }
        | undefined;
      if (
        !connector ||
        connector.current_source_sequence !== assignment.sourceSequence ||
        connector.current_source_generation !==
          assignment.identity.sourceGeneration ||
        connector.current_evaluation_sequence !== assignment.evaluationSequence
      ) {
        this.database
          .prepare(
            `UPDATE finance_insight_evaluations
             SET state = 'failed', completed_at = ?, claim_expires_at = NULL
             WHERE evaluation_key = ? AND evaluation_sequence = ?
               AND state IN ('queued', 'evaluating')`
          )
          .run(
            result.completedAt,
            evaluation.evaluation_key,
            assignment.evaluationSequence
          );
        this.markEvaluationAttemptStale(
          evaluation.evaluation_key,
          assignment.evaluationSequence,
          result.completedAt
        );
        return null;
      }
      if (
        evaluation.state === 'completed' ||
        evaluation.state === 'unavailable' ||
        evaluation.state === 'failed'
      ) {
        if (
          evaluation.state !== result.state ||
          evaluation.completed_at !== result.completedAt
        ) {
          return storeError('stale_evaluation');
        }
        return evaluationRecord(evaluation);
      }
      if (result.state === 'completed' && publication) {
        this.validateEvaluationPublication(assignment, result, publication);
        for (const association of publication.recurringAssociations ?? []) {
          this.persistRecurringAssociation(association);
        }
        this.publishOccurrences(assignment, publication);
      }
      this.database
        .prepare(
          `UPDATE finance_insight_evaluations
           SET state = ?, completed_at = ?, claim_expires_at = NULL,
               exclusion_summary_json = ?
           WHERE evaluation_key = ? AND evaluation_sequence = ?`
        )
        .run(
          result.state,
          result.completedAt,
          publication?.exclusionSummary
            ? canonicalizeV1(publication.exclusionSummary)
            : null,
          evaluation.evaluation_key,
          assignment.evaluationSequence
        );
      this.database
        .prepare(
          `UPDATE finance_insight_evaluation_attempts
           SET state = ?, completed_at = ?
           WHERE evaluation_key = ? AND evaluation_sequence = ?`
        )
        .run(
          result.state,
          result.completedAt,
          evaluation.evaluation_key,
          assignment.evaluationSequence
        );
      return this.findEvaluationRequired(assignment.identity);
    });
    if (!completed) return storeError('stale_evaluation');
    return completed;
  }

  async claimEvaluation(
    assignment: AssignedEvaluationV1
  ): Promise<EvaluationRecordV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.claimEvaluation(assignment));
    }
    const claimed = this.inImmediateTransaction<EvaluationRecordV1 | null>(() => {
      const evaluation = this.findEvaluationRow(assignment.identity);
      if (
        !evaluation ||
        evaluation.evaluation_sequence !== assignment.evaluationSequence ||
        evaluation.source_sequence !== assignment.sourceSequence
      ) {
        if (evaluation) {
          this.markEvaluationAttemptStale(
            evaluation.evaluation_key,
            assignment.evaluationSequence,
            this.now()
          );
        }
        return null;
      }
      const connector = this.database
        .prepare(
          `SELECT current_source_sequence, current_source_generation,
                  current_evaluation_sequence
           FROM finance_insight_connector_state WHERE connector_ref = ?`
        )
        .get(assignment.identity.connectorRef) as
        | {
            current_source_sequence: number;
            current_source_generation: string;
            current_evaluation_sequence: number;
          }
        | undefined;
      if (
        !connector ||
        connector.current_source_sequence !== assignment.sourceSequence ||
        connector.current_source_generation !==
          assignment.identity.sourceGeneration ||
        connector.current_evaluation_sequence !== assignment.evaluationSequence
      ) {
        const completedAt = this.now();
        this.database
          .prepare(
            `UPDATE finance_insight_evaluations
             SET state = 'failed', completed_at = ?, claim_expires_at = NULL
             WHERE evaluation_key = ? AND evaluation_sequence = ?
               AND state IN ('queued', 'evaluating')`
          )
          .run(
            completedAt,
            evaluation.evaluation_key,
            assignment.evaluationSequence
          );
        this.markEvaluationAttemptStale(
          evaluation.evaluation_key,
          assignment.evaluationSequence,
          completedAt
        );
        return null;
      }
      if (evaluation.state === 'evaluating') {
        return storeError('evaluation_in_progress');
      }
      if (evaluation.state !== 'queued') return storeError('stale_evaluation');
      this.database
        .prepare(
          `UPDATE finance_insight_evaluations
           SET state = 'evaluating', claim_expires_at = ?
           WHERE evaluation_key = ? AND evaluation_sequence = ? AND state = 'queued'`
        )
        .run(
          addMilliseconds(this.now(), EVALUATION_CLAIM_LEASE_MS),
          evaluation.evaluation_key,
          assignment.evaluationSequence
        );
      this.database
        .prepare(
          `UPDATE finance_insight_evaluation_attempts SET state = 'evaluating'
           WHERE evaluation_key = ? AND evaluation_sequence = ? AND state = 'queued'`
        )
        .run(evaluation.evaluation_key, assignment.evaluationSequence);
      return this.findEvaluationRequired(assignment.identity);
    });
    if (!claimed) return storeError('stale_evaluation');
    return claimed;
  }

  async loadCurrentProjection(
    connectorRef: string,
    expectedSourceGeneration?: string
  ): Promise<SourceProjectionV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.loadCurrentProjection(connectorRef, expectedSourceGeneration)
      );
    }
    const connector = this.database
      .prepare(
        'SELECT current_source_generation FROM finance_insight_connector_state WHERE connector_ref = ?'
      )
      .get(connectorRef) as { current_source_generation: string | null } | undefined;
    if (!connector?.current_source_generation) return null;
    const generation = connector.current_source_generation;
    if (
      expectedSourceGeneration !== undefined &&
      generation !== expectedSourceGeneration
    ) {
      return storeError('stale_evaluation');
    }
    return this.loadProjectionFacts(generation);
  }

  async loadProjection(
    connectorRef: string,
    sourceGeneration: string
  ): Promise<SourceProjectionV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.loadProjection(connectorRef, sourceGeneration)
      );
    }
    const generation = this.findSourceGeneration(connectorRef, sourceGeneration);
    if (
      generation?.state !== 'promoted' &&
      generation?.state !== 'historical'
    ) {
      return null;
    }
    return this.projectionFromBatches(this.loadBatches(sourceGeneration));
  }

  async loadRecurringObligationRefs(
    connectorRef: string,
    sourceGeneration: string
  ): Promise<readonly string[]> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.loadRecurringObligationRefs(connectorRef, sourceGeneration)
      );
    }
    return (
      this.database
        .prepare(
          `SELECT source_ref
           FROM finance_insight_recurring_obligation_facts
           WHERE connector_ref = ? AND source_generation = ? AND is_obligation = 1
           ORDER BY source_ref`
        )
        .all(connectorRef, sourceGeneration) as { source_ref: string }[]
    ).map((row) => row.source_ref);
  }

  private loadProjectionFacts(sourceGeneration: string): SourceProjectionV1 {
    return {
      transactions: this.readProjectionFacts(
        'finance_insight_transaction_facts',
        sourceGeneration,
        (value) =>
          parseContractV1(transactionSourceFactSchema, value, 'transaction source fact')
      ),
      recurring: this.readProjectionFacts(
        'finance_insight_recurring_facts',
        sourceGeneration,
        (value) =>
          parseContractV1(recurringSourceFactSchema, value, 'recurring source fact')
      ),
      categories: this.readProjectionFacts(
        'finance_insight_category_facts',
        sourceGeneration,
        (value) =>
          parseContractV1(categorySourceFactSchema, value, 'category source fact')
      ),
      accounts: this.readProjectionFacts(
        'finance_insight_account_facts',
        sourceGeneration,
        (value) =>
          parseContractV1(accountSourceFactSchema, value, 'account source fact')
      ),
      tags: this.readProjectionFacts(
        'finance_insight_tag_facts',
        sourceGeneration,
        (value) => parseContractV1(tagSourceFactSchema, value, 'tag source fact')
      ),
    };
  }

  private projectionFromBatches(
    batches: readonly SourceFactBatchV1[]
  ): SourceProjectionV1 {
    const projection: {
      -readonly [K in keyof SourceProjectionV1]: SourceProjectionV1[K][number][];
    } = {
      transactions: [],
      recurring: [],
      categories: [],
      accounts: [],
      tags: [],
    };
    for (const batch of batches) {
      if (batch.kind === 'transaction') {
        projection.transactions.push(...batch.facts);
      } else if (batch.kind === 'recurring') {
        projection.recurring.push(...batch.facts);
      } else if (batch.kind === 'category') {
        projection.categories.push(...batch.facts);
      } else if (batch.kind === 'account') {
        projection.accounts.push(...batch.facts);
      } else {
        projection.tags.push(...batch.facts);
      }
    }
    for (const facts of Object.values(projection)) {
      facts.sort((left, right) =>
        left.sourceRef < right.sourceRef
          ? -1
          : left.sourceRef > right.sourceRef
            ? 1
            : 0
      );
    }
    return projection;
  }

  async associateRecurring(
    association: RecurringAssociationV1
  ): Promise<RecurringAssociationV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.associateRecurring(association));
    }
    if (
      association.confidence === 'ambiguous' &&
      association.transactionSourceRef === association.recurringSourceRef
    ) {
      return storeError('invalid_request');
    }
    return this.inImmediateTransaction(() =>
      this.persistRecurringAssociation(association)
    );
  }

  async associateMerchantIdentity(
    association: MerchantIdentityAssociationV1
  ): Promise<MerchantIdentityAssociationV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.associateMerchantIdentity(association)
      );
    }
    return this.inImmediateTransaction(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM finance_insight_merchant_aliases
           WHERE connector_ref = ? AND normalized_merchant_key = ?`
        )
        .get(
          association.connectorRef,
          association.normalizedMerchantKey
        ) as
        | {
            canonical_merchant_key: string;
            alias_version: string;
            created_at: string;
          }
        | undefined;
      if (existing) {
        if (
          existing.canonical_merchant_key !== association.canonicalMerchantKey ||
          existing.alias_version !== association.aliasVersion
        ) {
          return storeError('source_generation_conflict');
        }
        return { ...association, createdAt: existing.created_at };
      }
      this.database
        .prepare(
          `INSERT INTO finance_insight_merchant_aliases(
            connector_ref, normalized_merchant_key, canonical_merchant_key,
            alias_version, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          association.connectorRef,
          association.normalizedMerchantKey,
          association.canonicalMerchantKey,
          association.aliasVersion,
          association.createdAt
        );
      return association;
    });
  }

  async classifyCurrentTransactions(
    connectorRef: string,
    policyVersion: number,
    expectedSourceGeneration?: string
  ): Promise<readonly PersistedTransactionClassificationV1[]> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.classifyCurrentTransactions(
          connectorRef,
          policyVersion,
          expectedSourceGeneration
        )
      );
    }
    const policy = this.findPolicy(policyVersion);
    if (!policy) return storeError('policy_conflict');
    return this.inImmediateTransaction(() => {
      const connector = this.database
        .prepare(
          `SELECT current_source_generation
           FROM finance_insight_connector_state
           WHERE connector_ref = ?`
        )
        .get(connectorRef) as
        | { current_source_generation: string | null }
        | undefined;
      if (!connector?.current_source_generation) {
        return storeError('insight_source_unavailable');
      }
      const sourceGeneration = connector.current_source_generation;
      if (
        expectedSourceGeneration !== undefined &&
        sourceGeneration !== expectedSourceGeneration
      ) {
        return storeError('stale_evaluation');
      }
      const transactions = this.readProjectionFacts(
        'finance_insight_transaction_facts',
        sourceGeneration,
        (value) =>
          parseContractV1(
            transactionSourceFactSchema,
            value,
            'transaction source fact'
          )
      );
      const classifiedAt = this.now();
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO finance_insight_transaction_classifications(
          connector_ref, source_generation, source_ref, policy_version,
          classifier_version, classification, reason_code, classified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const results: PersistedTransactionClassificationV1[] = [];
      for (const fact of transactions) {
        const result = classifyTransactionV1(fact, policy);
        insert.run(
          connectorRef,
          sourceGeneration,
          fact.sourceRef,
          policyVersion,
          result.classifierVersion,
          result.classification,
          result.reasonCode,
          classifiedAt
        );
        results.push({
          ...result,
          sourceRef: fact.sourceRef,
          policyVersion,
          classifiedAt,
        });
      }
      return results;
    });
  }

  async replaceDocumentEvidence(
    connectorRef: string,
    sourceGeneration: string,
    entitySourceRef: string,
    evidence: readonly unknown[]
  ): Promise<void> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.replaceDocumentEvidence(
          connectorRef,
          sourceGeneration,
          entitySourceRef,
          evidence
        )
      );
    }
    if (evidence.length > 8) return storeError('invalid_request');
    const parsed = evidence.map((item) =>
      parseContractV1(evidenceRecordSchema, item, 'document evidence record')
    );
    this.inImmediateTransaction(() => {
      const generation = this.findSourceGenerationRowRequired(
        connectorRef,
        sourceGeneration
      );
      if (generation.state !== 'promoted') return storeError('stale_source_generation');
      this.database
        .prepare(
          `DELETE FROM finance_insight_document_evidence
           WHERE connector_ref = ? AND source_generation = ? AND entity_source_ref = ?`
        )
        .run(connectorRef, sourceGeneration, entitySourceRef);
      const insert = this.database.prepare(
        `INSERT INTO finance_insight_document_evidence(
          connector_ref, source_generation, entity_source_ref, evidence_index,
          evidence_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      parsed.forEach((item, index) => {
        insert.run(
          connectorRef,
          sourceGeneration,
          entitySourceRef,
          index,
          canonicalizeV1(item as CanonicalJsonValue),
          item.observedAt
        );
      });
    });
  }

  async findDocumentEvidence(
    connectorRef: string,
    sourceGeneration: string,
    entitySourceRef: string
  ): Promise<readonly ReturnType<typeof evidenceRecordSchema.parse>[]> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.findDocumentEvidence(
          connectorRef,
          sourceGeneration,
          entitySourceRef
        )
      );
    }
    return (
      this.database
        .prepare(
          `SELECT evidence_json FROM finance_insight_document_evidence
           WHERE connector_ref = ? AND source_generation = ? AND entity_source_ref = ?
           ORDER BY evidence_index`
        )
        .all(connectorRef, sourceGeneration, entitySourceRef) as {
        evidence_json: string;
      }[]
    ).map((row) =>
      parseContractV1(
        evidenceRecordSchema,
        parseJson(row.evidence_json),
        'document evidence record'
      )
    );
  }

  async applyOccurrenceAction(
    input: OccurrenceActionRequestV1
  ): Promise<OccurrenceActionResultV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.applyOccurrenceAction(input));
    }
    const request = parseOccurrenceActionRequestV1(input);
    const requestDigest = canonicalDigestV1(request as CanonicalJsonValue);
    return this.inImmediateTransaction(() => {
      const replay = this.findOccurrenceActionReplay(request, requestDigest);
      if (replay) return replay;
      this.rejectActionIdempotencyConflict(request.idempotencyKey);
      const occurrence = this.findOccurrenceRow(request.occurrenceId);
      if (!occurrence) return storeError('occurrence_not_found');
      const detail = this.detailFromRow(occurrence);
      if (
        occurrence.delivery_revision !== request.expectedDeliveryRevision ||
        detail.provenance.policyVersion !== request.expectedPolicyVersion
      ) {
        return storeError(
          occurrence.delivery_revision !== request.expectedDeliveryRevision
            ? 'occurrence_revision_conflict'
            : 'policy_conflict'
        );
      }
      if (occurrence.source_lifecycle !== 'open') {
        return storeError('occurrence_revision_conflict');
      }
      if (request.action === 'expected' || request.action === 'notUseful') {
        const existing = this.database
          .prepare(
            'SELECT * FROM finance_insight_feedback WHERE idempotency_key = ?'
          )
          .get(request.idempotencyKey) as
          | {
              request_digest: string;
              action_ref: string;
              applied_at: string;
              action: 'expected' | 'notUseful';
            }
          | undefined;
        if (existing) {
          if (existing.request_digest !== requestDigest) {
            return storeError('idempotency_conflict');
          }
          return {
            contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
            occurrenceId: request.occurrenceId,
            deliveryRevision: request.expectedDeliveryRevision,
            policyVersion: request.expectedPolicyVersion,
            action: existing.action,
            actionRef: existing.action_ref,
            appliedAt: existing.applied_at,
            suppressionId: null,
          };
        }
        this.rejectActionIdempotencyConflict(request.idempotencyKey);
        const appliedAt = this.now();
        const actionRef = stableReference('action', request.idempotencyKey);
        this.database
          .prepare(
            `INSERT INTO finance_insight_feedback(
              action_ref, occurrence_id, action, reason, operator, policy_version,
              delivery_revision, idempotency_key, request_digest, applied_at
            ) VALUES (?, ?, ?, ?, 'fixedLocalOperator', ?, ?, ?, ?, ?)`
          )
          .run(
            actionRef,
            request.occurrenceId,
            request.action,
            request.reason,
            request.expectedPolicyVersion,
            request.expectedDeliveryRevision,
            request.idempotencyKey,
            requestDigest,
            appliedAt
          );
        return {
          contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
          occurrenceId: request.occurrenceId,
          deliveryRevision: request.expectedDeliveryRevision,
          policyVersion: request.expectedPolicyVersion,
          action: request.action,
          actionRef,
          appliedAt,
          suppressionId: null,
        };
      }
      if (request.action === 'suppress') {
        const replay = this.database
          .prepare(
            'SELECT * FROM finance_insight_suppressions WHERE idempotency_key = ?'
          )
          .get(request.idempotencyKey) as
          | {
              request_digest: string;
              suppression_id: string;
              created_at: string;
            }
          | undefined;
        if (replay) {
          if (replay.request_digest !== requestDigest) {
            return storeError('idempotency_conflict');
          }
          return {
            contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
            occurrenceId: request.occurrenceId,
            deliveryRevision: request.expectedDeliveryRevision,
            policyVersion: request.expectedPolicyVersion,
            action: 'suppress',
            actionRef: stableReference('action', request.idempotencyKey),
            appliedAt: replay.created_at,
            suppressionId: replay.suppression_id,
          };
        }
        this.rejectActionIdempotencyConflict(request.idempotencyKey);
        const active = this.findSuppressionForOccurrenceSync(
          request.occurrenceId,
          this.now()
        );
        if (active.state === 'active') return storeError('occurrence_revision_conflict');
        const createdAt = this.now();
        const suppressionId = stableReference(
          'suppression',
          request.idempotencyKey
        );
        const scopeRef = suppressionScopeRef(request.scope, detail);
        this.database
          .prepare(
            `INSERT INTO finance_insight_suppressions(
              suppression_id, connector_ref, occurrence_id, scope, scope_ref,
              duration_days, reason, operator, policy_version, delivery_revision,
              idempotency_key, request_digest, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'fixedLocalOperator', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            suppressionId,
            detail.provenance.connectorRef,
            request.occurrenceId,
            request.scope,
            scopeRef,
            request.durationDays,
            request.reason,
            request.expectedPolicyVersion,
            request.expectedDeliveryRevision,
            request.idempotencyKey,
            requestDigest,
            createdAt,
            addMilliseconds(createdAt, request.durationDays * 24 * 60 * 60 * 1_000)
          );
        return {
          contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
          occurrenceId: request.occurrenceId,
          deliveryRevision: request.expectedDeliveryRevision,
          policyVersion: request.expectedPolicyVersion,
          action: 'suppress',
          actionRef: stableReference('action', request.idempotencyKey),
          appliedAt: createdAt,
          suppressionId,
        };
      }
      const suppression = this.database
        .prepare(
          'SELECT * FROM finance_insight_suppressions WHERE suppression_id = ?'
        )
        .get(request.suppressionId) as
        | {
            connector_ref: string;
            occurrence_id: string;
            suppression_id: string;
            scope: 'occurrence' | 'entity' | 'category';
            scope_ref: string;
            undone_at: string | null;
            expires_at: string;
            undo_idempotency_key: string | null;
            undo_request_digest: string | null;
          }
        | undefined;
      if (
        !suppression ||
        !suppressionAppliesToDetail(suppression, detail)
      ) {
        return storeError('unsupported_action');
      }
      if (suppression.undo_idempotency_key === request.idempotencyKey) {
        if (suppression.undo_request_digest !== requestDigest) {
          return storeError('idempotency_conflict');
        }
        return {
          contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
          occurrenceId: request.occurrenceId,
          deliveryRevision: request.expectedDeliveryRevision,
          policyVersion: request.expectedPolicyVersion,
          action: 'undoSuppression',
          actionRef: stableReference('action', request.idempotencyKey),
          appliedAt: suppression.undone_at!,
          suppressionId: request.suppressionId,
        };
      }
      this.rejectActionIdempotencyConflict(request.idempotencyKey);
      const undoneAt = this.now();
      if (
        suppression.undone_at !== null ||
        Date.parse(suppression.expires_at) <= Date.parse(undoneAt)
      ) {
        return storeError('occurrence_revision_conflict');
      }
      this.database
        .prepare(
          `UPDATE finance_insight_suppressions
           SET undone_at = ?, undo_idempotency_key = ?, undo_request_digest = ?
           WHERE suppression_id = ? AND undone_at IS NULL`
        )
        .run(
          undoneAt,
          request.idempotencyKey,
          requestDigest,
          request.suppressionId
        );
      return {
        contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
        occurrenceId: request.occurrenceId,
        deliveryRevision: request.expectedDeliveryRevision,
        policyVersion: request.expectedPolicyVersion,
        action: 'undoSuppression',
        actionRef: stableReference('action', request.idempotencyKey),
        appliedAt: undoneAt,
        suppressionId: request.suppressionId,
      };
    });
  }

  async listOccurrences(
    input: OccurrenceListQueryV1
  ): Promise<OccurrenceListResponseV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.listOccurrences(input));
    }
    const query = parseOccurrenceListQueryV1(input);
    const filterDigest = occurrenceFilterDigest(query);
    const now = this.now();
    this.database
      .prepare('DELETE FROM finance_insight_list_snapshots WHERE expires_at <= ?')
      .run(now);
    let snapshotId: number;
    let nextPosition: number;
    let expiresAt: string;
    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor);
      if (
        cursor.filterDigest !== filterDigest ||
        Date.parse(cursor.expiresAt) <= Date.parse(now)
      ) {
        return storeError('invalid_cursor');
      }
      const snapshot = this.database
        .prepare(
          `SELECT filter_digest, expires_at
           FROM finance_insight_list_snapshots WHERE snapshot_id = ?`
        )
        .get(cursor.snapshotId) as
        | { filter_digest: string; expires_at: string }
        | undefined;
      if (
        !snapshot ||
        snapshot.filter_digest !== filterDigest ||
        snapshot.expires_at !== cursor.expiresAt
      ) {
        return storeError('invalid_cursor');
      }
      snapshotId = cursor.snapshotId;
      nextPosition = cursor.nextPosition;
      expiresAt = cursor.expiresAt;
    } else {
      const snapshot = this.createOccurrenceListSnapshot(query, filterDigest, now);
      snapshotId = snapshot.snapshotId;
      nextPosition = 0;
      expiresAt = snapshot.expiresAt;
    }
    const rows = this.database
      .prepare(
        `SELECT position, summary_json
         FROM finance_insight_list_snapshot_items
         WHERE snapshot_id = ? AND position >= ?
         ORDER BY position
         LIMIT ?`
      )
      .all(snapshotId, nextPosition, query.limit + 1) as {
      position: number;
      summary_json: string;
    }[];
    const page = rows.slice(0, query.limit);
    const items = page.map((row) =>
      parseInsightOccurrenceSummaryV1(parseJson(row.summary_json))
    );
    const followingPosition = nextPosition + page.length;
    return {
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      items,
      nextCursor:
        rows.length > query.limit
          ? this.encodeCursor({
              version: 1,
              filterDigest,
              snapshotId,
              nextPosition: followingPosition,
              expiresAt,
            })
          : null,
    };
  }

  private createOccurrenceListSnapshot(
    query: OccurrenceListQueryV1,
    filterDigest: string,
    now: string
  ): { snapshotId: number; expiresAt: string } {
    return this.inImmediateTransaction(() => {
      const clauses: string[] = [];
      const parameters: unknown[] = [];
      addInFilter(clauses, parameters, 'analysis_state', query.analysisState);
      addInFilter(clauses, parameters, 'source_lifecycle', query.sourceLifecycle);
      if (query.connectorRef) {
        clauses.push('connector_ref = ?');
        parameters.push(query.connectorRef);
      }
      if (query.updatedAfter) {
        clauses.push('julianday(updated_at) > julianday(?)');
        parameters.push(query.updatedAfter);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const candidates = this.database
        .prepare(
          `SELECT rowid, * FROM finance_insight_occurrences
           ${where}
           ORDER BY julianday(updated_at) DESC, occurrence_id ASC`
        )
        .all(...parameters) as OccurrenceRow[];
      const summaries = candidates
        .map((row) => toSummary(this.detailFromRow(row)))
        .filter(
          (summary) =>
            (query.kind.length === 0 || query.kind.includes(summary.kind)) &&
            (query.severity.length === 0 ||
              query.severity.includes(summary.severity)) &&
            (query.baselineSufficiency.length === 0 ||
              query.baselineSufficiency.includes(summary.baselineSufficiency))
        );
      if (summaries.length > MAX_LIST_SNAPSHOT_ITEMS) {
        return storeError('page_too_large');
      }
      const expiresAt = addMilliseconds(now, CURSOR_TTL_MS);
      const result = this.database
        .prepare(
          `INSERT INTO finance_insight_list_snapshots(
            filter_digest, created_at, expires_at
          ) VALUES (?, ?, ?)`
        )
        .run(filterDigest, now, expiresAt);
      const snapshotId = Number(result.lastInsertRowid);
      const insert = this.database.prepare(
        `INSERT INTO finance_insight_list_snapshot_items(
          snapshot_id, position, summary_json
        ) VALUES (?, ?, ?)`
      );
      summaries.forEach((summary, position) => {
        insert.run(
          snapshotId,
          position,
          canonicalizeV1(summary as CanonicalJsonValue)
        );
      });
      return { snapshotId, expiresAt };
    });
  }

  async cleanup(): Promise<CleanupResultV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.cleanup());
    }
    return this.inImmediateTransaction(() => {
      const now = this.now();
      this.database
        .prepare(
          'DELETE FROM finance_insight_list_snapshots WHERE expires_at <= ?'
        )
        .run(now);
      const expiredStaging = this.database
        .prepare(
          `UPDATE finance_insight_source_generations
           SET state = 'expired'
           WHERE state = 'staging' AND expires_at <= ?`
        )
        .run(now).changes;
      const deletedHistoricalSources = this.database
        .prepare(
          `DELETE FROM finance_insight_source_generations
           WHERE state IN ('historical', 'expired', 'rejected')
             AND COALESCE(promoted_at, created_at) < ?
             AND source_generation NOT IN (
               SELECT source_generation FROM finance_insight_evaluations
             )
             AND source_generation NOT IN (
               SELECT json_extract(detail_json, '$.provenance.sourceGeneration')
               FROM finance_insight_occurrences
             )`
        )
        .run(addMilliseconds(now, -HISTORICAL_SOURCE_RETENTION_MS)).changes;
      const deletedEvaluations = this.database
        .prepare(
          `DELETE FROM finance_insight_evaluations
           WHERE state IN ('completed', 'unavailable', 'failed')
             AND completed_at < ?
             AND source_generation NOT IN (
               SELECT json_extract(detail_json, '$.provenance.sourceGeneration')
               FROM finance_insight_occurrences
             )`
        )
        .run(addMilliseconds(now, -EVALUATION_RETENTION_MS)).changes;
      const deletedOccurrences = this.database
        .prepare(
          `DELETE FROM finance_insight_occurrences
           WHERE source_lifecycle IN ('resolved', 'superseded')
             AND resolved_at < ?
             AND occurrence_id NOT IN (
               SELECT occurrence_id FROM finance_insight_suppressions
               WHERE undone_at IS NULL AND expires_at > ?
             )`
        )
        .run(addMilliseconds(now, -TERMINAL_OCCURRENCE_RETENTION_MS), now).changes;
      this.database
        .prepare(
          `DELETE FROM finance_insight_series
           WHERE insight_id NOT IN (
             SELECT DISTINCT insight_id FROM finance_insight_occurrences
           )`
        )
        .run();
      const policies = this.database
        .prepare(
          `SELECT policy_version FROM finance_insight_policy_snapshots
           WHERE policy_version NOT IN (
             SELECT assigned_policy_version FROM finance_insight_source_generations
             WHERE assigned_policy_version IS NOT NULL
           )
           ORDER BY policy_version DESC LIMIT -1 OFFSET ?`
        )
        .all(MAX_POLICY_SNAPSHOTS) as { policy_version: number }[];
      let deletedPolicies = 0;
      const deletePolicy = this.database.prepare(
        'DELETE FROM finance_insight_policy_snapshots WHERE policy_version = ?'
      );
      for (const policy of policies) {
        deletedPolicies += deletePolicy.run(policy.policy_version).changes;
      }
      return {
        expiredStaging,
        deletedHistoricalSources,
        deletedEvaluations,
        deletedOccurrences,
        deletedPolicies,
      };
    });
  }

  async appendPolicy(
    input: FinanceInsightPolicySnapshotV1
  ): Promise<FinanceInsightPolicySnapshotV1> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.appendPolicy(input));
    }
    const snapshot = parseFinanceInsightPolicySnapshotV1(input);
    return this.inImmediateTransaction(() => {
      const current = this.latestPolicy();
      const digest = canonicalDigestV1(snapshot as CanonicalJsonValue);
      const existing = this.findPolicy(snapshot.policyVersion);
      if (existing) {
        if (canonicalDigestV1(existing as CanonicalJsonValue) !== digest) {
          return storeError('policy_conflict');
        }
        return existing;
      }
      if (
        current &&
        (snapshot.policyVersion !== current.policyVersion + 1 ||
          Date.parse(snapshot.effectiveAt) <= Date.parse(current.effectiveAt))
      ) {
        return storeError('policy_conflict');
      }
      if (!current && snapshot.policyVersion !== 1) {
        return storeError('policy_conflict');
      }
      this.database
        .prepare(
          `INSERT INTO finance_insight_policy_snapshots(
            policy_version, effective_at, snapshot_json, snapshot_digest, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          snapshot.policyVersion,
          snapshot.effectiveAt,
          canonicalizeV1(snapshot as CanonicalJsonValue),
          digest,
          this.now()
        );
      return snapshot;
    });
  }

  async getOccurrenceDetail(
    occurrenceId: string
  ): Promise<InsightOccurrenceDetailV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.getOccurrenceDetail(occurrenceId));
    }
    const row = this.findOccurrenceRow(occurrenceId);
    return row ? this.detailFromRow(row) : null;
  }

  async getOccurrenceSummary(
    occurrenceId: string
  ): Promise<InsightOccurrenceSummaryV1 | null> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() => this.getOccurrenceSummary(occurrenceId));
    }
    const detail = await this.getOccurrenceDetail(occurrenceId);
    return detail ? toSummary(detail) : null;
  }

  async listOccurrencePublications(
    connectorRef: string,
    limit: number
  ): Promise<OccurrencePublicationV1[]> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.listOccurrencePublications(connectorRef, limit)
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      return storeError('invalid_request');
    }
    const rows = this.database
      .prepare(
        `SELECT detail_json, source_revision_ref
         FROM finance_insight_occurrences
         WHERE connector_ref = ?
         ORDER BY julianday(updated_at) DESC, occurrence_id ASC
         LIMIT ?`
      )
      .all(connectorRef, limit + 1) as {
      detail_json: string;
      source_revision_ref: string | null;
    }[];
    if (rows.length > limit) return storeError('page_too_large');
    return rows.map((row) => ({
      detail: parseInsightOccurrenceDetailV1(parseJson(row.detail_json)),
      sourceRevisionRef: row.source_revision_ref,
    }));
  }

  async listLatestOccurrencePublicationsByInsightIds(
    connectorRef: string,
    insightIds: readonly string[]
  ): Promise<OccurrencePublicationV1[]> {
    if (!this.connectionContext.getStore()) {
      return this.withConnection(() =>
        this.listLatestOccurrencePublicationsByInsightIds(
          connectorRef,
          insightIds
        )
      );
    }
    if (insightIds.length > 107_000) return storeError('invalid_request');
    const uniqueInsightIds = [...new Set(insightIds)].sort();
    const openRows = this.database
      .prepare(
        `SELECT detail_json, source_revision_ref
         FROM finance_insight_occurrences
         WHERE connector_ref = ? AND source_lifecycle = 'open'
         ORDER BY julianday(updated_at) DESC, occurrence_id ASC
         LIMIT 5111`
      )
      .all(connectorRef) as {
      detail_json: string;
      source_revision_ref: string | null;
    }[];
    if (openRows.length > 5_110) return storeError('page_too_large');
    const publications = new Map<string, OccurrencePublicationV1>();
    for (const row of openRows) {
      const publication = {
        detail: parseInsightOccurrenceDetailV1(parseJson(row.detail_json)),
        sourceRevisionRef: row.source_revision_ref,
      };
      publications.set(publication.detail.occurrenceId, publication);
    }
    for (let offset = 0; offset < uniqueInsightIds.length; offset += 400) {
      const chunk = uniqueInsightIds.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.database
        .prepare(
          `SELECT current.detail_json, current.source_revision_ref
           FROM finance_insight_occurrences AS current
           JOIN (
             SELECT insight_id, MAX(rowid) AS latest_rowid
             FROM finance_insight_occurrences
             WHERE connector_ref = ? AND insight_id IN (${placeholders})
             GROUP BY insight_id
           ) AS latest ON latest.latest_rowid = current.rowid
           ORDER BY current.insight_id`
        )
        .all(connectorRef, ...chunk) as {
        detail_json: string;
        source_revision_ref: string | null;
      }[];
      for (const row of rows) {
        const publication = {
          detail: parseInsightOccurrenceDetailV1(parseJson(row.detail_json)),
          sourceRevisionRef: row.source_revision_ref,
        };
        publications.set(publication.detail.occurrenceId, publication);
      }
    }
    return [...publications.values()].sort((left, right) =>
      left.detail.occurrenceId.localeCompare(right.detail.occurrenceId)
    );
  }

  private publishOccurrences(
    assignment: AssignedEvaluationV1,
    publication: EvaluationPublicationV1
  ): void {
    const generation = this.findSourceGenerationRowRequired(
      assignment.identity.connectorRef,
      assignment.identity.sourceGeneration
    );
    const sourceRequest = parseJson<SourceGenerationCreateRequestV1>(
      generation.request_json
    );
    const policy = this.findPolicy(assignment.identity.policyVersion);
    if (!policy) return storeError('policy_conflict');
    const completedAt = publication.occurrences[0]?.detail.provenance.evaluationCompletedAt;
    const sourceIsFresh =
      completedAt !== undefined &&
      Date.parse(completedAt) >= Date.parse(sourceRequest.sourceAsOf) &&
      Date.parse(completedAt) - Date.parse(sourceRequest.sourceAsOf) <=
        policy.freshness.newAlertMaxAgeHours * 60 * 60 * 1_000;

    for (const item of publication.occurrences) {
      const detail = parseInsightOccurrenceDetailV1(item.detail);
      this.validatePublicationDetail(detail, assignment, sourceRequest);
      const existing = this.findOccurrenceRow(detail.occurrenceId);
      if (
        detail.analysisState === 'qualified' &&
        (!sourceIsFresh ||
          detail.freshness.state !== 'fresh' ||
          detail.provenance.completeness !== 'complete')
      ) {
        if (!existing) continue;
        if (detail.deliveryRevision > existing.delivery_revision) continue;
      }

      this.upsertOccurrence(detail, item.sourceRevisionRef, assignment);
    }
    for (const transition of publication.transitions) {
      this.applyOccurrenceTransition(transition, assignment);
    }
  }

  private validateEvaluationPublication(
    assignment: AssignedEvaluationV1,
    result: Extract<EvaluationTerminalResultV1, { state: 'completed' }>,
    publication: EvaluationPublicationV1
  ): void {
    const associations = publication.recurringAssociations ?? [];
    if (
      associations.length > SOURCE_GENERATION_ITEM_LIMITS_V1.recurring
    ) {
      return storeError('source_generation_too_large');
    }
    const associationKeys = new Set<string>();
    for (const association of associations) {
      if (
        association.connectorRef !== assignment.identity.connectorRef ||
        association.sourceSequence !== assignment.sourceSequence
      ) {
        return storeError('stale_evaluation');
      }
      const key = `${association.transactionSourceRef}\u0000${association.recurringSourceRef}`;
      if (associationKeys.has(key)) {
        return storeError('source_generation_conflict');
      }
      associationKeys.add(key);
    }
    const summaries = publication.occurrences
      .map((item) => {
        if (
          Date.parse(item.detail.provenance.evaluationStartedAt) !==
            Date.parse(assignment.acceptedAt) ||
          Date.parse(item.detail.provenance.evaluationCompletedAt) !==
            Date.parse(result.completedAt)
        ) {
          return storeError('stale_evaluation');
        }
        return toSummary(parseInsightOccurrenceDetailV1(item.detail));
      })
      .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));
    const declared = [...result.summaries].sort((left, right) =>
      left.occurrenceId.localeCompare(right.occurrenceId)
    );
    if (
      canonicalDigestV1(summaries as CanonicalJsonValue) !==
      canonicalDigestV1(declared as CanonicalJsonValue)
    ) {
      return storeError('stale_evaluation');
    }
  }

  private persistRecurringAssociation(
    association: RecurringAssociationV1
  ): RecurringAssociationV1 {
    const generation = this.database
      .prepare(
        `SELECT source_generation
         FROM finance_insight_source_generations
         WHERE connector_ref = ? AND source_sequence = ? AND state = 'promoted'`
      )
      .get(association.connectorRef, association.sourceSequence) as
      | { source_generation: string }
      | undefined;
    if (!generation) return storeError('stale_source_generation');
    const transaction = this.database
      .prepare(
        `SELECT 1 FROM finance_insight_transaction_facts
         WHERE source_generation = ? AND source_ref = ?`
      )
      .get(generation.source_generation, association.transactionSourceRef);
    const recurring = this.database
      .prepare(
        `SELECT 1 FROM finance_insight_recurring_facts
         WHERE source_generation = ? AND source_ref = ?`
      )
      .get(generation.source_generation, association.recurringSourceRef);
    if (!transaction || !recurring) {
      return storeError('source_generation_conflict');
    }
    const existing = this.database
      .prepare(
        `SELECT * FROM finance_insight_recurring_associations
         WHERE connector_ref = ? AND transaction_source_ref = ? AND source_sequence = ?`
      )
      .get(
        association.connectorRef,
        association.transactionSourceRef,
        association.sourceSequence
      ) as
      | {
          recurring_source_ref: string;
          association_version: string;
          confidence: RecurringAssociationV1['confidence'];
          created_at: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.recurring_source_ref !== association.recurringSourceRef ||
        existing.association_version !== association.associationVersion ||
        existing.confidence !== association.confidence
      ) {
        return storeError('source_generation_conflict');
      }
      return {
        ...association,
        createdAt: existing.created_at,
      };
    }
    this.database
      .prepare(
        `INSERT INTO finance_insight_recurring_associations(
          connector_ref, transaction_source_ref, recurring_source_ref,
          association_version, confidence, source_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        association.connectorRef,
        association.transactionSourceRef,
        association.recurringSourceRef,
        association.associationVersion,
        association.confidence,
        association.sourceSequence,
        association.createdAt
      );
    return association;
  }

  private upsertOccurrence(
    detail: InsightOccurrenceDetailV1,
    sourceRevisionRef: string | null,
    assignment: AssignedEvaluationV1
  ): void {
    const detailJson = canonicalizeV1(detail as CanonicalJsonValue);
    const detailDigest = canonicalDigestV1(detail as CanonicalJsonValue);
    const existing = this.findOccurrenceRow(detail.occurrenceId);
    if (existing) {
      const previous = parseJson<InsightOccurrenceDetailV1>(existing.detail_json);
      if (
        existing.insight_id !== detail.insightId ||
        existing.connector_ref !== detail.provenance.connectorRef ||
        existing.created_at !== detail.createdAt ||
        (existing.source_revision_ref !== null &&
          sourceRevisionRef !== existing.source_revision_ref) ||
        !isLifecyclePrefix(previous.lifecycleHistory, detail.lifecycleHistory) ||
        assignment.evaluationSequence < existing.evaluation_sequence ||
        detail.deliveryRevision < existing.delivery_revision ||
        detail.deliveryRevision > existing.delivery_revision + 1
      ) {
        return storeError('occurrence_revision_conflict');
      }
      if (existing.detail_digest === detailDigest) return;
      this.database
        .prepare(
          `UPDATE finance_insight_occurrences
           SET source_revision_ref = ?, source_sequence = ?, evaluation_sequence = ?,
               delivery_revision = ?, analysis_state = ?, source_lifecycle = ?,
               resolution_reason = ?, superseded_by_occurrence_id = ?,
               detail_json = ?, detail_digest = ?, updated_at = ?, resolved_at = ?
           WHERE occurrence_id = ? AND evaluation_sequence <= ?`
        )
        .run(
          sourceRevisionRef,
          assignment.sourceSequence,
          assignment.evaluationSequence,
          detail.deliveryRevision,
          detail.analysisState,
          detail.sourceLifecycle,
          detail.resolutionReason,
          detail.supersededByOccurrenceId,
          detailJson,
          detailDigest,
          detail.updatedAt,
          detail.resolvedAt,
          detail.occurrenceId,
          assignment.evaluationSequence
        );
      if (detail.deliveryRevision > existing.delivery_revision) {
        this.insertOccurrenceRevision(detail, assignment, detailJson, detailDigest);
      }
      this.replaceLifecycleEvents(detail, assignment.evaluationSequence);
      return;
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO finance_insight_series(
          insight_id, connector_ref, kind, entity_kind, entity_source_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        detail.insightId,
        detail.provenance.connectorRef,
        detail.kind,
        detail.entity.kind,
        detail.entity.sourceRef,
        detail.createdAt
      );
    const series = this.database
      .prepare('SELECT * FROM finance_insight_series WHERE insight_id = ?')
      .get(detail.insightId) as {
      connector_ref: string;
      kind: string;
      entity_kind: string;
      entity_source_ref: string;
    };
    if (
      series.connector_ref !== detail.provenance.connectorRef ||
      series.kind !== detail.kind ||
      series.entity_kind !== detail.entity.kind ||
      series.entity_source_ref !== detail.entity.sourceRef
    ) {
      return storeError('source_generation_conflict');
    }
    this.database
      .prepare(
        `INSERT INTO finance_insight_occurrences(
          occurrence_id, insight_id, connector_ref, source_revision_ref,
          source_sequence, evaluation_sequence, delivery_revision, analysis_state,
          source_lifecycle, resolution_reason, superseded_by_occurrence_id,
          detail_json, detail_digest, created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        detail.occurrenceId,
        detail.insightId,
        detail.provenance.connectorRef,
        sourceRevisionRef,
        assignment.sourceSequence,
        assignment.evaluationSequence,
        detail.deliveryRevision,
        detail.analysisState,
        detail.sourceLifecycle,
        detail.resolutionReason,
        detail.supersededByOccurrenceId,
        detailJson,
        detailDigest,
        detail.createdAt,
        detail.updatedAt,
        detail.resolvedAt
      );
    this.insertOccurrenceRevision(detail, assignment, detailJson, detailDigest);
    this.replaceLifecycleEvents(detail, assignment.evaluationSequence);
  }

  private applyOccurrenceTransition(
    transition: OccurrenceTransitionV1,
    assignment: AssignedEvaluationV1
  ): void {
    const row = this.findOccurrenceRow(transition.occurrenceId);
    if (!row) return storeError('occurrence_not_found');
    if (
      row.connector_ref !== assignment.identity.connectorRef ||
      assignment.evaluationSequence < row.evaluation_sequence
    ) {
      return storeError('stale_evaluation');
    }
    if (
      transition.state === 'superseded' &&
      transition.replacementOccurrenceId === null
    ) {
      return storeError('invalid_request');
    }
    if (
      transition.state === 'resolved' &&
      transition.replacementOccurrenceId !== null
    ) {
      return storeError('invalid_request');
    }
    const detail = this.detailFromRow(row);
    if (detail.sourceLifecycle !== 'open') {
      if (
        detail.sourceLifecycle === transition.state &&
        detail.resolutionReason === transition.reasonCode &&
        detail.supersededByOccurrenceId === transition.replacementOccurrenceId
      ) {
        return;
      }
      return storeError('occurrence_revision_conflict');
    }
    const nextSequence =
      (detail.lifecycleHistory.at(-1)?.sequence ?? 0) + 1;
    const transitioned = parseInsightOccurrenceDetailV1({
      ...detail,
      sourceLifecycle: transition.state,
      resolutionReason: transition.reasonCode,
      supersededByOccurrenceId: transition.replacementOccurrenceId,
      updatedAt: transition.occurredAt,
      resolvedAt: transition.occurredAt,
      lifecycleHistory: [
        ...detail.lifecycleHistory,
        {
          sequence: nextSequence,
          state: transition.state,
          reasonCode: transition.reasonCode,
          occurredAt: transition.occurredAt,
          replacementOccurrenceId: transition.replacementOccurrenceId,
        },
      ],
      suppression: this.suppressionStatusAfterClosure(
        detail.occurrenceId,
        transition.occurredAt
      ),
      availableActions: [],
    });
    const json = canonicalizeV1(transitioned as CanonicalJsonValue);
    const digest = canonicalDigestV1(transitioned as CanonicalJsonValue);
    this.database
      .prepare(
        `UPDATE finance_insight_occurrences
         SET evaluation_sequence = ?, source_lifecycle = ?, resolution_reason = ?,
             superseded_by_occurrence_id = ?, detail_json = ?, detail_digest = ?,
             updated_at = ?, resolved_at = ?
         WHERE occurrence_id = ? AND source_lifecycle = 'open'`
      )
      .run(
        assignment.evaluationSequence,
        transition.state,
        transition.reasonCode,
        transition.replacementOccurrenceId,
        json,
        digest,
        transition.occurredAt,
        transition.occurredAt,
        transition.occurrenceId
      );
    this.replaceLifecycleEvents(transitioned, assignment.evaluationSequence);
  }

  private suppressionStatusAfterClosure(
    occurrenceId: string,
    at: string
  ): SuppressionStatusV1 {
    const status = this.findOccurrenceScopedSuppression(occurrenceId, at);
    if (status.state !== 'active') return status;
    this.database
      .prepare(
        `UPDATE finance_insight_suppressions SET undone_at = ?
         WHERE suppression_id = ? AND undone_at IS NULL`
      )
      .run(at, status.suppressionId);
    return { ...status, state: 'undone', undoneAt: at };
  }

  private validatePublicationDetail(
    detail: InsightOccurrenceDetailV1,
    assignment: AssignedEvaluationV1,
    sourceRequest: SourceGenerationCreateRequestV1
  ): void {
    if (
      detail.provenance.connectorRef !== assignment.identity.connectorRef ||
      detail.provenance.sourceGeneration !== assignment.identity.sourceGeneration ||
      detail.provenance.detectorSetVersion !==
        assignment.identity.detectorSetVersion ||
      detail.provenance.policyVersion !== assignment.identity.policyVersion ||
      detail.provenance.sourceAsOf !== sourceRequest.sourceAsOf ||
      detail.provenance.coverageStart !== sourceRequest.coverageStart ||
      detail.provenance.coverageEnd !== sourceRequest.coverageEnd ||
      detail.provenance.bridgeContractVersion !==
        sourceRequest.bridgeContractVersion ||
      detail.currency !== sourceRequest.currency
    ) {
      return storeError('stale_evaluation');
    }
  }

  private insertOccurrenceRevision(
    detail: InsightOccurrenceDetailV1,
    assignment: AssignedEvaluationV1,
    detailJson: string,
    detailDigest: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO finance_insight_occurrence_revisions(
          occurrence_id, delivery_revision, source_sequence, evaluation_sequence,
          detail_json, detail_digest, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        detail.occurrenceId,
        detail.deliveryRevision,
        assignment.sourceSequence,
        assignment.evaluationSequence,
        detailJson,
        detailDigest,
        detail.updatedAt
      );
  }

  private replaceLifecycleEvents(
    detail: InsightOccurrenceDetailV1,
    evaluationSequence: number
  ): void {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO finance_insight_lifecycle_events(
        occurrence_id, sequence, state, reason_code, occurred_at,
        replacement_occurrence_id, evaluation_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const entry of detail.lifecycleHistory) {
      insert.run(
        detail.occurrenceId,
        entry.sequence,
        entry.state,
        entry.reasonCode,
        entry.occurredAt,
        entry.replacementOccurrenceId,
        evaluationSequence
      );
    }
  }

  private insertProjection(
    generation: SourceGenerationRow,
    batches: readonly SourceFactBatchV1[]
  ): void {
    for (const batch of batches) {
      for (const fact of batch.facts) {
        const json = canonicalizeV1(fact as CanonicalJsonValue);
        if (batch.kind === 'transaction') {
          const value = fact as Extract<SourceFactBatchV1, { kind: 'transaction' }>['facts'][number];
          this.database
            .prepare(
              `INSERT INTO finance_insight_transaction_facts(
                connector_ref, source_generation, source_sequence, source_ref,
                occurred_on, amount_minor, merchant_name, category_ref, account_ref,
                is_pending, recurring_ref, tag_refs_json, fact_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              generation.connector_ref,
              generation.source_generation,
              generation.source_sequence,
              value.sourceRef,
              value.occurredOn,
              value.amountMinor,
              value.merchantName,
              value.categoryRef,
              value.accountRef,
              value.isPending ? 1 : 0,
              value.recurringRef,
              canonicalizeV1(value.tagRefs),
              json
            );
        } else if (batch.kind === 'recurring') {
          const value = fact as Extract<SourceFactBatchV1, { kind: 'recurring' }>['facts'][number];
          this.database
            .prepare(
              `INSERT INTO finance_insight_recurring_facts(
                connector_ref, source_generation, source_sequence, source_ref,
                display_name, amount_minor, cadence, next_date, category_ref,
                account_ref, active, fact_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              generation.connector_ref,
              generation.source_generation,
              generation.source_sequence,
              value.sourceRef,
              value.displayName,
              value.amountMinor,
              value.cadence,
              value.nextDate,
              value.categoryRef,
              value.accountRef,
              value.active ? 1 : 0,
              json
            );
          const prior = this.database
            .prepare(
              `SELECT is_obligation
               FROM finance_insight_recurring_obligation_facts
               WHERE connector_ref = ? AND source_ref = ? AND source_sequence < ?
               ORDER BY source_sequence DESC
               LIMIT 1`
            )
            .get(
              generation.connector_ref,
              value.sourceRef,
              generation.source_sequence
            ) as { is_obligation: number } | undefined;
          const isObligation =
            value.amountMinor === null
              ? prior?.is_obligation ?? 0
              : value.amountMinor < 0
                ? 1
                : 0;
          this.database
            .prepare(
              `INSERT INTO finance_insight_recurring_obligation_facts(
                connector_ref, source_generation, source_sequence, source_ref,
                is_obligation
              ) VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              generation.connector_ref,
              generation.source_generation,
              generation.source_sequence,
              value.sourceRef,
              isObligation
            );
        } else if (batch.kind === 'category') {
          const value = fact as Extract<SourceFactBatchV1, { kind: 'category' }>['facts'][number];
          this.database
            .prepare(
              `INSERT INTO finance_insight_category_facts(
                connector_ref, source_generation, source_sequence, source_ref,
                display_name, group_ref, active, fact_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              generation.connector_ref,
              generation.source_generation,
              generation.source_sequence,
              value.sourceRef,
              value.displayName,
              value.groupRef,
              value.active ? 1 : 0,
              json
            );
        } else if (batch.kind === 'account') {
          const value = fact as Extract<SourceFactBatchV1, { kind: 'account' }>['facts'][number];
          this.database
            .prepare(
              `INSERT INTO finance_insight_account_facts(
                connector_ref, source_generation, source_sequence, source_ref,
                account_type, active, fact_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              generation.connector_ref,
              generation.source_generation,
              generation.source_sequence,
              value.sourceRef,
              value.accountType,
              value.active ? 1 : 0,
              json
            );
        } else {
          const value = fact as Extract<SourceFactBatchV1, { kind: 'tag' }>['facts'][number];
          this.database
            .prepare(
              `INSERT INTO finance_insight_tag_facts(
                connector_ref, source_generation, source_sequence, source_ref,
                display_name, active, fact_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              generation.connector_ref,
              generation.source_generation,
              generation.source_sequence,
              value.sourceRef,
              value.displayName,
              value.active ? 1 : 0,
              json
            );
        }
      }
    }
  }

  private validateCompleteManifest(
    request: SourceGenerationCreateRequestV1,
    batches: readonly SourceFactBatchV1[]
  ): void {
    for (const kind of SOURCE_FACT_KIND_ORDER_V1) {
      const expected = request.manifest.find((entry) => entry.kind === kind)!;
      const actual = batches
        .filter((batch) => batch.kind === kind)
        .sort((left, right) => left.batchIndex - right.batchIndex);
      if (
        actual.length !== expected.batchCount ||
        actual.some((batch, index) => batch.batchIndex !== index) ||
        actual.reduce((count, batch) => count + batch.facts.length, 0) !==
          expected.itemCount ||
        sourceManifestKindDigestV1(kind, actual) !== expected.digest
      ) {
        return storeError('source_generation_conflict');
      }
    }
  }

  private loadBatches(sourceGeneration: string): SourceFactBatchV1[] {
    return (
      this.database
        .prepare(
          `SELECT batch_json FROM finance_insight_source_batches
           WHERE source_generation = ? ORDER BY kind, batch_index`
        )
        .all(sourceGeneration) as { batch_json: string }[]
    ).map((row) => parseSourceFactBatchV1(parseJson(row.batch_json)));
  }

  private readProjectionFacts<T>(
    table: string,
    sourceGeneration: string,
    parse: (value: unknown) => T
  ): T[] {
    const allowed = new Set([
      'finance_insight_transaction_facts',
      'finance_insight_recurring_facts',
      'finance_insight_category_facts',
      'finance_insight_account_facts',
      'finance_insight_tag_facts',
    ]);
    if (!allowed.has(table)) throw new TypeError('Unsupported projection table');
    return (
      this.database
        .prepare(
          `SELECT fact_json FROM ${table} WHERE source_generation = ? ORDER BY source_ref`
        )
        .all(sourceGeneration) as { fact_json: string }[]
    ).map((row) => parse(parseJson(row.fact_json)));
  }

  private async finishEvaluation(
    assignment: AssignedEvaluationV1,
    result: EvaluationTerminalResultV1
  ): Promise<EvaluationRecordV1> {
    const publication =
      result.state === 'completed'
        ? {
            occurrences: result.summaries.map((summary) => ({
              detail: detailFromSummary(summary),
              sourceRevisionRef: null,
            })),
            transitions: [],
          }
        : undefined;
    return this.completeEvaluation(assignment, result, publication);
  }

  private async assignEvaluation(
    assignment: AssignedEvaluationV1
  ): Promise<EvaluationRecordV1> {
    return this.inImmediateTransaction(() => {
      const existing = this.findEvaluationRow(assignment.identity);
      if (existing) return evaluationRecord(existing);
      this.insertEvaluation(assignment, null, null);
      return this.findEvaluationRequired(assignment.identity);
    });
  }

  private insertEvaluation(
    assignment: AssignedEvaluationV1,
    idempotencyKey: string | null,
    requestDigest: string | null
  ): void {
    const key = evaluationKeyV1(assignment.identity);
    this.database
      .prepare(
        `INSERT INTO finance_insight_evaluations(
          evaluation_key, household_scope, connector_ref, source_generation,
          detector_set_version, policy_version, source_sequence, evaluation_sequence,
          state, accepted_at, request_idempotency_key, request_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(
        key,
        assignment.identity.householdScope,
        assignment.identity.connectorRef,
        assignment.identity.sourceGeneration,
        assignment.identity.detectorSetVersion,
        assignment.identity.policyVersion,
        assignment.sourceSequence,
        assignment.evaluationSequence,
        assignment.acceptedAt,
        idempotencyKey,
        requestDigest
      );
    this.database
      .prepare(
        `INSERT INTO finance_insight_evaluation_attempts(
          evaluation_key, evaluation_sequence, state, accepted_at,
          request_idempotency_key, request_digest
        ) VALUES (?, ?, 'queued', ?, ?, ?)`
      )
      .run(
        key,
        assignment.evaluationSequence,
        assignment.acceptedAt,
        idempotencyKey,
        requestDigest
      );
  }

  private markEvaluationAttemptStale(
    evaluationKey: string,
    evaluationSequence: number,
    completedAt: string
  ): void {
    this.database
      .prepare(
        `UPDATE finance_insight_evaluation_attempts
         SET state = 'stale', completed_at = ?
         WHERE evaluation_key = ? AND evaluation_sequence = ?
           AND state IN ('queued', 'evaluating')`
      )
      .run(completedAt, evaluationKey, evaluationSequence);
  }

  private findSourceGeneration(
    connectorRef: string,
    sourceGeneration: string
  ): SourceGenerationRecordV1 | null {
    const row = this.database
      .prepare(
        `SELECT * FROM finance_insight_source_generations
         WHERE connector_ref = ? AND source_generation = ?`
      )
      .get(connectorRef, sourceGeneration) as SourceGenerationRow | undefined;
    return row ? sourceRecord(row) : null;
  }

  private findSourceGenerationRequired(
    connectorRef: string,
    sourceGeneration: string
  ): SourceGenerationRecordV1 {
    return sourceRecord(
      this.findSourceGenerationRowRequired(connectorRef, sourceGeneration)
    );
  }

  private findSourceGenerationRowRequired(
    connectorRef: string,
    sourceGeneration: string
  ): SourceGenerationRow {
    const row = this.database
      .prepare(
        `SELECT * FROM finance_insight_source_generations
         WHERE connector_ref = ? AND source_generation = ?`
      )
      .get(connectorRef, sourceGeneration) as SourceGenerationRow | undefined;
    if (!row) return storeError('source_generation_conflict');
    return row;
  }

  private findEvaluation(
    identity: EvaluationIdentityV1
  ): EvaluationRecordV1 | null {
    const row = this.findEvaluationRow(identity);
    return row ? evaluationRecord(row) : null;
  }

  private findEvaluationRow(
    identity: EvaluationIdentityV1
  ): EvaluationRow | undefined {
    return this.database
      .prepare(
        'SELECT * FROM finance_insight_evaluations WHERE evaluation_key = ?'
      )
      .get(evaluationKeyV1(identity)) as EvaluationRow | undefined;
  }

  private findEvaluationRequired(
    identity: EvaluationIdentityV1
  ): EvaluationRecordV1 {
    const row = this.findEvaluationRow(identity);
    if (!row) return storeError('stale_evaluation');
    return evaluationRecord(row);
  }

  private findEvaluationForGeneration(
    generation: SourceGenerationRow
  ): EvaluationRecordV1 | null {
    const row = this.database
      .prepare(
        `SELECT * FROM finance_insight_evaluations
         WHERE connector_ref = ? AND source_generation = ?`
      )
      .get(generation.connector_ref, generation.source_generation) as
      | EvaluationRow
      | undefined;
    return row ? evaluationRecord(row) : null;
  }

  private currentPolicy(): FinanceInsightPolicySnapshotV1 | null {
    const row = this.database
      .prepare(
        `SELECT snapshot_json FROM finance_insight_policy_snapshots
         WHERE effective_at <= ?
         ORDER BY policy_version DESC LIMIT 1`
      )
      .get(this.now()) as { snapshot_json: string } | undefined;
    return row
      ? parseFinanceInsightPolicySnapshotV1(parseJson(row.snapshot_json))
      : null;
  }

  private latestPolicy(): FinanceInsightPolicySnapshotV1 | null {
    const row = this.database
      .prepare(
        `SELECT snapshot_json FROM finance_insight_policy_snapshots
         ORDER BY policy_version DESC LIMIT 1`
      )
      .get() as { snapshot_json: string } | undefined;
    return row
      ? parseFinanceInsightPolicySnapshotV1(parseJson(row.snapshot_json))
      : null;
  }

  private findPolicy(
    policyVersion: number
  ): FinanceInsightPolicySnapshotV1 | null {
    const row = this.database
      .prepare(
        `SELECT snapshot_json FROM finance_insight_policy_snapshots
         WHERE policy_version = ?`
      )
      .get(policyVersion) as { snapshot_json: string } | undefined;
    return row
      ? parseFinanceInsightPolicySnapshotV1(parseJson(row.snapshot_json))
      : null;
  }

  private findOccurrenceRow(occurrenceId: string): OccurrenceRow | undefined {
    return this.database
      .prepare(
        'SELECT rowid, * FROM finance_insight_occurrences WHERE occurrence_id = ?'
      )
      .get(occurrenceId) as OccurrenceRow | undefined;
  }

  private detailFromRow(row: OccurrenceRow): InsightOccurrenceDetailV1 {
    const stored = parseJson<InsightOccurrenceDetailV1>(row.detail_json);
    const suppression =
      stored.sourceLifecycle === 'open'
        ? this.findSuppressionForOccurrenceSync(row.occurrence_id, this.now())
        : this.findOccurrenceScopedSuppression(row.occurrence_id, this.now());
    const availableActions =
      stored.sourceLifecycle !== 'open'
        ? []
        : suppression.state === 'active'
          ? (['expected', 'notUseful', 'undoSuppression'] as const)
          : ([
              'expected',
              'notUseful',
              'suppress30Days',
              'suppress90Days',
              'suppress180Days',
            ] as const);
    return parseInsightOccurrenceDetailV1({
      ...stored,
      suppression,
      availableActions,
    });
  }

  private findSuppressionForOccurrence(
    occurrenceId: string,
    at: string
  ): SuppressionStatusV1 {
    return this.findSuppressionForOccurrenceSync(occurrenceId, at);
  }

  private findSuppressionForOccurrenceSync(
    occurrenceId: string,
    at: string
  ): SuppressionStatusV1 {
    const occurrence = this.findOccurrenceRow(occurrenceId);
    if (!occurrence) {
      return emptySuppression();
    }
    const detail = parseJson<InsightOccurrenceDetailV1>(occurrence.detail_json);
    const categoryRef = categoryScopeRef(detail);
    const row = this.database
      .prepare(
        `SELECT * FROM finance_insight_suppressions
         WHERE connector_ref = ?
           AND (
             (scope = 'occurrence' AND scope_ref = ?)
             OR (scope = 'entity' AND scope_ref = ?)
             OR (? IS NOT NULL AND scope = 'category' AND scope_ref = ?)
           )
         ORDER BY
           CASE WHEN undone_at IS NULL AND expires_at > ? THEN 0 ELSE 1 END,
           created_at DESC,
           rowid DESC
         LIMIT 1`
      )
      .get(
        occurrence.connector_ref,
        occurrenceId,
        entityScopeRef(detail),
        categoryRef,
        categoryRef,
        at
      ) as
      | {
          suppression_id: string;
          scope: 'occurrence' | 'entity' | 'category';
          duration_days: 30 | 90 | 180;
          created_at: string;
          expires_at: string;
          undone_at: string | null;
        }
      | undefined;
    return row ? suppressionStatusFromRow(row, at) : emptySuppression();
  }

  private findOccurrenceScopedSuppression(
    occurrenceId: string,
    at: string
  ): SuppressionStatusV1 {
    const row = this.database
      .prepare(
        `SELECT * FROM finance_insight_suppressions
         WHERE occurrence_id = ? AND scope = 'occurrence'
         ORDER BY
           CASE WHEN undone_at IS NULL AND expires_at > ? THEN 0 ELSE 1 END,
           created_at DESC,
           rowid DESC
         LIMIT 1`
      )
      .get(occurrenceId, at) as
      | {
          suppression_id: string;
          scope: 'occurrence';
          duration_days: 30 | 90 | 180;
          created_at: string;
          expires_at: string;
          undone_at: string | null;
        }
      | undefined;
    return row ? suppressionStatusFromRow(row, at) : emptySuppression();
  }

  private rejectActionIdempotencyConflict(idempotencyKey: string): void {
    const feedback = this.database
      .prepare(
        'SELECT 1 FROM finance_insight_feedback WHERE idempotency_key = ?'
      )
      .get(idempotencyKey);
    const suppression = this.database
      .prepare(
        `SELECT 1 FROM finance_insight_suppressions
         WHERE idempotency_key = ? OR undo_idempotency_key = ?`
      )
      .get(idempotencyKey, idempotencyKey);
    if (feedback || suppression) return storeError('idempotency_conflict');
  }

  private findOccurrenceActionReplay(
    request: OccurrenceActionRequestV1,
    requestDigest: string
  ): OccurrenceActionResultV1 | null {
    const feedback = this.database
      .prepare(
        `SELECT occurrence_id, action, policy_version, delivery_revision,
                request_digest, action_ref, applied_at
         FROM finance_insight_feedback WHERE idempotency_key = ?`
      )
      .get(request.idempotencyKey) as
      | {
          occurrence_id: string;
          action: 'expected' | 'notUseful';
          policy_version: number;
          delivery_revision: number;
          request_digest: string;
          action_ref: string;
          applied_at: string;
        }
      | undefined;
    if (feedback) {
      if (feedback.request_digest !== requestDigest) {
        return storeError('idempotency_conflict');
      }
      return {
        contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
        occurrenceId: feedback.occurrence_id,
        deliveryRevision: feedback.delivery_revision,
        policyVersion: feedback.policy_version,
        action: feedback.action,
        actionRef: feedback.action_ref,
        appliedAt: feedback.applied_at,
        suppressionId: null,
      };
    }
    const suppression = this.database
      .prepare(
        `SELECT occurrence_id, policy_version, delivery_revision,
                idempotency_key, request_digest, created_at, suppression_id,
                undo_idempotency_key, undo_request_digest, undone_at
         FROM finance_insight_suppressions
         WHERE idempotency_key = ? OR undo_idempotency_key = ?`
      )
      .get(request.idempotencyKey, request.idempotencyKey) as
      | {
          occurrence_id: string;
          policy_version: number;
          delivery_revision: number;
          idempotency_key: string;
          request_digest: string;
          created_at: string;
          suppression_id: string;
          undo_idempotency_key: string | null;
          undo_request_digest: string | null;
          undone_at: string | null;
        }
      | undefined;
    if (!suppression) return null;
    const isUndo = suppression.undo_idempotency_key === request.idempotencyKey;
    const storedDigest = isUndo
      ? suppression.undo_request_digest
      : suppression.request_digest;
    if (storedDigest !== requestDigest) return storeError('idempotency_conflict');
    if (isUndo && suppression.undone_at === null) {
      return storeError('insight_operation_failed');
    }
    const appliedAt = isUndo
      ? suppression.undone_at
      : suppression.created_at;
    if (appliedAt === null) return storeError('insight_operation_failed');
    return {
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      occurrenceId: suppression.occurrence_id,
      deliveryRevision: suppression.delivery_revision,
      policyVersion: suppression.policy_version,
      action: isUndo ? 'undoSuppression' : 'suppress',
      actionRef: stableReference('action', request.idempotencyKey),
      appliedAt,
      suppressionId: suppression.suppression_id,
    };
  }

  private ensureConnectorState(connectorRef: string): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO finance_insight_connector_state(connector_ref)
         VALUES (?)`
      )
      .run(connectorRef);
  }

  private manifestDigestFor(sourceGeneration: string): string {
    const row = this.database
      .prepare(
        'SELECT request_json FROM finance_insight_source_generations WHERE source_generation = ?'
      )
      .get(sourceGeneration) as { request_json: string } | undefined;
    if (!row) return storeError('source_generation_conflict');
    return sourceManifestDigestV1(
      parseJson<SourceGenerationCreateRequestV1>(row.request_json).manifest
    );
  }

  private encodeCursor(payload: CursorPayloadV1): string {
    const encoded = Buffer.from(
      canonicalizeV1({
        version: payload.version,
        filterDigest: payload.filterDigest,
        snapshotId: payload.snapshotId,
        nextPosition: payload.nextPosition,
        expiresAt: payload.expiresAt,
      })
    ).toString('base64url');
    const signature = createHash('sha256')
      .update(this.cursorChecksumNamespace)
      .update('\0')
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  private decodeCursor(value: string): CursorPayloadV1 {
    const [encoded, signature, extra] = value.split('.');
    if (!encoded || !signature || extra !== undefined) {
      return storeError('invalid_cursor');
    }
    const expected = createHash('sha256')
      .update(this.cursorChecksumNamespace)
      .update('\0')
      .update(encoded)
      .digest('base64url');
    if (signature !== expected) {
      return storeError('invalid_cursor');
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8')
      ) as CursorPayloadV1;
      if (
        payload.version !== 1 ||
        typeof payload.filterDigest !== 'string' ||
        !Number.isSafeInteger(payload.snapshotId) ||
        payload.snapshotId < 1 ||
        !Number.isSafeInteger(payload.nextPosition) ||
        payload.nextPosition < 0 ||
        typeof payload.expiresAt !== 'string'
      ) {
        return storeError('invalid_cursor');
      }
      return payload;
    } catch {
      return storeError('invalid_cursor');
    }
  }

  private async withConnection<T>(
    operation: () => T | Promise<T>
  ): Promise<T> {
    if (this.connectionContext.getStore()) return operation();
    const prior = this.connectionTail;
    let release!: () => void;
    this.connectionTail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await prior;
    try {
      return await this.connectionContext.run(true, operation);
    } finally {
      release();
    }
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    if (this.transactionContext.getStore()) return operation();
    return this.database.transaction(operation).immediate();
  }

  private now(): string {
    const value = this.clock();
    if (!Number.isFinite(Date.parse(value))) {
      throw new RangeError('Finance insight clock must return a UTC timestamp');
    }
    return value;
  }
}

function sourceRecord(row: SourceGenerationRow): SourceGenerationRecordV1 {
  const request = parseSourceGenerationCreateRequestV1(parseJson(row.request_json));
  if (row.state === 'promoted' || row.state === 'historical') {
    return {
      request,
      state: row.state,
      assignedDetectorSetVersion: row.assigned_detector_set_version!,
      assignedPolicyVersion: row.assigned_policy_version!,
    };
  }
  return {
    request,
    state: row.state,
    assignedDetectorSetVersion: null,
    assignedPolicyVersion: null,
  };
}

function evaluationRecord(row: EvaluationRow): EvaluationRecordV1 {
  const assignment: AssignedEvaluationV1 = {
    identity: {
      householdScope: row.household_scope,
      connectorRef: row.connector_ref,
      sourceGeneration: row.source_generation,
      detectorSetVersion: row.detector_set_version,
      policyVersion: row.policy_version,
    },
    sourceSequence: row.source_sequence,
    evaluationSequence: row.evaluation_sequence,
    acceptedAt: row.accepted_at,
  };
  if (row.state === 'queued' || row.state === 'evaluating') {
    return { assignment, state: row.state, completedAt: null };
  }

  return { assignment, state: row.state, completedAt: row.completed_at! };
}

function evaluationAttemptRecord(
  row: EvaluationRow,
  attempt: {
    evaluation_sequence: number;
    state: EvaluationRecordV1['state'];
    accepted_at: string;
    completed_at: string | null;
  }
): EvaluationRecordV1 {
  const assignment: AssignedEvaluationV1 = {
    identity: {
      householdScope: row.household_scope,
      connectorRef: row.connector_ref,
      sourceGeneration: row.source_generation,
      detectorSetVersion: row.detector_set_version,
      policyVersion: row.policy_version,
    },
    sourceSequence: row.source_sequence,
    evaluationSequence: attempt.evaluation_sequence,
    acceptedAt: attempt.accepted_at,
  };
  if (attempt.state === 'queued' || attempt.state === 'evaluating') {
    return { assignment, state: attempt.state, completedAt: null };
  }
  if (attempt.completed_at === null) return storeError('insight_operation_failed');
  return {
    assignment,
    state: attempt.state,
    completedAt: attempt.completed_at,
  };
}

function toSummary(
  detail: InsightOccurrenceDetailV1
): InsightOccurrenceSummaryV1 {
  const {
    ruleResults: _ruleResults,
    baseline: _baseline,
    comparisons: _comparisons,
    contributors: _contributors,
    exclusions: _exclusions,
    evidence: _evidence,
    lifecycleHistory: _history,
    suppression: _suppression,
    availableActions: _actions,
    ...summary
  } = detail;
  return parseInsightOccurrenceSummaryV1(summary);
}

function detailFromSummary(
  summary: InsightOccurrenceSummaryV1
): InsightOccurrenceDetailV1 {
  const history: InsightOccurrenceDetailV1['lifecycleHistory'] = [
    {
      sequence: 1,
      state: 'analyzing',
      reasonCode: null,
      occurredAt: summary.provenance.evaluationStartedAt,
      replacementOccurrenceId: null,
    },
  ];
  if (summary.analysisState === 'qualified') {
    history.push({
      sequence: 2,
      state: 'open',
      reasonCode: null,
      occurredAt: summary.createdAt,
      replacementOccurrenceId: null,
    });
    if (summary.sourceLifecycle !== 'open') {
      history.push({
        sequence: 3,
        state: summary.sourceLifecycle!,
        reasonCode: summary.resolutionReason,
        occurredAt: summary.resolvedAt!,
        replacementOccurrenceId: summary.supersededByOccurrenceId,
      });
    }
  } else if (summary.analysisState !== 'analyzing') {
    history.push({
      sequence: 2,
      state: summary.analysisState,
      reasonCode:
        summary.analysisState === 'insufficientBaseline'
          ? 'seasonal_baseline_insufficient'
          : 'source_unavailable',
      occurredAt: summary.provenance.evaluationCompletedAt,
      replacementOccurrenceId: null,
    });
  }
  return parseInsightOccurrenceDetailV1({
    ...summary,
    ruleResults: [],
    baseline: null,
    comparisons: [],
    contributors: [],
    exclusions: [],
    evidence: [],
    lifecycleHistory: history,
    suppression: emptySuppression(),
    availableActions:
      summary.sourceLifecycle === 'open'
        ? [
            'expected',
            'notUseful',
            'suppress30Days',
            'suppress90Days',
            'suppress180Days',
          ]
        : [],
  });
}

function emptySuppression(): SuppressionStatusV1 {
  return {
    state: 'none',
    suppressionId: null,
    scope: null,
    durationDays: null,
    operator: null,
    createdAt: null,
    expiresAt: null,
    undoneAt: null,
  };
}

function suppressionStatusFromRow(
  row: {
    suppression_id: string;
    scope: 'occurrence' | 'entity' | 'category';
    duration_days: 30 | 90 | 180;
    created_at: string;
    expires_at: string;
    undone_at: string | null;
  },
  at: string
): SuppressionStatusV1 {
  return {
    state:
      row.undone_at !== null
        ? 'undone'
        : Date.parse(row.expires_at) <= Date.parse(at)
          ? 'expired'
          : 'active',
    suppressionId: row.suppression_id,
    scope: row.scope,
    durationDays: row.duration_days,
    operator: 'fixedLocalOperator',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    undoneAt: row.undone_at,
  };
}

function suppressionAppliesToDetail(
  suppression: {
    connector_ref: string;
    scope: 'occurrence' | 'entity' | 'category';
    scope_ref: string;
  },
  detail: InsightOccurrenceDetailV1
): boolean {
  if (suppression.connector_ref !== detail.provenance.connectorRef) return false;
  if (suppression.scope === 'occurrence') {
    return suppression.scope_ref === detail.occurrenceId;
  }
  if (suppression.scope === 'entity') {
    return suppression.scope_ref === entityScopeRef(detail);
  }
  return suppression.scope_ref === categoryScopeRef(detail);
}

function suppressionScopeRef(
  scope: 'occurrence' | 'entity' | 'category',
  detail: InsightOccurrenceDetailV1
): string {
  if (scope === 'occurrence') return detail.occurrenceId;
  if (scope === 'entity') return entityScopeRef(detail);
  const categoryRef = categoryScopeRef(detail);
  if (!categoryRef) return storeError('unsupported_action');
  return categoryRef;
}

function entityScopeRef(detail: InsightOccurrenceDetailV1): string {
  return `${detail.entity.kind}:${detail.entity.sourceRef}`;
}

function categoryScopeRef(detail: InsightOccurrenceDetailV1): string | null {
  if (detail.entity.kind === 'category') return detail.entity.sourceRef;
  for (const target of detail.targets) {
    if (
      target.system === 'monarch' &&
      target.targetKind === 'reportFilter' &&
      target.categorySourceRef
    ) {
      return target.categorySourceRef;
    }
  }
  return null;
}

function stableReference(prefix: 'action' | 'suppression', value: string): string {
  return `${prefix}-v1-${canonicalDigestV1(value).slice(7, 39)}`;
}

function occurrenceFilterDigest(query: OccurrenceListQueryV1): string {
  return canonicalDigestV1({
    kind: [...query.kind].sort(),
    sourceLifecycle: [...query.sourceLifecycle].sort(),
    analysisState: [...query.analysisState].sort(),
    severity: [...query.severity].sort(),
    baselineSufficiency: [...query.baselineSufficiency].sort(),
    connectorRef: query.connectorRef,
    updatedAfter: query.updatedAfter,
    limit: query.limit,
  });
}

function addInFilter(
  clauses: string[],
  parameters: unknown[],
  column: string,
  values: readonly string[]
): void {
  if (values.length === 0) return;
  clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
  parameters.push(...values);
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function safeIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} cannot be incremented`);
  }
  return value + 1;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}

function isLifecyclePrefix(
  previous: InsightOccurrenceDetailV1['lifecycleHistory'],
  next: InsightOccurrenceDetailV1['lifecycleHistory']
): boolean {
  if (next.length < previous.length) return false;
  return previous.every(
    (entry, index) =>
      canonicalizeV1(entry as CanonicalJsonValue) ===
      canonicalizeV1(next[index]! as CanonicalJsonValue)
  );
}
