// Synthetic mock: all people, relationships, records, identifiers, amounts, limits, dates, and entity associations are invented.
export interface KidProfile {
  id: string;
  name: string;
  color: string;
  totalSpent: number;
  monthlyLimit: number;
  weeklyLimit: number;
  dailyLimit: number;
  todaySpent: number;
  weeklySpent: number;
}

export interface KidCategory {
  name: string;
  amount: number;
  percent: number;
}

export interface KidTransaction {
  id: string;
  merchant: string;
  amount: number;
  date: string;
  dateLabel: string;
  card: string;
  category: string;
  attribution: string;
  attributionColor: string;
  icon: string;
}

export interface DiscussionItem {
  id: string;
  title: string;
  description: string;
}

export interface KidData {
  profile: KidProfile;
  categories: KidCategory[];
  transactions: KidTransaction[];
  discussions: DiscussionItem[];
}

const jakeData: KidData = {
  profile: {
    id: "jake",
    name: "Jake",
    color: "blue",
    totalSpent: 347,
    monthlyLimit: 300,
    weeklyLimit: 100,
    dailyLimit: 30,
    todaySpent: 14.32,
    weeklySpent: 112,
  },
  categories: [
    { name: "Gaming", amount: 142, percent: 41 },
    { name: "Food & Dining", amount: 98, percent: 28 },
    { name: "Entertainment", amount: 62, percent: 18 },
    { name: "Shopping", amount: 45, percent: 13 },
  ],
  transactions: [
    { id: "jt1", merchant: "Chick-fil-A #02341", amount: -14.32, date: "2026-06-20", dateLabel: "Today — Jun 20", card: "Chase ...9876", category: "Food & Dining", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🍗" },
    { id: "jt2", merchant: "Steam Purchase", amount: -59.99, date: "2026-06-18", dateLabel: "Jun 18", card: "Amex ...1234", category: "Gaming", attribution: "manual assignment", attributionColor: "text-yellow-400", icon: "🎮" },
    { id: "jt3", merchant: "McDonald's #38291", amount: -12.48, date: "2026-06-18", dateLabel: "Jun 18", card: "Chase ...9876", category: "Food & Dining", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🍔" },
    { id: "jt4", merchant: "Roblox Premium", amount: -12.99, date: "2026-06-16", dateLabel: "Jun 16", card: "Jake's Debit ...4521", category: "Gaming", attribution: "auto: card rule", attributionColor: "text-green-400", icon: "🎮" },
    { id: "jt5", merchant: "Five Below", amount: -24.50, date: "2026-06-16", dateLabel: "Jun 16", card: "Chase ...9876", category: "Shopping", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🛒" },
    { id: "jt6", merchant: "AMC Theatres", amount: -18.50, date: "2026-06-14", dateLabel: "Jun 14", card: "Jake's Debit ...4521", category: "Entertainment", attribution: "auto: card rule", attributionColor: "text-green-400", icon: "🎬" },
    { id: "jt7", merchant: "Epic Games Store", amount: -39.99, date: "2026-06-14", dateLabel: "Jun 14", card: "Amex ...1234", category: "Gaming", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🎮" },
  ],
  discussions: [
    { id: "d1", title: "Steam Purchase — $59.99", description: "Pushed him over weekly gaming limit. Talk about game purchasing habits?" },
  ],
};

const emmaData: KidData = {
  profile: {
    id: "emma",
    name: "Emma",
    color: "purple",
    totalSpent: 198,
    monthlyLimit: 250,
    weeklyLimit: 80,
    dailyLimit: 25,
    todaySpent: 0,
    weeklySpent: 63,
  },
  categories: [
    { name: "Beauty", amount: 72, percent: 36 },
    { name: "Subscriptions", amount: 48, percent: 24 },
    { name: "Shopping", amount: 45, percent: 23 },
    { name: "Food & Dining", amount: 33, percent: 17 },
  ],
  transactions: [
    { id: "et1", merchant: "Sephora #1892", amount: -34.50, date: "2026-06-16", dateLabel: "Jun 16", card: "Amex ...7890", category: "Beauty", attribution: "auto: card rule", attributionColor: "text-green-400", icon: "💄" },
    { id: "et2", merchant: "Spotify USA", amount: -15.99, date: "2026-06-15", dateLabel: "Jun 15", card: "Chase Freedom ...5678", category: "Subscriptions", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🎵" },
    { id: "et3", merchant: "Apple.com/bill", amount: -2.99, date: "2026-06-12", dateLabel: "Jun 12", card: "Amex ...7890", category: "Subscriptions", attribution: "auto: card rule", attributionColor: "text-green-400", icon: "☁️" },
    { id: "et4", merchant: "H&M Online", amount: -45.00, date: "2026-06-10", dateLabel: "Jun 10", card: "Chase ...9876", category: "Shopping", attribution: "manual assignment", attributionColor: "text-yellow-400", icon: "👗" },
  ],
  discussions: [],
};

const sophieData: KidData = {
  profile: {
    id: "sophie",
    name: "Sophie",
    color: "green",
    totalSpent: 142,
    monthlyLimit: 200,
    weeklyLimit: 50,
    dailyLimit: 20,
    todaySpent: 0,
    weeklySpent: 28,
  },
  categories: [
    { name: "Gaming", amount: 52, percent: 37 },
    { name: "Food & Dining", amount: 38, percent: 27 },
    { name: "Shopping", amount: 32, percent: 22 },
    { name: "Activities", amount: 20, percent: 14 },
  ],
  transactions: [
    { id: "st1", merchant: "Roblox *Purchase", amount: -19.99, date: "2026-06-13", dateLabel: "Jun 13", card: "Amex ...1234", category: "Gaming", attribution: "manual assignment", attributionColor: "text-yellow-400", icon: "🎮" },
    { id: "st2", merchant: "Five Below #892", amount: -22.50, date: "2026-06-12", dateLabel: "Jun 12", card: "Chase Freedom ...5678", category: "Shopping", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🛒" },
    { id: "st3", merchant: "McDonald's #12482", amount: -8.47, date: "2026-06-14", dateLabel: "Jun 14", card: "Chase ...9876", category: "Food & Dining", attribution: "auto: merchant rule", attributionColor: "text-blue-400", icon: "🍔" },
  ],
  discussions: [
    { id: "sd1", title: "Roblox *Purchase — $19.99", description: "3 Roblox purchases this week totaling $45. Monthly limit is $30." },
  ],
};

export const kidsData: Record<string, KidData> = {
  jake: jakeData,
  emma: emmaData,
  sophie: sophieData,
};

export const kidsList = [
  { id: "jake", name: "Jake", color: "blue" },
  { id: "emma", name: "Emma", color: "purple" },
  { id: "sophie", name: "Sophie", color: "green" },
];
