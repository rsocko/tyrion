import type {
  RecurringAmountAnalysisStateV1,
  RecurringAmountExplanationInputV1,
} from './recurring-amount-v1.js';

export const RECURRING_AMOUNT_EXPLANATION_TEMPLATE_VERSION_V1 =
  'recurring-amount-explanations-v1' as const;

export interface RecurringAmountExplanationV1 {
  headline: string;
  explanation: string;
}

export function explainRecurringAmountV1(
  input: RecurringAmountExplanationInputV1
): RecurringAmountExplanationV1 {
  const stateCopy: Record<RecurringAmountAnalysisStateV1, string> = {
    qualifiedIncrease:
      'The posted amount is above the same-season expected range and exceeds both household policy gates.',
    decreaseAnalysisOnly:
      'The posted amount is below the same-season expected range, but decreases are analysis-only in v1.',
    withinExpectedRange:
      'The posted amount remains within the same-season expected range or does not exceed both household policy gates.',
    insufficientBaseline:
      'There are not yet two prior seasonal years for a reliable same-season comparison.',
    unavailable:
      'A reliable recurring amount comparison is unavailable for this billing period.',
  };
  const evidenceCopy = input.periodNormalized
    ? ' Billing-period evidence was used to compare an equivalent 30-day amount.'
    : input.optionalEvidenceAvailable
      ? ' Normalized optional evidence was retained as context.'
      : ' No normalized document evidence was available, so no period or usage adjustment was invented.';
  const usageCopy = input.usageContextAvailable
    ? ' Normalized usage evidence is available to explain part of the movement.'
    : '';

  return {
    headline: headlineFor(input.displayName, input.state),
    explanation: `${stateCopy[input.state]}${evidenceCopy}${usageCopy}`,
  };
}

function headlineFor(
  displayName: string,
  state: RecurringAmountAnalysisStateV1
): string {
  switch (state) {
    case 'qualifiedIncrease':
      return `${displayName} is above its expected seasonal range`;
    case 'decreaseAnalysisOnly':
      return `${displayName} is below its expected seasonal range`;
    case 'withinExpectedRange':
      return `${displayName} is within its expected seasonal range`;
    case 'insufficientBaseline':
      return `${displayName} needs more seasonal history`;
    case 'unavailable':
      return `${displayName} could not be compared reliably`;
  }
}
