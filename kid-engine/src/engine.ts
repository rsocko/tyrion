import type {
  KidProfile,
  Transaction,
  AttributionResult,
  HistoricalAssignment,
} from './types.js';
import { matchCardRules, matchMerchantRules, matchHistoricalPattern } from './rules.js';

export interface EngineConfig {
  kids: KidProfile[];
  history: HistoricalAssignment[];
  /** Minimum historical assignments to consider a pattern match (default: 3) */
  minPatternAssignments?: number;
}

/**
 * Main attribution engine. Given a transaction, determine which kid (if any)
 * it belongs to using the priority order:
 * 1. Card rules (highest confidence)
 * 2. Merchant rules
 * 3. Historical patterns
 * 4. Unassigned (triage required)
 */
export function attributeTransaction(
  transaction: Transaction,
  config: EngineConfig
): AttributionResult {
  const { kids, history, minPatternAssignments } = config;

  // 1. Card rule match
  const cardMatch = matchCardRules(transaction, kids);
  if (cardMatch) {
    return {
      transactionId: transaction.id,
      kidId: cardMatch.kidId,
      kidName: cardMatch.kidName,
      confidence: cardMatch.confidence,
      method: 'card-rule',
      triageStatus:
        cardMatch.confidence === 'definite'
          ? 'auto-assigned'
          : 'pending-confirmation',
      matchedRule: `card:${cardMatch.rule.last4}`,
    };
  }

  // 2. Merchant rule match
  const merchantMatch = matchMerchantRules(transaction, kids);
  if (merchantMatch) {
    return {
      transactionId: transaction.id,
      kidId: merchantMatch.kidId,
      kidName: merchantMatch.kidName,
      confidence: merchantMatch.confidence,
      method: 'merchant-rule',
      triageStatus:
        merchantMatch.confidence === 'definite'
          ? 'auto-assigned'
          : 'pending-confirmation',
      matchedRule: `merchant:${merchantMatch.rule.pattern}`,
    };
  }

  // 3. Historical pattern match
  const patternMatch = matchHistoricalPattern(
    transaction,
    history,
    kids,
    minPatternAssignments
  );
  if (patternMatch) {
    return {
      transactionId: transaction.id,
      kidId: patternMatch.kidId,
      kidName: patternMatch.kidName,
      confidence: 'likely',
      method: 'historical-pattern',
      triageStatus: 'pending-confirmation',
      matchedRule: `pattern:${patternMatch.count}/${patternMatch.total}`,
    };
  }

  // 4. No match — triage required
  return {
    transactionId: transaction.id,
    kidId: null,
    kidName: null,
    confidence: null,
    method: 'unassigned',
    triageStatus: 'pending',
  };
}

/**
 * Batch attribution for multiple transactions.
 */
export function attributeTransactions(
  transactions: Transaction[],
  config: EngineConfig
): AttributionResult[] {
  return transactions.map((t) => attributeTransaction(t, config));
}
