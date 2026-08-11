import { z } from 'zod';
import { canonicalizeV1 } from '../core/canonical.js';
import { externalTargetSchema } from './targets-v1.js';
import {
  amountMinorSchema,
  basisPointsSchema,
  calendarDateSchema,
  contractVersionSchema,
  currencySchema,
  deliveryRevisionSchema,
  expectedMoneyRangeSchema,
  insightIdSchema,
  merchantKeySchema,
  moneyValueSchema,
  nonNegativeAmountMinorSchema,
  nonNegativeIntegerSchema,
  normalizedDisplayNameSchema,
  normalizedTextSchema,
  occurrenceIdSchema,
  parseContractV1,
  periodSchema,
  positiveSequenceSchema,
  sourceReferenceSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
} from './primitives.js';

export const insightKindSchema = z.enum([
  'recurringAmountChange',
  'largeTransaction',
  'categoryVariance',
  'merchantVariance',
]);
export const analysisStateSchema = z.enum([
  'analyzing',
  'qualified',
  'insufficientBaseline',
  'unavailable',
]);
export const sourceLifecycleSchema = z.enum(['open', 'resolved', 'superseded']);
export const severitySchema = z.enum(['info', 'medium', 'high']);
export const confidenceSchema = z.enum(['low', 'medium', 'high']);
export const baselineSufficiencySchema = z.enum([
  'insufficient',
  'limited',
  'sufficient',
]);
export const freshnessStateSchema = z.enum([
  'fresh',
  'stale',
  'partial',
  'unavailable',
]);
export const sourceCompletenessSchema = z.enum([
  'complete',
  'partial',
  'unavailable',
]);

export const reasonCodeSchema = z.enum([
  'explicit_amount_rule_exceeded',
  'recurring_absolute_gate_exceeded',
  'recurring_relative_gate_exceeded',
  'recurring_decrease_analysis_only',
  'adaptive_baseline_agreement',
  'adaptive_baseline_insufficient',
  'adaptive_baseline_no_agreement',
  'adaptive_merchant_baseline_triggered',
  'adaptive_category_baseline_triggered',
  'adaptive_account_baseline_triggered',
  'adaptive_household_baseline_triggered',
  'variance_absolute_gate_exceeded',
  'variance_relative_gate_exceeded',
  'robust_deviation_exceeded',
  'new_spend_zero_baseline',
  'seasonal_baseline_insufficient',
  'source_stale',
  'source_partial',
  'source_unavailable',
  'normalized_name_identity',
  'zero_mad_minimum_spread',
  'period_normalized',
  'optional_evidence_unavailable',
  'classification_ambiguous',
  'pending_excluded',
  'transfer_excluded',
  'income_excluded',
  'refund_excluded',
  'unclassified_credit_excluded',
  'known_recurring_excluded',
  'policy_excluded',
  'approved_merchant_excluded',
  'expected_scope_excluded',
  'suppressed_scope_excluded',
  'correction_resolved',
  'correction_superseded',
  'variance_rank_omitted',
  'variance_period_closed',
  'material_source_change',
  'medium_confidence_no_notify',
]);

const stableEntitySchema = z.strictObject({
  kind: z.enum(['recurring', 'transaction', 'category']),
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  identityQuality: z.literal('stableSource'),
});

const merchantEntitySchema = z.strictObject({
  kind: z.literal('merchant'),
  sourceRef: merchantKeySchema,
  displayName: normalizedDisplayNameSchema,
  identityQuality: z.enum(['configuredAlias', 'normalizedName']),
});

export const insightEntitySchema = z.union([
  stableEntitySchema,
  merchantEntitySchema,
]);

export const freshnessSchema = z
  .strictObject({
    state: freshnessStateSchema,
    sourceAsOf: utcTimestampSchema.nullable(),
    maxAgeHours: z.literal(48),
    warningReason: reasonCodeSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.state === 'fresh' && value.sourceAsOf === null) {
      context.addIssue({
        code: 'custom',
        path: ['sourceAsOf'],
        message: 'is required for fresh source data',
      });
    }
    if (value.state === 'fresh' && value.warningReason !== null) {
      context.addIssue({
        code: 'custom',
        path: ['warningReason'],
        message: 'must be null for fresh source data',
      });
    }
    if (value.state !== 'fresh' && value.warningReason === null) {
      context.addIssue({
        code: 'custom',
        path: ['warningReason'],
        message: 'is required for non-fresh source data',
      });
    }
    const expectedWarning = {
      stale: 'source_stale',
      partial: 'source_partial',
      unavailable: 'source_unavailable',
    } as const;
    if (
      value.state !== 'fresh' &&
      value.warningReason !== expectedWarning[value.state]
    ) {
      context.addIssue({
        code: 'custom',
        path: ['warningReason'],
        message: `must be ${expectedWarning[value.state]} for ${value.state} data`,
      });
    }
  });

export const occurrenceProvenanceSchema = z
  .strictObject({
    connectorRef: sourceReferenceSchema,
    sourceGeneration: sourceReferenceSchema,
    bridgeContractVersion: versionIdentifierSchema,
    providerClass: z.literal('monarchBridgeNormalized'),
    sourceAsOf: utcTimestampSchema,
    coverageStart: calendarDateSchema,
    coverageEnd: calendarDateSchema,
    completeness: sourceCompletenessSchema,
    detectorSetVersion: versionIdentifierSchema,
    detectorVersion: versionIdentifierSchema,
    methodVersion: versionIdentifierSchema,
    explanationTemplateVersion: versionIdentifierSchema,
    policyVersion: positiveSequenceSchema,
    evaluationStartedAt: utcTimestampSchema,
    evaluationCompletedAt: utcTimestampSchema,
  })
  .superRefine((value, context) => {
    if (value.coverageEnd < value.coverageStart) {
      addIssue(context, ['coverageEnd'], 'must be on or after coverageStart');
    }
    if (
      Date.parse(value.evaluationCompletedAt) <
      Date.parse(value.evaluationStartedAt)
    ) {
      addIssue(
        context,
        ['evaluationCompletedAt'],
        'must be on or after evaluationStartedAt'
      );
    }
  });

const summaryShape = {
  contractVersion: contractVersionSchema,
  insightId: insightIdSchema,
  occurrenceId: occurrenceIdSchema,
  deliveryRevision: deliveryRevisionSchema,
  kind: insightKindSchema,
  entity: insightEntitySchema,
  analysisState: analysisStateSchema,
  sourceLifecycle: sourceLifecycleSchema.nullable(),
  resolutionReason: reasonCodeSchema.nullable(),
  supersededByOccurrenceId: occurrenceIdSchema.nullable(),
  severity: severitySchema,
  confidence: confidenceSchema,
  baselineSufficiency: baselineSufficiencySchema,
  reasonCodes: z
    .array(reasonCodeSchema)
    .max(12)
    .refine(uniqueStrings, 'must contain unique values'),
  headline: z.string().trim().min(1).max(160),
  explanation: normalizedTextSchema,
  observationPeriod: periodSchema,
  baselinePeriod: periodSchema.nullable(),
  observedValue: moneyValueSchema.nullable(),
  expectedRange: expectedMoneyRangeSchema.nullable(),
  absoluteDelta: moneyValueSchema.nullable(),
  percentageDeltaBasisPoints: basisPointsSchema.nullable(),
  currency: currencySchema,
  freshness: freshnessSchema,
  provenance: occurrenceProvenanceSchema,
  targets: z
    .array(externalTargetSchema)
    .max(4)
    .refine(uniqueCanonicalValues, 'must contain unique values'),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  resolvedAt: utcTimestampSchema.nullable(),
} as const;

const summaryObjectSchema = z.strictObject(summaryShape);
export const insightOccurrenceSummarySchema =
  summaryObjectSchema.superRefine(validateSummary);

export const ruleResultSchema = z.strictObject({
  ruleCode: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
  outcome: z.enum(['triggered', 'reinforced', 'informational', 'notEligible']),
  observedMinor: amountMinorSchema.nullable(),
  thresholdMinor: amountMinorSchema.nullable(),
  observedBasisPoints: basisPointsSchema.nullable(),
  thresholdBasisPoints: basisPointsSchema.nullable(),
  reasonCodes: z
    .array(reasonCodeSchema)
    .max(6)
    .refine(uniqueStrings, 'must contain unique values'),
});

export const baselineDetailSchema = z.strictObject({
  method: z.enum(['seasonalMedianMad', 'rollingMedianMad', 'equivalentPeriodMedianMad']),
  windowStart: calendarDateSchema,
  windowEnd: calendarDateSchema,
  sampleCount: nonNegativeIntegerSchema,
  activePeriodCount: nonNegativeIntegerSchema,
  robustCenterMinor: amountMinorSchema.nullable(),
  dispersionMinor: nonNegativeAmountMinorSchema.nullable(),
  expectedRange: expectedMoneyRangeSchema.nullable(),
  exclusionCounts: z.strictObject({
    pending: nonNegativeIntegerSchema,
    transfer: nonNegativeIntegerSchema,
    income: nonNegativeIntegerSchema,
    refund: nonNegativeIntegerSchema,
    unclassifiedCredit: nonNegativeIntegerSchema,
    knownRecurring: nonNegativeIntegerSchema,
    policyExcluded: nonNegativeIntegerSchema,
  }),
});

export const comparisonRowSchema = z.strictObject({
  period: periodSchema,
  value: moneyValueSchema.nullable(),
  eligible: z.boolean(),
  contribution: z.enum(['triggered', 'reinforced', 'informational', 'notEligible']),
  sampleCount: nonNegativeIntegerSchema,
  medianMinor: amountMinorSchema.nullable(),
  dispersionMinor: nonNegativeAmountMinorSchema.nullable(),
  empiricalPercentileBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  ratioBasisPoints: basisPointsSchema.nullable(),
});

export const contributorSchema = z.strictObject({
  rank: z.number().int().positive().max(10),
  sourceRef: sourceReferenceSchema,
  occurredOn: calendarDateSchema,
  displayName: normalizedDisplayNameSchema,
  amount: moneyValueSchema,
  contributionMinor: amountMinorSchema,
});

export const evidenceRecordSchema = z.strictObject({
  source: z.enum(['monarchBridge', 'owl']),
  evidenceType: z.enum([
    'transaction',
    'recurringItem',
    'categoryProjection',
    'billingPeriod',
    'billAmount',
    'usage',
  ]),
  observedAt: utcTimestampSchema,
  documentRef: sourceReferenceSchema.nullable(),
  normalizedValueMinor: amountMinorSchema.nullable(),
  normalizedUnit: z.enum(['currencyMinor', 'days', 'usageUnit']).nullable(),
});

export const lifecycleHistoryEntrySchema = z.strictObject({
  sequence: positiveSequenceSchema,
  state: z.enum([
    'analyzing',
    'insufficientBaseline',
    'unavailable',
    'open',
    'resolved',
    'superseded',
  ]),
  reasonCode: reasonCodeSchema.nullable(),
  occurredAt: utcTimestampSchema,
  replacementOccurrenceId: occurrenceIdSchema.nullable(),
});

export const suppressionStatusSchema = z
  .strictObject({
    state: z.enum(['none', 'active', 'expired', 'undone']),
    suppressionId: sourceReferenceSchema.nullable(),
    scope: z.enum(['occurrence', 'entity', 'category']).nullable(),
    durationDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).nullable(),
    operator: z.literal('fixedLocalOperator').nullable(),
    createdAt: utcTimestampSchema.nullable(),
    expiresAt: utcTimestampSchema.nullable(),
    undoneAt: utcTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    const metadataFields = [
      'suppressionId',
      'scope',
      'durationDays',
      'operator',
      'createdAt',
      'expiresAt',
      'undoneAt',
    ] as const;
    if (value.state === 'none') {
      for (const field of metadataFields) {
        if (value[field] !== null) {
          addIssue(context, [field], 'must be null when state is none');
        }
      }
    }
    if (value.state !== 'none') {
      for (const field of [
        'suppressionId',
        'scope',
        'durationDays',
        'operator',
        'createdAt',
        'expiresAt',
      ] as const) {
        if (value[field] === null) addIssue(context, [field], 'is required');
      }
    }
    if (value.state === 'active' && value.undoneAt !== null) {
      addIssue(context, ['undoneAt'], 'must be null for an active suppression');
    }
    if (value.state === 'expired' && value.undoneAt !== null) {
      addIssue(context, ['undoneAt'], 'must be null for an expired suppression');
    }
    if (value.state === 'undone' && value.undoneAt === null) {
      addIssue(context, ['undoneAt'], 'is required for an undone suppression');
    }
    if (
      value.createdAt !== null &&
      value.expiresAt !== null &&
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    ) {
      addIssue(context, ['expiresAt'], 'must be later than createdAt');
    }
    if (
      value.createdAt !== null &&
      value.expiresAt !== null &&
      value.durationDays !== null &&
      Date.parse(value.expiresAt) - Date.parse(value.createdAt) !==
        value.durationDays * 24 * 60 * 60 * 1_000
    ) {
      addIssue(
        context,
        ['expiresAt'],
        'must equal createdAt plus the selected durationDays'
      );
    }
    if (
      value.undoneAt !== null &&
      value.createdAt !== null &&
      Date.parse(value.undoneAt) < Date.parse(value.createdAt)
    ) {
      addIssue(context, ['undoneAt'], 'must be on or after createdAt');
    }
    if (
      value.state === 'undone' &&
      value.undoneAt !== null &&
      value.expiresAt !== null &&
      Date.parse(value.undoneAt) >= Date.parse(value.expiresAt)
    ) {
      addIssue(context, ['undoneAt'], 'must be earlier than expiresAt');
    }
  });

export const availableActionSchema = z.enum([
  'expected',
  'notUseful',
  'suppress30Days',
  'suppress90Days',
  'suppress180Days',
  'undoSuppression',
]);

const detailObjectSchema = z.strictObject({
  ...summaryShape,
  ruleResults: z.array(ruleResultSchema).max(12),
  baseline: baselineDetailSchema.nullable(),
  comparisons: z.array(comparisonRowSchema).max(36),
  contributors: z
    .array(contributorSchema)
    .max(10)
    .refine(
      (values) => values.every((value, index) => value.rank === index + 1),
      'must have contiguous ranks starting at one'
    ),
  exclusions: z
    .array(reasonCodeSchema)
    .max(12)
    .refine(uniqueStrings, 'must contain unique values'),
  evidence: z.array(evidenceRecordSchema).max(8),
  lifecycleHistory: z
    .array(lifecycleHistoryEntrySchema)
    .max(50)
    .refine(
      (values) =>
        values.every(
          (value, index) => index === 0 || value.sequence > values[index - 1]!.sequence
        ),
      'must have strictly increasing sequence values'
    ),
  suppression: suppressionStatusSchema,
  availableActions: z
    .array(availableActionSchema)
    .max(6)
    .refine(uniqueStrings, 'must contain unique values'),
});

export const insightOccurrenceDetailSchema =
  detailObjectSchema.superRefine((value, context) => {
    validateSummary(value, context);
    validateLifecycleHistory(value, context);
    const hasUndo = value.availableActions.includes('undoSuppression');
    if (value.suppression.state === 'active' && !hasUndo) {
      addIssue(
        context,
        ['availableActions'],
        'must include undoSuppression for an active suppression'
      );
    }
    if (value.suppression.state !== 'active' && hasUndo) {
      addIssue(
        context,
        ['availableActions'],
        'may include undoSuppression only for an active suppression'
      );
    }
    if (
      value.suppression.state === 'active' &&
      value.availableActions.some((action) => action.startsWith('suppress'))
    ) {
      addIssue(
        context,
        ['availableActions'],
        'must not offer another suppression while one is active'
      );
    }
    if (
      value.sourceLifecycle !== 'open' &&
      value.availableActions.length > 0
    ) {
      addIssue(
        context,
        ['availableActions'],
        'must be empty unless the occurrence is open'
      );
    }
    if (
      value.sourceLifecycle !== 'open' &&
      value.suppression.state === 'active'
    ) {
      addIssue(
        context,
        ['suppression'],
        'cannot remain active when the occurrence is not open'
      );
    }
  });

export type InsightKindV1 = z.infer<typeof insightKindSchema>;
export type AnalysisStateV1 = z.infer<typeof analysisStateSchema>;
export type SourceLifecycleV1 = z.infer<typeof sourceLifecycleSchema>;
export type SeverityV1 = z.infer<typeof severitySchema>;
export type ConfidenceV1 = z.infer<typeof confidenceSchema>;
export type BaselineSufficiencyV1 = z.infer<
  typeof baselineSufficiencySchema
>;
export type FreshnessStateV1 = z.infer<typeof freshnessStateSchema>;
export type ReasonCodeV1 = z.infer<typeof reasonCodeSchema>;
export type InsightEntityV1 = z.infer<typeof insightEntitySchema>;
export type InsightOccurrenceSummaryV1 = z.infer<
  typeof insightOccurrenceSummarySchema
>;
export type InsightOccurrenceDetailV1 = z.infer<
  typeof insightOccurrenceDetailSchema
>;
export type SuppressionStatusV1 = z.infer<typeof suppressionStatusSchema>;
export type AvailableActionV1 = z.infer<typeof availableActionSchema>;
export type EvidenceRecordV1 = z.infer<typeof evidenceRecordSchema>;

export function parseInsightOccurrenceSummaryV1(
  value: unknown
): InsightOccurrenceSummaryV1 {
  return parseContractV1(
    insightOccurrenceSummarySchema,
    value,
    'insight occurrence summary'
  );
}

export function parseInsightOccurrenceDetailV1(
  value: unknown
): InsightOccurrenceDetailV1 {
  return parseContractV1(
    insightOccurrenceDetailSchema,
    value,
    'insight occurrence detail'
  );
}

function validateSummary(
  value: z.infer<typeof summaryObjectSchema>,
  context: z.RefinementCtx
): void {
  const isQualified = value.analysisState === 'qualified';
  if (isQualified !== (value.sourceLifecycle !== null)) {
    addIssue(
      context,
      ['sourceLifecycle'],
      'must be present exactly when analysisState is qualified'
    );
  }
  if (isQualified && value.observedValue === null) {
    addIssue(context, ['observedValue'], 'is required for a qualified occurrence');
  }
  const expectedEntityKind: Record<
    z.infer<typeof insightKindSchema>,
    z.infer<typeof insightEntitySchema>['kind']
  > = {
    recurringAmountChange: 'recurring',
    largeTransaction: 'transaction',
    categoryVariance: 'category',
    merchantVariance: 'merchant',
  };
  if (value.entity.kind !== expectedEntityKind[value.kind]) {
    addIssue(
      context,
      ['entity', 'kind'],
      `must be ${expectedEntityKind[value.kind]} for ${value.kind}`
    );
  }
  if (
    isQualified &&
    value.baselineSufficiency === 'insufficient' &&
    (value.kind !== 'largeTransaction' ||
      !value.reasonCodes.includes('explicit_amount_rule_exceeded'))
  ) {
    addIssue(
      context,
      ['baselineSufficiency'],
      'must not be insufficient for this qualified adaptive insight'
    );
  }
  if (value.sourceLifecycle === 'open') {
    if (
      value.resolutionReason !== null ||
      value.resolvedAt !== null ||
      value.supersededByOccurrenceId !== null
    ) {
      addIssue(context, ['sourceLifecycle'], 'open lifecycle cannot be resolved');
    }
  }
  if (value.sourceLifecycle === 'resolved') {
    if (value.resolutionReason === null || value.resolvedAt === null) {
      addIssue(
        context,
        ['resolutionReason'],
        'resolved lifecycle requires a reason and resolvedAt'
      );
    }
    if (value.supersededByOccurrenceId !== null) {
      addIssue(
        context,
        ['supersededByOccurrenceId'],
        'must be null for resolved lifecycle'
      );
    }
  }
  if (value.sourceLifecycle === 'superseded') {
    if (
      value.resolutionReason === null ||
      value.resolvedAt === null ||
      value.supersededByOccurrenceId === null
    ) {
      addIssue(
        context,
        ['supersededByOccurrenceId'],
        'superseded lifecycle requires reason, replacement, and resolvedAt'
      );
    }
    if (value.supersededByOccurrenceId === value.occurrenceId) {
      addIssue(
        context,
        ['supersededByOccurrenceId'],
        'must identify a different successor occurrence'
      );
    }
  }
  if (value.sourceLifecycle === null) {
    if (
      value.resolutionReason !== null ||
      value.resolvedAt !== null ||
      value.supersededByOccurrenceId !== null
    ) {
      addIssue(
        context,
        ['sourceLifecycle'],
        'non-qualified analysis cannot carry source lifecycle resolution'
      );
    }
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    addIssue(context, ['updatedAt'], 'must be on or after createdAt');
  }
  if (
    value.resolvedAt !== null &&
    Date.parse(value.resolvedAt) < Date.parse(value.createdAt)
  ) {
    addIssue(context, ['resolvedAt'], 'must be on or after createdAt');
  }
  if (
    value.resolvedAt !== null &&
    Date.parse(value.resolvedAt) > Date.parse(value.updatedAt)
  ) {
    addIssue(context, ['resolvedAt'], 'must be on or before updatedAt');
  }
  if (value.freshness.sourceAsOf !== value.provenance.sourceAsOf) {
    addIssue(
      context,
      ['freshness', 'sourceAsOf'],
      'must match provenance sourceAsOf'
    );
  }
  if (
    value.freshness.state === 'fresh' &&
    value.provenance.completeness !== 'complete'
  ) {
    addIssue(
      context,
      ['freshness', 'state'],
      'fresh source data must be complete'
    );
  }
  const expectedCompleteness = {
    stale: 'complete',
    partial: 'partial',
    unavailable: 'unavailable',
  } as const;
  if (
    value.freshness.state !== 'fresh' &&
    value.provenance.completeness !==
      expectedCompleteness[value.freshness.state]
  ) {
    addIssue(
      context,
      ['provenance', 'completeness'],
      `must be ${expectedCompleteness[value.freshness.state]} for ${value.freshness.state} freshness`
    );
  }
  if (value.freshness.state === 'fresh') {
    const sourceTime = Date.parse(value.provenance.sourceAsOf);
    const completedTime = Date.parse(value.provenance.evaluationCompletedAt);
    const maximumAgeMilliseconds =
      value.freshness.maxAgeHours * 60 * 60 * 1_000;
    if (
      sourceTime > completedTime ||
      completedTime - sourceTime > maximumAgeMilliseconds
    ) {
      addIssue(
        context,
        ['freshness', 'state'],
        'fresh source data must be within maxAgeHours at evaluation completion'
      );
    }
  }
  const monetaryCurrencies = [
    value.observedValue?.currency,
    value.expectedRange?.currency,
    value.absoluteDelta?.currency,
  ].filter((currency): currency is string => currency !== undefined);
  const detail = value as Partial<z.infer<typeof detailObjectSchema>>;
  if (detail.baseline?.expectedRange) {
    monetaryCurrencies.push(detail.baseline.expectedRange.currency);
  }
  for (const comparison of detail.comparisons ?? []) {
    if (comparison.value !== null) {
      monetaryCurrencies.push(comparison.value.currency);
    }
  }
  for (const contributor of detail.contributors ?? []) {
    monetaryCurrencies.push(contributor.amount.currency);
  }
  if (monetaryCurrencies.some((currency) => currency !== value.currency)) {
    addIssue(
      context,
      ['currency'],
      'must match every monetary value currency'
    );
  }

}

function validateLifecycleHistory(
  value: z.infer<typeof detailObjectSchema>,
  context: z.RefinementCtx
): void {
  if (value.lifecycleHistory.length === 0) {
    addIssue(context, ['lifecycleHistory'], 'must include at least one state');
    return;
  }
  if (value.lifecycleHistory[0]!.state !== 'analyzing') {
    addIssue(context, ['lifecycleHistory', 0, 'state'], 'must begin with analyzing');
  }
  const allowedTransitions: Readonly<Record<string, readonly string[]>> = {
    analyzing: ['open', 'insufficientBaseline', 'unavailable'],
    insufficientBaseline: ['analyzing'],
    unavailable: ['analyzing'],
    open: ['resolved', 'superseded'],
    resolved: [],
    superseded: [],
  };
  for (let index = 1; index < value.lifecycleHistory.length; index += 1) {
    const previousEntry = value.lifecycleHistory[index - 1]!;
    const currentEntry = value.lifecycleHistory[index]!;
    const previous = previousEntry.state;
    const current = currentEntry.state;
    if (!allowedTransitions[previous]!.includes(current)) {
      addIssue(
        context,
        ['lifecycleHistory', index, 'state'],
        `cannot follow ${previous}`
      );
    }
    if (Date.parse(currentEntry.occurredAt) < Date.parse(previousEntry.occurredAt)) {
      addIssue(
        context,
        ['lifecycleHistory', index, 'occurredAt'],
        'must be on or after the preceding lifecycle event'
      );
    }
  }
  const expectedTerminalState =
    value.analysisState === 'qualified'
      ? value.sourceLifecycle
      : value.analysisState;
  const terminal = value.lifecycleHistory[value.lifecycleHistory.length - 1]!.state;
  if (terminal !== expectedTerminalState) {
    addIssue(
      context,
      ['lifecycleHistory'],
      'terminal state must match the current analysis and source lifecycle'
    );
  }
  const terminalEntry = value.lifecycleHistory[value.lifecycleHistory.length - 1]!;
  for (let index = 0; index < value.lifecycleHistory.length; index += 1) {
    if (
      Date.parse(value.lifecycleHistory[index]!.occurredAt) >
      Date.parse(value.updatedAt)
    ) {
      addIssue(
        context,
        ['lifecycleHistory', index, 'occurredAt'],
        'must be on or before updatedAt'
      );
    }
  }
  if (value.sourceLifecycle === 'resolved' || value.sourceLifecycle === 'superseded') {
    if (
      terminalEntry.reasonCode !== value.resolutionReason ||
      terminalEntry.occurredAt !== value.resolvedAt ||
      terminalEntry.replacementOccurrenceId !== value.supersededByOccurrenceId
    ) {
      addIssue(
        context,
        ['lifecycleHistory'],
        'terminal resolution metadata must match the occurrence lifecycle'
      );
    }
  } else if (
    value.sourceLifecycle === 'open' &&
    (terminalEntry.reasonCode !== null ||
      terminalEntry.replacementOccurrenceId !== null)
  ) {
    addIssue(
      context,
      ['lifecycleHistory'],
      'open terminal history must not carry resolution metadata'
    );
  }
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueCanonicalValues(values: readonly unknown[]): boolean {
  const canonical = values.map((value) =>
    canonicalizeV1(value as Parameters<typeof canonicalizeV1>[0])
  );
  return new Set(canonical).size === canonical.length;
}

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string
): void {
  context.addIssue({ code: 'custom', path, message });
}
