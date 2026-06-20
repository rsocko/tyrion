export interface KidProfile {
  id: string;
  name: string;
  color: string;
  cardRules: CardRule[];
  merchantRules: MerchantRule[];
  thresholds: ThresholdConfig;
}

export interface CardRule {
  last4: string;
  confidence: 'definite' | 'likely';
  label?: string;
}

export interface MerchantRule {
  pattern: string;
  confidence: 'definite' | 'likely';
}

export interface ThresholdConfig {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface Transaction {
  id: string;
  merchantName: string;
  amount: number;
  date: string; // ISO date string
  account: {
    mask: string; // last 4 digits
    name?: string;
  };
}

export type AttributionMethod =
  | 'card-rule'
  | 'merchant-rule'
  | 'historical-pattern'
  | 'unassigned';

export type TriageStatus = 'auto-assigned' | 'pending-confirmation' | 'pending';

export interface AttributionResult {
  transactionId: string;
  kidId: string | null;
  kidName: string | null;
  confidence: 'definite' | 'likely' | null;
  method: AttributionMethod;
  triageStatus: TriageStatus;
  matchedRule?: string;
}

export interface ThresholdStatus {
  kidId: string;
  kidName: string;
  period: 'daily' | 'weekly' | 'monthly';
  limit: number;
  spent: number;
  percentage: number;
  severity: 'ok' | 'low' | 'medium' | 'high';
}

export interface RuleSuggestion {
  kidId: string;
  kidName: string;
  merchantPattern: string;
  assignmentCount: number;
  totalOccurrences: number;
  suggestedConfidence: 'definite' | 'likely';
}

export interface HistoricalAssignment {
  merchantName: string;
  kidId: string;
  count: number;
}
