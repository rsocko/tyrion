import type {
  OccurrenceActionRequestV1,
  OccurrenceActionResultV1,
} from '../contracts/actions-v1.js';
import type {
  InsightOccurrenceDetailV1,
  InsightOccurrenceSummaryV1,
  SuppressionStatusV1,
} from '../contracts/occurrence-v1.js';
import type {
  OccurrenceListQueryV1,
  OccurrenceListResponseV1,
} from '../contracts/list-v1.js';
import type {
  AssignedEvaluationV1,
  EvaluationIdentityV1,
  SourceFactBatchV1,
  SourceGenerationCreateRequestV1,
} from '../contracts/source-v1.js';
import type { FinanceInsightPolicySnapshotV1 } from '../policy/v1.js';

export type EvaluationStateV1 =
  | 'queued'
  | 'evaluating'
  | 'completed'
  | 'unavailable'
  | 'failed';

interface SourceGenerationRecordBaseV1 {
  request: SourceGenerationCreateRequestV1;
}

export type SourceGenerationRecordV1 =
  | (SourceGenerationRecordBaseV1 & {
      state: 'staging' | 'rejected' | 'expired';
      assignedDetectorSetVersion: null;
      assignedPolicyVersion: null;
    })
  | (SourceGenerationRecordBaseV1 & {
      state: 'promoted' | 'historical';
      assignedDetectorSetVersion: string;
      assignedPolicyVersion: number;
    });

interface EvaluationRecordBaseV1 {
  assignment: AssignedEvaluationV1;
}

export type EvaluationRecordV1 =
  | (EvaluationRecordBaseV1 & {
      state: 'queued' | 'evaluating';
      completedAt: null;
    })
  | (EvaluationRecordBaseV1 & {
      state: 'completed' | 'unavailable' | 'failed';
      completedAt: string;
    });

export type EvaluationTerminalResultV1 =
  | {
      state: 'completed';
      summaries: readonly InsightOccurrenceSummaryV1[];
      completedAt: string;
    }
  | {
      state: 'unavailable' | 'failed';
      completedAt: string;
    };

export interface SourceGenerationRepositoryV1 {
  find(
    connectorRef: string,
    sourceGeneration: string
  ): Promise<SourceGenerationRecordV1 | null>;
  begin(
    request: SourceGenerationCreateRequestV1
  ): Promise<SourceGenerationRecordV1>;
  putBatch(batch: SourceFactBatchV1): Promise<void>;
  promote(
    connectorRef: string,
    sourceGeneration: string,
    expectedSourceSequence: number,
    detectorSetVersion: string,
    policyVersion: number
  ): Promise<SourceGenerationRecordV1>;
}

export interface EvaluationRepositoryV1 {
  find(identity: EvaluationIdentityV1): Promise<EvaluationRecordV1 | null>;
  assign(assignment: AssignedEvaluationV1): Promise<EvaluationRecordV1>;
  finish(
    assignment: AssignedEvaluationV1,
    result: EvaluationTerminalResultV1
  ): Promise<EvaluationRecordV1>;
}

export interface OccurrenceRepositoryV1 {
  getSummary(occurrenceId: string): Promise<InsightOccurrenceSummaryV1 | null>;
  getDetail(occurrenceId: string): Promise<InsightOccurrenceDetailV1 | null>;
  list(query: OccurrenceListQueryV1): Promise<OccurrenceListResponseV1>;
  applyAction(
    request: OccurrenceActionRequestV1
  ): Promise<OccurrenceActionResultV1>;
}

export interface FinanceInsightPolicyRepositoryV1 {
  current(): Promise<FinanceInsightPolicySnapshotV1 | null>;
  latest(): Promise<FinanceInsightPolicySnapshotV1 | null>;
  find(policyVersion: number): Promise<FinanceInsightPolicySnapshotV1 | null>;
  append(
    snapshot: FinanceInsightPolicySnapshotV1
  ): Promise<FinanceInsightPolicySnapshotV1>;
}

export interface SuppressionRepositoryV1 {
  findActiveForOccurrence(
    occurrenceId: string,
    at: string
  ): Promise<SuppressionStatusV1>;
}

export interface FinanceInsightUnitOfWorkV1 {
  sourceGenerations: SourceGenerationRepositoryV1;
  evaluations: EvaluationRepositoryV1;
  occurrences: OccurrenceRepositoryV1;
  policies: FinanceInsightPolicyRepositoryV1;
  suppressions: SuppressionRepositoryV1;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}
