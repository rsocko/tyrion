import type {
  KidProfile,
  HistoricalAssignment,
  RuleSuggestion,
} from './types.js';

export interface SuggestionOptions {
  /** Minimum assignments to same kid to trigger a suggestion (default: 5) */
  minAssignments: number;
  /** Minimum ratio of assignments to one kid vs total for that merchant (default: 0.7) */
  minRatio: number;
}

const DEFAULT_OPTIONS: SuggestionOptions = {
  minAssignments: 5,
  minRatio: 0.7,
};

/**
 * Generate rule suggestions based on historical assignment patterns.
 * Suggests creating a rule when a merchant has been assigned to the same kid
 * repeatedly without an existing rule.
 */
export function generateSuggestions(
  history: HistoricalAssignment[],
  kids: KidProfile[],
  options: Partial<SuggestionOptions> = {}
): RuleSuggestion[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const suggestions: RuleSuggestion[] = [];

  // Group history by merchant
  const merchantGroups = new Map<string, HistoricalAssignment[]>();
  for (const entry of history) {
    const key = entry.merchantName.toUpperCase();
    const group = merchantGroups.get(key) || [];
    group.push(entry);
    merchantGroups.set(key, group);
  }

  for (const [merchantKey, entries] of merchantGroups) {
    const totalAssignments = entries.reduce((sum, e) => sum + e.count, 0);

    // Find the dominant kid
    const sorted = [...entries].sort((a, b) => b.count - a.count);
    const top = sorted[0];

    if (top.count < opts.minAssignments) continue;

    const ratio = top.count / totalAssignments;
    if (ratio < opts.minRatio) continue;

    const kid = kids.find((k) => k.id === top.kidId);
    if (!kid) continue;

    // Check if a rule already exists for this merchant
    const hasExistingRule = kid.merchantRules.some(
      (r) => r.pattern.toUpperCase() === merchantKey
    );
    if (hasExistingRule) continue;

    suggestions.push({
      kidId: kid.id,
      kidName: kid.name,
      merchantPattern: top.merchantName,
      assignmentCount: top.count,
      totalOccurrences: totalAssignments,
      suggestedConfidence: ratio >= 0.9 ? 'definite' : 'likely',
    });
  }

  return suggestions;
}
