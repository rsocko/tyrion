// Types adapted from kid-engine for use in the triage UI

export interface KidProfile {
  id: string;
  name: string;
  color: string; // tailwind color prefix (blue, purple, green)
}

export type TriageStatus = 'uncategorized' | 'suggested-kid' | 'flagged' | 'category-mismatch';

export type AttributionMethod = 'account-rule' | 'merchant-rule' | 'historical-pattern' | 'unassigned';

export interface TriageTransaction {
  id: string;
  merchantName: string;
  amount: number;
  date: string;
  cardLabel: string;
  cardLast4: string;
  originalCategory?: string;
  triageStatus: TriageStatus;

  // Kid suggestion
  suggestedKidId?: string;
  suggestedKidName?: string;
  suggestionReason?: string;
  suggestionConfidence?: 'definite' | 'likely';

  // Flag info
  flagReason?: string;

  // Category suggestions
  suggestedCategories?: string[];
}

export interface RuleSuggestion {
  merchantPattern: string;
  kidName: string;
  assignmentCount: number;
  suggestedConfidence: 'definite' | 'likely';
}

export type FilterTab = 'all' | 'uncategorized' | 'unassigned' | 'flagged';
