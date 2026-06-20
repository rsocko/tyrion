import type {
  KidProfile,
  Transaction,
  CardRule,
  MerchantRule,
  HistoricalAssignment,
} from './types.js';

export interface CardMatch {
  kidId: string;
  kidName: string;
  confidence: 'definite' | 'likely';
  rule: CardRule;
}

export interface MerchantMatch {
  kidId: string;
  kidName: string;
  confidence: 'definite' | 'likely';
  rule: MerchantRule;
}

export interface PatternMatch {
  kidId: string;
  kidName: string;
  count: number;
  total: number;
}

/**
 * Check if a transaction's card (last 4) matches any kid's card rules.
 */
export function matchCardRules(
  transaction: Transaction,
  kids: KidProfile[]
): CardMatch | null {
  const accountMask = transaction.account.mask;

  for (const kid of kids) {
    for (const rule of kid.cardRules) {
      if (rule.last4 === accountMask) {
        return {
          kidId: kid.id,
          kidName: kid.name,
          confidence: rule.confidence,
          rule,
        };
      }
    }
  }

  return null;
}

/**
 * Check if a transaction's merchant matches any kid's merchant rules.
 * Uses case-insensitive substring matching.
 */
export function matchMerchantRules(
  transaction: Transaction,
  kids: KidProfile[]
): MerchantMatch | null {
  const merchantUpper = transaction.merchantName.toUpperCase();

  for (const kid of kids) {
    for (const rule of kid.merchantRules) {
      const patternUpper = rule.pattern.toUpperCase();
      if (merchantUpper.includes(patternUpper)) {
        return {
          kidId: kid.id,
          kidName: kid.name,
          confidence: rule.confidence,
          rule,
        };
      }
    }
  }

  return null;
}

/**
 * Check historical assignments to see if a merchant has been consistently
 * assigned to one kid. Requires 3+ assignments to the same kid.
 */
export function matchHistoricalPattern(
  transaction: Transaction,
  history: HistoricalAssignment[],
  kids: KidProfile[],
  minAssignments: number = 3
): PatternMatch | null {
  const merchantUpper = transaction.merchantName.toUpperCase();

  // Find all historical assignments for this merchant
  const relevantHistory = history.filter(
    (h) => h.merchantName.toUpperCase() === merchantUpper
  );

  if (relevantHistory.length === 0) return null;

  // Find the kid with the most assignments
  const sorted = [...relevantHistory].sort((a, b) => b.count - a.count);
  const top = sorted[0];

  if (top.count < minAssignments) return null;

  const kid = kids.find((k) => k.id === top.kidId);
  if (!kid) return null;

  const totalAssignments = relevantHistory.reduce((sum, h) => sum + h.count, 0);

  return {
    kidId: kid.id,
    kidName: kid.name,
    count: top.count,
    total: totalAssignments,
  };
}
