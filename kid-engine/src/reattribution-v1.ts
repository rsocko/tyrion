import { randomUUID } from 'node:crypto';
import {
  TYRION_DOMAIN_CONTRACT_VERSION,
  parseReattributionApplyRequestV1,
  parseReattributionPreviewV1,
  parseReattributionPreviewRequestV1,
  type AttributionInputV1,
  type AttributionResultV1,
  type PolicyActorV1,
  type ReattributionApplyRequestV1,
  type ReattributionApplyResultV1,
  type ReattributionPreviewItemV1,
  type ReattributionPreviewRequestV1,
  type ReattributionPreviewV1,
} from './contracts/v1.js';
import { attributeTransactionV1 } from './attribution-v1.js';
import {
  authorizeReattribution,
  type PolicyRepository,
} from './policy/service.js';

export interface ReattributionRecordV1 {
  input: AttributionInputV1;
  current: AttributionResultV1;
}

export interface ReattributionApplyCountsV1 {
  applied: number;
  unchanged: number;
  manualPreserved: number;
  pendingReview: number;
}

export interface ReattributionRepository {
  loadRecords(
    householdId: string,
    sourceRefs: string[]
  ): Promise<ReattributionRecordV1[]>;
  savePreview(preview: ReattributionPreviewV1): Promise<void>;
  loadPreview(
    householdId: string,
    previewId: string
  ): Promise<ReattributionPreviewV1 | null>;
  applyPreviewIfPolicyVersion(
    preview: ReattributionPreviewV1,
    appliedAt: string,
    expectedPolicyVersion: number
  ): Promise<ReattributionApplyCountsV1 | null>;
}

export interface ReattributionServiceOptions {
  now?: () => Date;
  previewId?: () => string;
  previewLifetimeMs?: number;
}

export class ReattributionService {
  private readonly now: () => Date;
  private readonly previewId: () => string;
  private readonly previewLifetimeMs: number;

  constructor(
    private readonly policyRepository: PolicyRepository,
    private readonly reattributionRepository: ReattributionRepository,
    options: ReattributionServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.previewId = options.previewId ?? randomUUID;
    this.previewLifetimeMs = options.previewLifetimeMs ?? 15 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.previewLifetimeMs) ||
      this.previewLifetimeMs < 1_000 ||
      this.previewLifetimeMs > 60 * 60 * 1_000
    ) {
      throw new ReattributionError(
        'invalid_reattribution_configuration',
        'Preview lifetime must be between one second and one hour'
      );
    }
  }

  async preview(
    actor: PolicyActorV1,
    requestValue: ReattributionPreviewRequestV1
  ): Promise<ReattributionPreviewV1> {
    const request = parseReattributionPreviewRequestV1(requestValue);
    authorizeReattribution(actor, request.householdId, 'preview');
    const policy = await this.policyRepository.load(request.householdId);
    if (!policy) {
      throw new ReattributionError(
        'policy_unavailable',
        'A policy snapshot is required before re-attribution'
      );
    }
    if (policy.policyVersion !== request.expectedPolicyVersion) {
      throw new ReattributionError(
        'policy_version_conflict',
        'Policy version changed; create a new preview'
      );
    }
    const records = await this.reattributionRepository.loadRecords(
      request.householdId,
      request.sourceRefs
    );
    const recordsByRef = new Map(
      records.map((record) => [record.input.source.recordRef, record])
    );
    if (
      records.length !== request.sourceRefs.length ||
      request.sourceRefs.some((sourceRef) => !recordsByRef.has(sourceRef))
    ) {
      throw new ReattributionError(
        'reattribution_source_missing',
        'One or more selected records are unavailable'
      );
    }
    const created = this.now();
    const createdAt = created.toISOString();
    const items = request.sourceRefs.map((sourceRef) => {
      const record = recordsByRef.get(sourceRef)!;
      if (
        record.input.householdId !== request.householdId ||
        record.current.sourceRef !== sourceRef
      ) {
        throw new ReattributionError(
          'reattribution_source_mismatch',
          'A selected record belongs to another household'
        );
      }
      const proposed = attributeTransactionV1(record.input, policy, {
        evaluatedAt: createdAt,
      });
      return previewItem(record.current, proposed);
    });
    const preview: ReattributionPreviewV1 = {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      previewId: this.previewId(),
      householdId: request.householdId,
      policyVersion: policy.policyVersion,
      createdAt,
      expiresAt: new Date(created.getTime() + this.previewLifetimeMs).toISOString(),
      items,
    };
    await this.reattributionRepository.savePreview(preview);
    return preview;
  }

  async apply(
    actor: PolicyActorV1,
    requestValue: ReattributionApplyRequestV1
  ): Promise<ReattributionApplyResultV1> {
    const request = parseReattributionApplyRequestV1(requestValue);
    authorizeReattribution(actor, request.householdId, 'apply');
    const policy = await this.policyRepository.load(request.householdId);
    if (!policy || policy.policyVersion !== request.expectedPolicyVersion) {
      throw new ReattributionError(
        'policy_version_conflict',
        'Policy version changed; create a new preview'
      );
    }
    const loadedPreview = await this.reattributionRepository.loadPreview(
      request.householdId,
      request.previewId
    );
    let preview: ReattributionPreviewV1 | null = null;
    if (loadedPreview) {
      try {
        preview = parseReattributionPreviewV1(loadedPreview);
      } catch {
        throw new ReattributionError(
          'reattribution_preview_invalid',
          'Re-attribution preview is unavailable or no longer valid'
        );
      }
    }
    if (
      !preview ||
      preview.previewId !== request.previewId ||
      preview.householdId !== request.householdId ||
      preview.policyVersion !== request.expectedPolicyVersion
    ) {
      throw new ReattributionError(
        'reattribution_preview_invalid',
        'Re-attribution preview is unavailable or no longer valid'
      );
    }
    const appliedAt = this.now().toISOString();
    if (Date.parse(preview.expiresAt) <= Date.parse(appliedAt)) {
      throw new ReattributionError(
        'reattribution_preview_expired',
        'Re-attribution preview expired; create a new preview'
      );
    }
    const counts = await this.reattributionRepository.applyPreviewIfPolicyVersion(
      preview,
      appliedAt,
      request.expectedPolicyVersion
    );
    if (!counts) {
      throw new ReattributionError(
        'policy_version_conflict',
        'Policy version changed; create a new preview'
      );
    }
    return {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      previewId: preview.previewId,
      policyVersion: preview.policyVersion,
      ...counts,
      appliedAt,
    };
  }
}

export type ReattributionErrorCode =
  | 'invalid_reattribution_configuration'
  | 'policy_unavailable'
  | 'policy_version_conflict'
  | 'reattribution_source_missing'
  | 'reattribution_source_mismatch'
  | 'reattribution_preview_invalid'
  | 'reattribution_preview_expired';

export class ReattributionError extends Error {
  constructor(
    readonly code: ReattributionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ReattributionError';
  }
}

function previewItem(
  previous: AttributionResultV1,
  proposed: AttributionResultV1
): ReattributionPreviewItemV1 {
  const disposition =
    proposed.method === 'manual'
      ? 'manual-preserved'
      : equivalentDecision(previous, proposed)
        ? 'unchanged'
        : proposed.status === 'pending'
          ? 'pending-review'
          : 'would-update';
  return {
    sourceRef: proposed.sourceRef,
    previous,
    proposed,
    disposition,
  };
}

function equivalentDecision(
  left: AttributionResultV1,
  right: AttributionResultV1
): boolean {
  return (
    left.status === right.status &&
    left.kidId === right.kidId &&
    left.confidence === right.confidence &&
    left.method === right.method &&
    left.explanation === right.explanation &&
    JSON.stringify(left.review) === JSON.stringify(right.review) &&
    left.provenance.policyVersion === right.provenance.policyVersion &&
    JSON.stringify(left.provenance.ruleIds) ===
      JSON.stringify(right.provenance.ruleIds)
  );
}
