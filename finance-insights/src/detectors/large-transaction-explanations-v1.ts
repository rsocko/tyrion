export const LARGE_TRANSACTION_EXPLANATION_TEMPLATE_VERSION_V1 =
  'large-transaction-explanation-v1' as const;

export interface LargeTransactionExplanationInputV1 {
  readonly observedMinor: number;
  readonly currency: string;
  readonly explicitRuleMinor: number;
  readonly meaningfulFloorMinor: number;
  readonly explicitTriggered: boolean;
  readonly eligibleDimensionCount: number;
  readonly triggeredDimensionCount: number;
}

export interface LargeTransactionExplanationV1 {
  readonly headline: string;
  readonly explanation: string;
}

export function explainLargeTransactionV1(
  input: LargeTransactionExplanationInputV1
): LargeTransactionExplanationV1 {
  const amount = `${input.observedMinor} ${input.currency} minor units`;
  const agreement = `${input.triggeredDimensionCount} of ${input.eligibleDimensionCount} eligible prior-spending comparisons`;
  if (input.explicitTriggered && input.triggeredDimensionCount >= 2) {
    return {
      headline: `Large household spending exception: ${amount}`,
      explanation:
        `This posted transaction met the ${input.explicitRuleMinor} ${input.currency} minor-unit household rule, ` +
        `and ${agreement} agreed that it was unusually large.`,
    };
  }
  if (input.explicitTriggered) {
    return {
      headline: `Large household spending exception: ${amount}`,
      explanation:
        `This posted transaction met the ${input.explicitRuleMinor} ${input.currency} minor-unit household rule. ` +
        `Adaptive comparisons were insufficient or did not agree; the household rule alone qualified it.`,
    };
  }
  return {
    headline: `Unusually large household transaction: ${amount}`,
    explanation:
      `This posted transaction met the ${input.meaningfulFloorMinor} ${input.currency} minor-unit adaptive floor, ` +
      `and ${agreement} agreed that it was unusually large.`,
  };
}
