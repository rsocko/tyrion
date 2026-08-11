import { z } from 'zod';
import {
  contractVersionSchema,
  parseContractV1,
  positiveSequenceSchema,
  sourceReferenceSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
} from '../contracts/primitives.js';
import {
  sourceGenerationCreateRequestSchema,
  transactionSourceFactSchema,
} from '../contracts/source-v1.js';
import { financeInsightPolicySnapshotSchema } from '../policy/v1.js';

export const FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1 =
  'automation-detectors-v1' as const;
export const DUPLICATE_TRANSACTION_DETECTOR_VERSION_V1 =
  'duplicate-transaction-detector-v1' as const;
export const CONNECTOR_HEALTH_DETECTOR_VERSION_V1 =
  'connector-health-detector-v1' as const;

export const financeAutomationPolicySchema = z.strictObject({
  contractVersion: contractVersionSchema,
  policyVersion: positiveSequenceSchema,
  detectorSetVersion: z.literal(FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1),
  duplicateTransactions: z.strictObject({
    enabled: z.boolean(),
    matchWindowDays: z.number().int().min(0).max(7),
    maxCandidates: z.number().int().positive().max(100),
    freshnessMaxAgeHours: z.number().int().positive().max(168),
  }),
  connectorHealth: z.strictObject({
    enabled: z.boolean(),
    staleAfterHours: z.number().int().positive().max(168),
    actionableAfterConsecutiveFailures: z.number().int().positive().max(100),
  }),
});

const suppressedPairSchema = z
  .strictObject({
    sourceRefs: z
      .tuple([sourceReferenceSchema, sourceReferenceSchema])
      .refine(([left, right]) => left !== right, 'must identify two transactions'),
    reason: z.enum(['expectedDuplicate', 'connectorRetry']),
  })
  .transform((value) => ({
    ...value,
    sourceRefs: [...value.sourceRefs].sort() as [string, string],
  }));

const duplicateTransactionJobRequestSchema = z
  .strictObject({
    contractVersion: contractVersionSchema,
    jobKind: z.literal('duplicateTransactions'),
    connectorRef: sourceReferenceSchema,
    scheduledFor: utcTimestampSchema,
    evaluatedAt: utcTimestampSchema,
    sourceCompleteness: z.enum(['complete', 'partial', 'unavailable']),
    source: sourceGenerationCreateRequestSchema,
    transactions: z.array(transactionSourceFactSchema).max(50_000),
    suppressedPairs: z.array(suppressedPairSchema).max(500),
    insightPolicy: financeInsightPolicySnapshotSchema,
    automationPolicy: financeAutomationPolicySchema,
  })
  .superRefine((value, context) => {
    if (value.source.connectorRef !== value.connectorRef) {
      addIssue(context, ['source', 'connectorRef'], 'must match connectorRef');
    }
    if (Date.parse(value.scheduledFor) > Date.parse(value.evaluatedAt)) {
      addIssue(context, ['scheduledFor'], 'must not be after evaluatedAt');
    }
    const pairKeys = value.suppressedPairs.map((pair) => pair.sourceRefs.join('\0'));
    if (new Set(pairKeys).size !== pairKeys.length) {
      addIssue(context, ['suppressedPairs'], 'must contain unique transaction pairs');
    }
    if (
      value.insightPolicy.policyVersion !== value.automationPolicy.policyVersion
    ) {
      addIssue(
        context,
        ['automationPolicy', 'policyVersion'],
        'must match insight policyVersion'
      );
    }
    const transactionManifest = value.source.manifest.find(
      (entry) => entry.kind === 'transaction'
    );
    if (
      value.sourceCompleteness === 'complete' &&
      transactionManifest?.itemCount !== value.transactions.length
    ) {
      addIssue(
        context,
        ['transactions'],
        'must contain every transaction declared by a complete source generation'
      );
    }
    const sourceRefs = value.transactions.map((transaction) => transaction.sourceRef);
    if (new Set(sourceRefs).size !== sourceRefs.length) {
      addIssue(context, ['transactions'], 'must contain unique source references');
    }
    value.transactions.forEach((transaction, index) => {
      if (
        transaction.occurredOn < value.source.coverageStart ||
        transaction.occurredOn > value.source.coverageEnd
      ) {
        addIssue(
          context,
          ['transactions', index, 'occurredOn'],
          'must be within source generation coverage'
        );
      }
    });
  });

const connectorHealthObservationSchema = z
  .strictObject({
    observedAt: utcTimestampSchema,
    state: z.enum(['connected', 'degraded', 'unavailable']),
    lastSuccessfulSyncAt: utcTimestampSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative().max(10_000),
    bridgeContractVersion: versionIdentifierSchema,
  })
  .superRefine((value, context) => {
    if (
      value.lastSuccessfulSyncAt !== null &&
      Date.parse(value.lastSuccessfulSyncAt) > Date.parse(value.observedAt)
    ) {
      addIssue(
        context,
        ['lastSuccessfulSyncAt'],
        'must not be after observedAt'
      );
    }
    if (value.state === 'connected' && value.lastSuccessfulSyncAt === null) {
      addIssue(
        context,
        ['lastSuccessfulSyncAt'],
        'is required for connected state'
      );
    }
    if (value.state === 'connected' && value.consecutiveFailures !== 0) {
      addIssue(
        context,
        ['consecutiveFailures'],
        'must be zero for connected state'
      );
    }
  });

const connectorHealthJobRequestSchema = z
  .strictObject({
    contractVersion: contractVersionSchema,
    jobKind: z.literal('connectorHealth'),
    connectorRef: sourceReferenceSchema,
    scheduledFor: utcTimestampSchema,
    evaluatedAt: utcTimestampSchema,
    observation: connectorHealthObservationSchema,
    automationPolicy: financeAutomationPolicySchema,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.scheduledFor) > Date.parse(value.evaluatedAt)) {
      addIssue(context, ['scheduledFor'], 'must not be after evaluatedAt');
    }
    if (Date.parse(value.observation.observedAt) > Date.parse(value.evaluatedAt)) {
      addIssue(
        context,
        ['observation', 'observedAt'],
        'must not be after evaluatedAt'
      );
    }
  });

export const financeAutomationJobRequestSchema = z.discriminatedUnion('jobKind', [
  duplicateTransactionJobRequestSchema,
  connectorHealthJobRequestSchema,
]);

export type FinanceAutomationPolicyV1 = Readonly<
  z.infer<typeof financeAutomationPolicySchema>
>;
export type DuplicateTransactionJobRequestV1 = Readonly<
  z.infer<typeof duplicateTransactionJobRequestSchema>
>;
export type ConnectorHealthObservationV1 = Readonly<
  z.infer<typeof connectorHealthObservationSchema>
>;
export type ConnectorHealthJobRequestV1 = Readonly<
  z.infer<typeof connectorHealthJobRequestSchema>
>;
export type FinanceAutomationJobRequestV1 = Readonly<
  z.infer<typeof financeAutomationJobRequestSchema>
>;

export type FinanceAutomationSignalKindV1 =
  | 'duplicateTransaction'
  | 'connectorHealth';
export type FinanceAutomationAttentionV1 = 'informational' | 'actionable';
export type FinanceAutomationSignalStateV1 = 'open' | 'settled';
export type FinanceAutomationFreshnessV1 = 'fresh' | 'stale' | 'unavailable';
export type FinanceAutomationReasonCodeV1 =
  | 'duplicate_exact_match'
  | 'duplicate_adjacent_date_match'
  | 'connector_reported_degraded'
  | 'connector_reported_unavailable'
  | 'connector_sync_stale'
  | 'connector_repeated_failures'
  | 'condition_recovered';

export interface FinanceAutomationProvenanceV1 {
  readonly connectorRef: string;
  readonly providerClass: 'monarchBridgeNormalized';
  readonly bridgeContractVersion: string;
  readonly sourceGeneration: string | null;
  readonly sourceAsOf: string | null;
  readonly observedAt: string;
  readonly evaluatedAt: string;
  readonly detectorSetVersion: typeof FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1;
  readonly detectorVersion:
    | typeof DUPLICATE_TRANSACTION_DETECTOR_VERSION_V1
    | typeof CONNECTOR_HEALTH_DETECTOR_VERSION_V1;
  readonly policyVersion: number;
}

export type FinanceAutomationEvidenceV1 =
  | {
      readonly kind: 'duplicateTransaction';
      readonly sameAmount: true;
      readonly sameMerchant: true;
      readonly sameAccount: true;
      readonly dateGapDays: number;
      readonly observedDates: readonly [string, string];
    }
  | {
      readonly kind: 'connectorHealth';
      readonly reportedState: ConnectorHealthObservationV1['state'];
      readonly consecutiveFailures: number;
      readonly sourceAgeHours: number | null;
    };

export interface FinanceAutomationSignalV1 {
  readonly contractVersion: '1.0';
  readonly signalId: string;
  readonly kind: FinanceAutomationSignalKindV1;
  readonly connectorRef: string;
  readonly state: FinanceAutomationSignalStateV1;
  readonly severity: 'medium' | 'high';
  readonly confidence: 'medium' | 'high';
  readonly attention: FinanceAutomationAttentionV1;
  readonly reasonCodes: readonly FinanceAutomationReasonCodeV1[];
  readonly relatedSourceRefs: readonly string[];
  readonly evidence: FinanceAutomationEvidenceV1;
  readonly freshness: FinanceAutomationFreshnessV1;
  readonly provenance: FinanceAutomationProvenanceV1;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly settledAt: string | null;
}

export interface FinanceAutomationDeliveryV1 {
  readonly deliveryKey: string;
  readonly version: number;
  readonly signalId: string;
  readonly target: 'notification';
  readonly action: 'create' | 'update' | 'settle';
}

export interface FinanceAutomationJobResultV1 {
  readonly contractVersion: '1.0';
  readonly runId: string;
  readonly jobKind: FinanceAutomationJobRequestV1['jobKind'];
  readonly connectorRef: string;
  readonly scheduledFor: string;
  readonly status: 'completed' | 'skipped' | 'ignored';
  readonly skipReason:
    | 'disabled'
    | 'source_stale'
    | 'source_partial'
    | 'source_unavailable'
    | 'out_of_order_observation'
    | 'out_of_order_source_generation'
    | null;
  readonly sourceAsOf: string | null;
  readonly candidateCount: number;
  readonly exclusionSummary: Readonly<Record<string, number>>;
  readonly signals: readonly FinanceAutomationSignalV1[];
  readonly deliveries: readonly FinanceAutomationDeliveryV1[];
  readonly replayed: boolean;
  readonly completedAt: string;
}

const financeAutomationDeliveryAckRequestSchema = z.strictObject({
  contractVersion: contractVersionSchema,
  acknowledgedAt: utcTimestampSchema,
  deliveries: z
    .array(
      z.strictObject({
        deliveryKey: z
          .string()
          .regex(/^finance-automation:signal-v1_[A-Za-z0-9_-]{43}$/),
        expectedVersion: positiveSequenceSchema,
      })
    )
    .min(1)
    .max(100)
    .refine(
      (values) =>
        new Set(values.map((value) => value.deliveryKey)).size === values.length,
      'must contain unique delivery keys'
    ),
});

export type FinanceAutomationDeliveryAckRequestV1 = Readonly<
  z.infer<typeof financeAutomationDeliveryAckRequestSchema>
>;

export interface FinanceAutomationDeliveryAckResultV1 {
  readonly contractVersion: '1.0';
  readonly acknowledged: readonly string[];
  readonly conflicts: readonly string[];
}

export function createCandidateAutomationPolicyV1(
  policyVersion: number
): FinanceAutomationPolicyV1 {
  return parseFinanceAutomationPolicyV1({
    contractVersion: '1.0',
    policyVersion,
    detectorSetVersion: FINANCE_AUTOMATION_DETECTOR_SET_VERSION_V1,
    duplicateTransactions: {
      enabled: false,
      matchWindowDays: 2,
      maxCandidates: 50,
      freshnessMaxAgeHours: 48,
    },
    connectorHealth: {
      enabled: false,
      staleAfterHours: 24,
      actionableAfterConsecutiveFailures: 3,
    },
  });
}

export function parseFinanceAutomationPolicyV1(
  value: unknown
): FinanceAutomationPolicyV1 {
  return Object.freeze(
    parseContractV1(
      financeAutomationPolicySchema,
      value,
      'finance automation policy'
    )
  );
}

export function parseFinanceAutomationJobRequestV1(
  value: unknown
): FinanceAutomationJobRequestV1 {
  return parseContractV1(
    financeAutomationJobRequestSchema,
    value,
    'finance automation job request'
  );
}

export function parseFinanceAutomationDeliveryAckRequestV1(
  value: unknown
): FinanceAutomationDeliveryAckRequestV1 {
  return parseContractV1(
    financeAutomationDeliveryAckRequestSchema,
    value,
    'finance automation delivery acknowledgement'
  );
}

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string
): void {
  context.addIssue({ code: 'custom', path, message });
}
