import { describe, it, expect } from 'vitest';
import { attributeTransaction, type EngineConfig } from '../src/engine.js';
import { matchAccountRules, matchMerchantRules, matchHistoricalPattern } from '../src/rules.js';
import { checkThresholds, sumTransactionsInPeriod, getPeriodStart } from '../src/thresholds.js';
import { generateSuggestions } from '../src/suggestions.js';
import type {
  KidProfile,
  Transaction,
  HistoricalAssignment,
} from '../src/types.js';

// --- Test Fixtures ---

const jake: KidProfile = {
  id: 'jake',
  name: 'Jake',
  color: 'blue',
  accountRules: [{ accountRef: 'acct-jake', confidence: 'definite', label: 'Jake account' }],
  merchantRules: [
    { pattern: 'ROBLOX', confidence: 'definite' },
    { pattern: 'STEAM', confidence: 'definite' },
    { pattern: 'EPIC GAMES', confidence: 'definite' },
    { pattern: 'GAMESTOP', confidence: 'likely' },
    { pattern: 'FIVE BELOW', confidence: 'likely' },
    { pattern: 'CHICK-FIL-A', confidence: 'likely' },
  ],
  thresholds: { daily: 30, weekly: 100, monthly: 300 },
};

const emma: KidProfile = {
  id: 'emma',
  name: 'Emma',
  color: 'purple',
  accountRules: [{ accountRef: 'acct-emma', confidence: 'definite', label: 'Emma account' }],
  merchantRules: [
    { pattern: 'SEPHORA', confidence: 'likely' },
    { pattern: 'ULTA', confidence: 'likely' },
    { pattern: 'SHEIN', confidence: 'likely' },
    { pattern: 'STARBUCKS', confidence: 'likely' },
  ],
  thresholds: { daily: 25, weekly: 80, monthly: 250 },
};

const sophie: KidProfile = {
  id: 'sophie',
  name: 'Sophie',
  color: 'green',
  accountRules: [],
  merchantRules: [
    { pattern: 'SCHOOL LUNCH', confidence: 'definite' },
    { pattern: 'SCHOLASTIC', confidence: 'definite' },
    { pattern: "CLAIRE'S", confidence: 'likely' },
  ],
  thresholds: { daily: 15, weekly: 50, monthly: 150 },
};

const kids = [jake, emma, sophie];

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    merchantName: 'UNKNOWN MERCHANT',
    amount: 10.0,
    date: '2026-06-18T12:00:00Z',
    account: { ref: 'acct-parent' },
    ...overrides,
  };
}

// --- Card Rule Tests ---

describe('Account Rule Matching', () => {
  it('matches Jake account with definite confidence', () => {
    const tx = makeTx({ account: { ref: 'acct-jake' } });
    const result = matchAccountRules(tx, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('jake');
    expect(result!.confidence).toBe('definite');
  });

  it('matches Emma account with definite confidence', () => {
    const tx = makeTx({ account: { ref: 'acct-emma' } });
    const result = matchAccountRules(tx, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('emma');
    expect(result!.confidence).toBe('definite');
  });

  it('returns null for unknown account', () => {
    const tx = makeTx({ account: { ref: 'acct-unknown' } });
    const result = matchAccountRules(tx, kids);
    expect(result).toBeNull();
  });

  it('account rule produces auto-assigned triage status in engine', () => {
    const tx = makeTx({ account: { ref: 'acct-jake' }, merchantName: 'WALMART' });
    const config: EngineConfig = { kids, history: [] };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('account-rule');
    expect(result.triageStatus).toBe('auto-assigned');
    expect(result.kidId).toBe('jake');
  });
});

// --- Merchant Rule Tests ---

describe('Merchant Rule Matching', () => {
  it('matches exact merchant name', () => {
    const tx = makeTx({ merchantName: 'ROBLOX' });
    const result = matchMerchantRules(tx, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('jake');
    expect(result!.confidence).toBe('definite');
  });

  it('matches substring (merchant contains pattern)', () => {
    const tx = makeTx({ merchantName: 'ROBLOX CORPORATION #12345' });
    const result = matchMerchantRules(tx, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('jake');
  });

  it('matches case-insensitively', () => {
    const tx = makeTx({ merchantName: 'Sephora Store #42' });
    const result = matchMerchantRules(tx, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('emma');
    expect(result!.confidence).toBe('likely');
  });

  it('matches Sophie school lunch (definite)', () => {
    const tx = makeTx({ merchantName: 'SCHOOL LUNCH - WESTVIEW ELEMENTARY' });
    const result = matchMerchantRules(tx, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('sophie');
    expect(result!.confidence).toBe('definite');
  });

  it('returns null for unknown merchant', () => {
    const tx = makeTx({ merchantName: 'TARGET' });
    const result = matchMerchantRules(tx, kids);
    expect(result).toBeNull();
  });

  it('merchant definite rule produces auto-assigned', () => {
    const tx = makeTx({ merchantName: 'ROBLOX PREMIUM', account: { ref: 'acct-parent' } });
    const config: EngineConfig = { kids, history: [] };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('merchant-rule');
    expect(result.triageStatus).toBe('auto-assigned');
    expect(result.confidence).toBe('definite');
  });

  it('merchant likely rule produces pending-confirmation', () => {
    const tx = makeTx({ merchantName: 'GAMESTOP #1234', account: { ref: 'acct-parent' } });
    const config: EngineConfig = { kids, history: [] };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('merchant-rule');
    expect(result.triageStatus).toBe('pending-confirmation');
    expect(result.confidence).toBe('likely');
  });
});

// --- Historical Pattern Tests ---

describe('Historical Pattern Matching', () => {
  const history: HistoricalAssignment[] = [
    { merchantName: 'CHIPOTLE', kidId: 'jake', count: 8 },
    { merchantName: 'CHIPOTLE', kidId: 'emma', count: 2 },
    { merchantName: 'SUBWAY', kidId: 'sophie', count: 2 },
  ];

  it('matches when kid has 3+ assignments', () => {
    const tx = makeTx({ merchantName: 'CHIPOTLE' });
    const result = matchHistoricalPattern(tx, history, kids);
    expect(result).not.toBeNull();
    expect(result!.kidId).toBe('jake');
    expect(result!.count).toBe(8);
    expect(result!.total).toBe(10);
  });

  it('does not match below threshold', () => {
    const tx = makeTx({ merchantName: 'SUBWAY' });
    const result = matchHistoricalPattern(tx, history, kids);
    expect(result).toBeNull();
  });

  it('pattern match produces pending-confirmation in engine', () => {
    const tx = makeTx({ merchantName: 'CHIPOTLE', account: { ref: 'acct-parent' } });
    const config: EngineConfig = { kids, history };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('historical-pattern');
    expect(result.triageStatus).toBe('pending-confirmation');
    expect(result.confidence).toBe('likely');
  });
});

// --- Unmatched Transactions ---

describe('Unmatched Transactions', () => {
  it('returns unassigned for completely unknown transaction', () => {
    const tx = makeTx({ merchantName: 'RANDOM STORE', account: { ref: 'acct-unknown' } });
    const config: EngineConfig = { kids, history: [] };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('unassigned');
    expect(result.triageStatus).toBe('pending');
    expect(result.kidId).toBeNull();
    expect(result.kidName).toBeNull();
    expect(result.confidence).toBeNull();
  });

  it('does not match partial merchant name incorrectly', () => {
    // "GAME" should not match "GAMESTOP" or "EPIC GAMES" since pattern check is contains
    // but "GAME" is not one of the patterns
    const tx = makeTx({ merchantName: 'GAME' });
    const config: EngineConfig = { kids, history: [] };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('unassigned');
  });
});

// --- Threshold Tests ---

describe('Threshold Checking', () => {
  const now = new Date('2026-06-18T15:00:00Z'); // Wednesday

  const txsToday: Transaction[] = [
    makeTx({ id: 'tx-a', amount: 12.5, date: '2026-06-18T09:00:00Z' }),
    makeTx({ id: 'tx-b', amount: 8.0, date: '2026-06-18T11:00:00Z' }),
  ];

  it('reports ok when under 80% of limit', () => {
    const results = checkThresholds(jake, txsToday, now);
    const daily = results.find((r) => r.period === 'daily')!;
    // $20.5 / $30 = 68.3%
    expect(daily.severity).toBe('ok');
    expect(daily.spent).toBe(20.5);
  });

  it('reports low (heads-up) at 80% of limit', () => {
    const txs = [
      makeTx({ id: 'tx-a', amount: 25.0, date: '2026-06-18T09:00:00Z' }),
    ];
    const results = checkThresholds(jake, txs, now);
    const daily = results.find((r) => r.period === 'daily')!;
    // $25 / $30 = 83.3%
    expect(daily.severity).toBe('low');
  });

  it('reports medium when at 100% of limit', () => {
    const txs = [
      makeTx({ id: 'tx-a', amount: 30.0, date: '2026-06-18T09:00:00Z' }),
    ];
    const results = checkThresholds(jake, txs, now);
    const daily = results.find((r) => r.period === 'daily')!;
    expect(daily.severity).toBe('medium');
  });

  it('reports high when at 150%+ of limit', () => {
    const txs = [
      makeTx({ id: 'tx-a', amount: 50.0, date: '2026-06-18T09:00:00Z' }),
    ];
    const results = checkThresholds(jake, txs, now);
    const daily = results.find((r) => r.period === 'daily')!;
    // $50 / $30 = 166.7%
    expect(daily.severity).toBe('high');
  });

  it('computes weekly totals correctly', () => {
    // Thursday June 18. Week starts Monday June 15.
    const txs = [
      makeTx({ id: 'tx-mon', amount: 20.0, date: '2026-06-15T10:00:00Z' }),
      makeTx({ id: 'tx-tue', amount: 30.0, date: '2026-06-17T10:00:00Z' }),
      makeTx({ id: 'tx-wed', amount: 15.0, date: '2026-06-18T10:00:00Z' }),
      // This one from last week (Sunday) should NOT count
      makeTx({ id: 'tx-old', amount: 99.0, date: '2026-06-14T10:00:00Z' }),
    ];
    const results = checkThresholds(jake, txs, now);
    const weekly = results.find((r) => r.period === 'weekly')!;
    expect(weekly.spent).toBe(65);
  });

  it('only counts transactions within the current month', () => {
    const txs = [
      makeTx({ id: 'tx-jun', amount: 100.0, date: '2026-06-10T10:00:00Z' }),
      // May transaction should NOT count
      makeTx({ id: 'tx-may', amount: 200.0, date: '2026-05-30T10:00:00Z' }),
    ];
    const results = checkThresholds(jake, txs, now);
    const monthly = results.find((r) => r.period === 'monthly')!;
    expect(monthly.spent).toBe(100);
  });
});

// --- Rule Suggestion Tests ---

describe('Rule Suggestions', () => {
  it('suggests a rule when merchant assigned to same kid 5+ times', () => {
    const history: HistoricalAssignment[] = [
      { merchantName: 'CHIPOTLE', kidId: 'jake', count: 6 },
      { merchantName: 'CHIPOTLE', kidId: 'emma', count: 1 },
    ];
    const suggestions = generateSuggestions(history, kids);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kidId).toBe('jake');
    expect(suggestions[0].merchantPattern).toBe('CHIPOTLE');
    expect(suggestions[0].suggestedConfidence).toBe('likely');
  });

  it('suggests definite when ratio >= 90%', () => {
    const history: HistoricalAssignment[] = [
      { merchantName: 'PIZZA HUT', kidId: 'emma', count: 10 },
      { merchantName: 'PIZZA HUT', kidId: 'jake', count: 1 },
    ];
    const suggestions = generateSuggestions(history, kids);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestedConfidence).toBe('definite');
  });

  it('does not suggest when below minimum assignments', () => {
    const history: HistoricalAssignment[] = [
      { merchantName: 'NEW PLACE', kidId: 'jake', count: 3 },
    ];
    const suggestions = generateSuggestions(history, kids);
    expect(suggestions).toHaveLength(0);
  });

  it('does not suggest when ratio is too low (shared merchant)', () => {
    const history: HistoricalAssignment[] = [
      { merchantName: 'MCDONALD', kidId: 'jake', count: 5 },
      { merchantName: 'MCDONALD', kidId: 'emma', count: 4 },
      { merchantName: 'MCDONALD', kidId: 'sophie', count: 3 },
    ];
    const suggestions = generateSuggestions(history, kids);
    // 5/12 = 0.42, below 0.7 threshold
    expect(suggestions).toHaveLength(0);
  });

  it('does not suggest if rule already exists', () => {
    const history: HistoricalAssignment[] = [
      { merchantName: 'ROBLOX', kidId: 'jake', count: 20 },
    ];
    const suggestions = generateSuggestions(history, kids);
    // ROBLOX already in Jake's merchant rules
    expect(suggestions).toHaveLength(0);
  });
});

// --- Edge Cases ---

describe('Edge Cases', () => {
  it('account rule takes priority over merchant rule', () => {
    // Transaction on Jake's account at a merchant matching Emma
    const tx = makeTx({
      merchantName: 'SEPHORA STORE',
      account: { ref: 'acct-jake' },
    });
    const config: EngineConfig = { kids, history: [] };
    const result = attributeTransaction(tx, config);
    // Account rule wins
    expect(result.kidId).toBe('jake');
    expect(result.method).toBe('account-rule');
  });

  it('merchant rule takes priority over historical pattern', () => {
    const history: HistoricalAssignment[] = [
      { merchantName: 'STARBUCKS', kidId: 'jake', count: 10 },
    ];
    const tx = makeTx({ merchantName: 'STARBUCKS', account: { ref: 'acct-parent' } });
    const config: EngineConfig = { kids, history };
    const result = attributeTransaction(tx, config);
    // Merchant rule for Emma wins over historical pattern for Jake
    expect(result.kidId).toBe('emma');
    expect(result.method).toBe('merchant-rule');
  });

  it('handles empty kid profiles gracefully', () => {
    const tx = makeTx({ merchantName: 'ANYTHING' });
    const config: EngineConfig = { kids: [], history: [] };
    const result = attributeTransaction(tx, config);
    expect(result.method).toBe('unassigned');
  });

  it('handles negative amounts (refunds)', () => {
    const txs = [
      makeTx({ id: 'tx-a', amount: -15.0, date: '2026-06-18T09:00:00Z' }),
    ];
    const now = new Date('2026-06-18T15:00:00Z');
    const results = checkThresholds(jake, txs, now);
    const daily = results.find((r) => r.period === 'daily')!;
    // Uses Math.abs, so refund counts as spending for threshold purposes
    expect(daily.spent).toBe(15);
  });
});
