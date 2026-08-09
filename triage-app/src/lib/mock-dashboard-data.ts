// Synthetic mock: all people, relationships, records, identifiers, amounts, limits, dates, and entity associations are invented.
export interface SummaryCard {
  label: string;
  value: string;
  trend: string;
  trendColor: string;
}

export interface KidWeeklySpending {
  id: string;
  name: string;
  color: string;
  spent: number;
  limit: number;
  warning?: string;
}

export interface BudgetItem {
  category: string;
  spent: number;
  budget: number;
}

export interface FinanceAlert {
  id: string;
  message: string;
  detail: string;
  severity: "red" | "yellow" | "blue";
}

export interface UpcomingBill {
  id: string;
  name: string;
  dueDate: string;
  amount: number;
}

export const summaryCards: SummaryCard[] = [
  { label: "Total Spent", value: "$4,832", trend: "↑ 8% vs last month", trendColor: "text-red-400" },
  { label: "Income", value: "$7,200", trend: "On track", trendColor: "text-green-400" },
  { label: "Kids Spending", value: "$847", trend: "Jake over weekly limit", trendColor: "text-yellow-400" },
  { label: "Needs Review", value: "12", trend: "Open Triage →", trendColor: "text-accent" },
];

export const kidsWeekly: KidWeeklySpending[] = [
  { id: "jake", name: "Jake", color: "blue", spent: 112, limit: 100, warning: "⚠️ Over weekly limit by $12" },
  { id: "emma", name: "Emma", color: "purple", spent: 63, limit: 80 },
  { id: "sophie", name: "Sophie", color: "green", spent: 28, limit: 50 },
];

export const budgetItems: BudgetItem[] = [
  { category: "Groceries", spent: 680, budget: 700 },
  { category: "Dining Out", spent: 420, budget: 350 },
  { category: "Shopping", spent: 180, budget: 400 },
  { category: "Subscriptions", spent: 156, budget: 175 },
  { category: "Transportation", spent: 220, budget: 300 },
  { category: "Kids - Activities", spent: 340, budget: 500 },
];

export const financeAlerts: FinanceAlert[] = [
  { id: "a1", message: "Jake exceeded weekly limit", detail: "$112 / $100 • 2 hours ago", severity: "red" },
  { id: "a2", message: "Dining Out over budget", detail: "$420 / $350 • Today", severity: "yellow" },
  { id: "a3", message: "New subscription detected", detail: "Cursor Pro $20/mo • Jun 15", severity: "blue" },
];

export const upcomingBills: UpcomingBill[] = [
  { id: "b1", name: "Mortgage", dueDate: "Jun 25", amount: 2450 },
  { id: "b2", name: "Electric (PSE&G)", dueDate: "Jun 28", amount: 185 },
  { id: "b3", name: "Car Insurance", dueDate: "Jul 1", amount: 312 },
  { id: "b4", name: "Internet (Verizon)", dueDate: "Jul 3", amount: 89 },
];
