import type {
  KidProfile,
  Transaction,
  AttributionResult,
  HistoricalAssignment,
} from './types.js';
import { matchAccountRules, matchMerchantRules, matchHistoricalPattern } from './rules.js';

export interface EngineConfig {
  kids: KidProfile[];
  history: HistoricalAssignment[];
  /** Minimum historical assignments to consider a pattern match (default: 3) */
  minPatternAssignments?: number;
}

/**
 * Main attribution engine. Given a transaction, determine which kid (if any)
 * it belongs to using the priority order:
 * 1. Account rules (highest confidence)
 * 2. Merchant rules
 * 3. Historical patterns
 * 4. Unassigned (triage required)
 */
export function attributeTransaction(
  transaction: Transaction,
  config: EngineConfig
): AttributionResult {
  const { kids, history, minPatternAssignments } = config;

  // 1. Account rule match
  const accountMatch = matchAccountRules(transaction, kids);
  if (accountMatch) {
    return {
      transactionId: transaction.id,
      kidId: accountMatch.kidId,
      kidName: accountMatch.kidName,
      confidence: accountMatch.confidence,
      method: 'account-rule',
      triageStatus:
        accountMatch.confidence === 'definite'
          ? 'auto-assigned'
          : 'pending-confirmation',
      matchedRule: `account:${accountMatch.rule.accountRef}`,
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
