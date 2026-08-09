// Synthetic mock: all people, relationships, records, identifiers, amounts, limits, dates, and entity associations are invented.
export interface Bill {
  id: string;
  name: string;
  provider: string;
  amount: number;
  dueDate: string;
  dueDateDisplay: string;
  paymentMethod: string;
  autoPay: boolean;
  icon: string;
  iconBg: string;
  urgent?: boolean;
}

export interface BillWeek {
  label: string;
  dateRange: string;
  total: number;
  count: number;
  bills: Bill[];
}

export interface CashFlowProjection {
  currentBalance: number;
  projectedBalance: number;
  totalBills: number;
  discretionary: number;
  status: string;
  statusColor: string;
}

export const weekSummary = [
  { label: "This Week", total: 2635, count: 3 },
  { label: "Next Week", total: 401, count: 4 },
  { label: "Week 3", total: 870, count: 3 },
  { label: "Week 4", total: 312, count: 2 },
];

export const billWeeks: BillWeek[] = [
  {
    label: "This Week",
    dateRange: "Jun 20–26",
    total: 2635,
    count: 3,
    bills: [
      { id: "bw1-1", name: "Mortgage", provider: "Chase Home Lending", amount: 2450, dueDate: "2026-06-25", dueDateDisplay: "Due Jun 25", paymentMethod: "Checking ...2341", autoPay: true, icon: "🏠", iconBg: "bg-red-900/20" },
      { id: "bw1-2", name: "Electric (PSE&G)", provider: "PSE&G", amount: 185, dueDate: "2026-06-22", dueDateDisplay: "Due Jun 22 (2 days)", paymentMethod: "Checking ...2341", autoPay: false, icon: "⚡", iconBg: "bg-yellow-900/20", urgent: true },
    ],
  },
  {
    label: "Next Week",
    dateRange: "Jun 27–Jul 3",
    total: 401,
    count: 4,
    bills: [
      { id: "bw2-1", name: "Internet (Verizon FiOS)", provider: "Verizon", amount: 89, dueDate: "2026-06-28", dueDateDisplay: "Due Jun 28", paymentMethod: "Amex ...1234", autoPay: true, icon: "🌐", iconBg: "bg-blue-900/20" },
      { id: "bw2-2", name: "Car Insurance (Progressive)", provider: "Progressive", amount: 312, dueDate: "2026-07-01", dueDateDisplay: "Due Jul 1", paymentMethod: "Checking ...2341", autoPay: true, icon: "🚗", iconBg: "bg-blue-900/20" },
      { id: "bw2-3", name: "Cell Phone (T-Mobile)", provider: "T-Mobile", amount: 185, dueDate: "2026-07-02", dueDateDisplay: "Due Jul 2", paymentMethod: "Amex ...1234", autoPay: true, icon: "📱", iconBg: "bg-purple-900/20" },
    ],
  },
  {
    label: "Week 3",
    dateRange: "Jul 4–10",
    total: 870,
    count: 3,
    bills: [
      { id: "bw3-1", name: "Water/Sewer", provider: "Municipal", amount: 210, dueDate: "2026-07-05", dueDateDisplay: "Due Jul 5", paymentMethod: "Checking ...2341", autoPay: false, icon: "💧", iconBg: "bg-green-900/20" },
      { id: "bw3-2", name: "Gym Membership", provider: "LA Fitness", amount: 49, dueDate: "2026-07-07", dueDateDisplay: "Due Jul 7", paymentMethod: "Chase ...9876", autoPay: true, icon: "🏋️", iconBg: "bg-orange-900/20" },
      { id: "bw3-3", name: "Subscriptions Bundle", provider: "Netflix ($22) + Spotify ($17) + iCloud ($10) + Disney+ ($14)", amount: 63, dueDate: "2026-07-07", dueDateDisplay: "Jul 7–10", paymentMethod: "Various cards", autoPay: true, icon: "🎵", iconBg: "bg-pink-900/20" },
    ],
  },
];

export const cashFlow: CashFlowProjection = {
  currentBalance: 8420,
  projectedBalance: 4202,
  totalBills: 4218,
  discretionary: 1800,
  status: "✓ You're in good shape — projected balance stays above $4,000 through July 20.",
  statusColor: "text-green-300",
};
