import {
  parseEvaluationRequestV1,
  parseSourceFactBatchV1,
  parseSourceGenerationCommitRequestV1,
  parseSourceGenerationCreateRequestV1,
  type AssignedEvaluationV1,
  type EvaluationRequestV1,
  type SourceFactBatchV1,
  type SourceGenerationCommitRequestV1,
  type SourceGenerationCreateRequestV1,
} from '../contracts/source-v1.js';
import type {
  EvaluationRecordV1,
  EvaluationTerminalResultV1,
  SourceGenerationRecordV1,
} from '../ports/repositories.js';
import type {
  CommitSourceGenerationResultV1,
  EvaluationPublicationV1,
  FinanceInsightSqliteStoreV1,
} from '../persistence/sqlite-store.js';
import { storeError } from '../persistence/errors.js';

export interface FinanceInsightLifecycleServiceOptionsV1 {
  store: FinanceInsightSqliteStoreV1;
  householdScope: string;
  detectorSetVersion: string;
}

export class FinanceInsightLifecycleServiceV1 {
  private readonly store: FinanceInsightSqliteStoreV1;
  private readonly householdScope: string;
  private readonly detectorSetVersion: string;

  constructor(options: FinanceInsightLifecycleServiceOptionsV1) {
    this.store = options.store;
    this.householdScope = options.householdScope;
    this.detectorSetVersion = options.detectorSetVersion;
  }

  async beginSourceGeneration(
    input: SourceGenerationCreateRequestV1
  ): Promise<SourceGenerationRecordV1> {
    return this.store.beginSourceGeneration(
      parseSourceGenerationCreateRequestV1(input)
    );
  }

  async putSourceBatch(input: SourceFactBatchV1): Promise<void> {
    return this.store.putSourceBatch(parseSourceFactBatchV1(input));
  }

  async commitSourceGeneration(
    connectorRef: string,
    input: SourceGenerationCommitRequestV1,
    expectedCurrentSourceGeneration?: string | null
  ): Promise<CommitSourceGenerationResultV1> {
    const request = parseSourceGenerationCommitRequestV1(input);
    const policy = await this.store.policies.current();
    if (!policy) return storeError('policy_conflict');
    if (policy.detectorSetVersion !== this.detectorSetVersion) {
      return storeError('policy_conflict');
    }
    return this.store.commitSourceGeneration(
      connectorRef,
      request,
      this.detectorSetVersion,
      policy.policyVersion,
      this.householdScope,
      expectedCurrentSourceGeneration
    );
  }

  async retryEvaluation(
    input: EvaluationRequestV1
  ): Promise<EvaluationRecordV1> {
    const request = parseEvaluationRequestV1(input);
    if (request.detectorSetVersion !== this.detectorSetVersion) {
      return storeError('stale_evaluation');
    }
    return this.store.retryEvaluation(request, this.householdScope);
  }

  async completeEvaluation(
    assignment: AssignedEvaluationV1,
    result: EvaluationTerminalResultV1,
    publication?: EvaluationPublicationV1
  ): Promise<EvaluationRecordV1> {
    if (
      assignment.identity.householdScope !== this.householdScope ||
      assignment.identity.detectorSetVersion !== this.detectorSetVersion
    ) {
      return storeError('stale_evaluation');
    }
    return this.store.completeEvaluation(assignment, result, publication);
  }

  async claimEvaluation(
    assignment: AssignedEvaluationV1
  ): Promise<EvaluationRecordV1> {
    if (
      assignment.identity.householdScope !== this.householdScope ||
      assignment.identity.detectorSetVersion !== this.detectorSetVersion
    ) {
      return storeError('stale_evaluation');
    }
    return this.store.claimEvaluation(assignment);
  }
}
