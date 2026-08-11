import type { BaselineSufficiencyV1, ConfidenceV1 } from '../contracts/occurrence-v1.js';

export const VARIANCE_EXPLANATION_TEMPLATE_VERSION_V1 =
  'variance-explanation-v1' as const;

export interface VarianceExplanationInputV1 {
  displayName: string;
  entityKind: 'category' | 'merchant';
  direction: 'increase' | 'decrease';
  currency: string;
  observedMinor: number;
  baselineMinor: number;
  absoluteDeltaMinor: number;
  percentageDeltaBasisPoints: number | null;
  baselinePeriods: number;
  baselineSufficiency: BaselineSufficiencyV1;
  confidence: ConfidenceV1;
  isZeroBaseline: boolean;
}

export function varianceHeadlineV1(input: VarianceExplanationInputV1): string {
  if (input.baselineSufficiency === 'insufficient') {
    return `${input.displayName} has insufficient comparable history`;
  }
  return `${input.displayName} spending ${input.direction === 'increase' ? 'increased' : 'decreased'} by ${formatMoneyMinorV1(
    Math.abs(input.absoluteDeltaMinor),
    input.currency
  )}`;
}

export function varianceExplanationV1(input: VarianceExplanationInputV1): string {
  const identity =
    input.entityKind === 'merchant' ? 'merchant' : 'category';
  if (input.baselineSufficiency === 'insufficient') {
    return `${input.displayName} has ${formatMoneyMinorV1(
      input.observedMinor,
      input.currency
    )} in current ${identity} spending, but the versioned coverage rule was not met. Confidence is ${input.confidence}; no notification is eligible.`;
  }
  if (input.isZeroBaseline) {
    return `${input.displayName} has ${formatMoneyMinorV1(
      input.observedMinor,
      input.currency
    )} in new ${identity} spending after zero spending in ${input.baselinePeriods} comparable periods. Percentage change is not defined; confidence is ${input.confidence}.`;
  }
  const percentage = formatBasisPointsV1(input.percentageDeltaBasisPoints!);
  return `${input.displayName} spending ${input.direction === 'increase' ? 'rose' : 'fell'} to ${formatMoneyMinorV1(
    input.observedMinor,
    input.currency
  )} from a comparable-period median of ${formatMoneyMinorV1(
    input.baselineMinor,
    input.currency
  )} (${percentage}). All material gates passed; confidence is ${input.confidence}.`;
}

export function formatMoneyMinorV1(amountMinor: number, currency: string): string {
  return `${amountMinor} ${currency} minor units`;
}

function formatBasisPointsV1(basisPoints: number): string {
  const sign = basisPoints > 0 ? '+' : basisPoints < 0 ? '-' : '';
  const absolute = Math.abs(basisPoints);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(
    2,
    '0'
  )}%`;
}
