import type { KidProfile, Transaction, ThresholdStatus } from './types.js';

/**
 * Compute threshold status for a kid given their attributed transactions
 * within each time window.
 */
export function checkThresholds(
  kid: KidProfile,
  transactions: Transaction[],
  now: Date = new Date()
): ThresholdStatus[] {
  const results: ThresholdStatus[] = [];

  const dailyTotal = sumTransactionsInPeriod(transactions, 'daily', now);
  const weeklyTotal = sumTransactionsInPeriod(transactions, 'weekly', now);
  const monthlyTotal = sumTransactionsInPeriod(transactions, 'monthly', now);

  results.push(
    buildStatus(kid, 'daily', kid.thresholds.daily, dailyTotal),
    buildStatus(kid, 'weekly', kid.thresholds.weekly, weeklyTotal),
    buildStatus(kid, 'monthly', kid.thresholds.monthly, monthlyTotal)
  );

  return results;
}

/**
 * Sum transaction amounts within a given time period.
 */
export function sumTransactionsInPeriod(
  transactions: Transaction[],
  period: 'daily' | 'weekly' | 'monthly',
  now: Date
): number {
  const start = getPeriodStart(period, now);

  return transactions
    .filter((t) => new Date(t.date) >= start && new Date(t.date) <= now)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
}

/**
 * Get the start of a time period relative to `now`.
 */
export function getPeriodStart(
  period: 'daily' | 'weekly' | 'monthly',
  now: Date
): Date {
  const start = new Date(now);

  switch (period) {
    case 'daily':
      start.setHours(0, 0, 0, 0);
      break;
    case 'weekly': {
      // Monday start
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'monthly':
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      break;
  }

  return start;
}

function buildStatus(
  kid: KidProfile,
  period: 'daily' | 'weekly' | 'monthly',
  limit: number,
  spent: number
): ThresholdStatus {
  const percentage = limit > 0 ? (spent / limit) * 100 : 0;

  let severity: ThresholdStatus['severity'];
  if (percentage >= 150) {
    severity = 'high';
  } else if (percentage >= 100) {
    severity = 'medium';
  } else if (percentage >= 80) {
    severity = 'low';
  } else {
    severity = 'ok';
  }

  return {
    kidId: kid.id,
    kidName: kid.name,
    period,
    limit,
    spent: Math.round(spent * 100) / 100,
    percentage: Math.round(percentage * 100) / 100,
    severity,
  };
}
