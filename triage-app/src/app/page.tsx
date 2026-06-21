"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { KidBadge } from "@/components/ui/KidBadge";
import {
  summaryCards,
  kidsWeekly,
  budgetItems,
  financeAlerts,
  upcomingBills,
  BudgetItem,
  UpcomingBill,
} from "@/lib/mock-dashboard-data";
import { getAccounts, getBudgets, getCashflow, getRecurring } from "@/lib/bridge-client";
import { setDataSourcePreference } from "@/lib/use-data-source";

const alertColorMap = {
  red: { bg: "bg-red-950/30", border: "border-red-900/50", dot: "text-red-400" },
  yellow: { bg: "bg-yellow-950/30", border: "border-yellow-900/50", dot: "text-yellow-400" },
  blue: { bg: "bg-zinc-800/50", border: "border-border", dot: "text-blue-400" },
};

const kidBarColors: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  green: "bg-green-500",
};

interface LiveDashboardData {
  income: number;
  expenses: number;
  accounts: number;
  budgets: BudgetItem[];
  bills: UpcomingBill[];
}

export default function DashboardPage() {
  const [dataSource, setDataSource] = useState<"mock" | "live">("mock");
  const [liveData, setLiveData] = useState<LiveDashboardData | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);

  // Load persisted data source preference
  useEffect(() => {
    try {
      const saved = localStorage.getItem("finance-data-source");
      if (saved === "live" || saved === "mock") setDataSource(saved);
    } catch {}
  }, []);

  const handleSetDataSource = (source: "mock" | "live") => {
    setDataSource(source);
    setDataSourcePreference(source);
  };

  useEffect(() => {
    if (dataSource === "live") {
      setLiveLoading(true);
      Promise.all([getCashflow(), getAccounts(), getBudgets(), getRecurring()])
        .then(([cashRes, accRes, budgetRes, recurringRes]) => {
          const data: LiveDashboardData = {
            income: 0,
            expenses: 0,
            accounts: 0,
            budgets: [],
            bills: [],
          };

          if (cashRes.data && accRes.data) {
            data.income = cashRes.data.totalIncome;
            data.expenses = Math.abs(cashRes.data.totalExpenses);
            data.accounts = accRes.data.accounts.length;
          }

          // Map budget data
          if (budgetRes.data && Array.isArray(budgetRes.data.budgets) && budgetRes.data.budgets.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.budgets = budgetRes.data.budgets.slice(0, 6).map((b: any) => ({
              category: b.category?.name || b.name || "Unknown",
              spent: Math.abs(b.currentAmount || b.spent || 0),
              budget: b.budgetAmount || b.limit || b.budget || 0,
            }));
          }

          // Map recurring bills
          if (recurringRes.data && Array.isArray(recurringRes.data.recurring) && recurringRes.data.recurring.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.bills = recurringRes.data.recurring.slice(0, 5).map((r: any, i: number) => ({
              id: r.id || `recurring-${i}`,
              name: r.name || r.merchant?.name || "Unknown",
              dueDate: r.nextDate || r.nextDueDate || "Upcoming",
              amount: Math.abs(r.amount || 0),
            }));
          }

          setLiveData(data);
        })
        .finally(() => setLiveLoading(false));
    }
  }, [dataSource]);

  const displaySummary = dataSource === "live" && liveData
    ? [
        { ...summaryCards[0], value: `$${liveData.income.toLocaleString()}` },
        { ...summaryCards[1], value: `$${liveData.expenses.toLocaleString()}` },
        { ...summaryCards[2], value: `${liveData.accounts} accounts` },
        summaryCards[3],
      ]
    : summaryCards;

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Finance Dashboard</h1>
          <p className="text-sm text-muted mt-1">June 2026 • Week 3</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* Data Source Toggle */}
          <div className="flex items-center gap-1 mr-4 bg-[#141414] border border-[#262626] rounded-lg p-0.5">
            <button
              onClick={() => handleSetDataSource("mock")}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${
                dataSource === "mock" ? "bg-[#262626] text-white" : "text-muted hover:text-white"
              }`}
            >
              Mock Data
            </button>
            <button
              onClick={() => handleSetDataSource("live")}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${
                dataSource === "live" ? "bg-emerald-900/50 text-emerald-400 border border-emerald-800/50" : "text-muted hover:text-white"
              }`}
            >
              Live Data
            </button>
          </div>
          <button className="px-3 py-1.5 rounded-md text-sm bg-card border border-border">This Month</button>
          <button className="px-3 py-1.5 rounded-md text-sm text-muted border border-border/50">Last Month</button>
          <button className="px-3 py-1.5 rounded-md text-sm text-muted border border-border/50">Custom</button>
        </div>
      </div>

      {liveLoading && dataSource === "live" && (
        <div className="mb-4 px-3 py-2 rounded-md bg-emerald-950/20 border border-emerald-900/30 text-xs text-emerald-400">
          Fetching live data from Monarch Money...
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {displaySummary.map((card) => (
          <div key={card.label} className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted uppercase tracking-wider">{card.label}</p>
            <p className="text-2xl font-bold mt-1">{card.value}</p>
            <p className={`text-xs ${card.trendColor} mt-1`}>
              {card.label === "Needs Review" ? (
                <Link href="/triage" className="hover:underline">{card.trend}</Link>
              ) : (
                card.trend
              )}
            </p>
          </div>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-3 gap-6">
        {/* Left: Per-Kid Spending */}
        <div className="col-span-1 bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">Kids This Week</h2>

          {dataSource === "live" ? (
            <div className="border border-dashed border-[#333] rounded-lg p-4">
              <p className="text-sm text-[#666]">Coming Soon</p>
              <p className="text-xs text-[#555] mt-1">Configure kid rules in Settings to track per-kid spending automatically.</p>
              <Link href="/settings" className="text-xs text-accent hover:underline mt-3 block">
                Configure Kids →
              </Link>
            </div>
          ) : (
            <>
              {kidsWeekly.map((kid) => (
                <div key={kid.id} className="mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <KidBadge name={kid.name} color={kid.color} />
                    <span className="text-sm font-mono">
                      ${kid.spent}{" "}
                      <span className={kid.spent > kid.limit ? "text-red-400" : "text-muted"}>/ ${kid.limit}</span>
                    </span>
                  </div>
                  <ProgressBar value={kid.spent} max={kid.limit} color={kidBarColors[kid.color]} showOverflow />
                  {kid.warning && <p className="text-xs text-red-400 mt-1">{kid.warning}</p>}
                </div>
              ))}
            </>
          )}

          <Link href="/kids" className="text-xs text-accent hover:underline mt-2 block">
            View kid details →
          </Link>
        </div>

        {/* Center: Budget vs Actual */}
        <div className="col-span-1 bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">Budget vs Actual</h2>

          {dataSource === "live" ? (
            liveData && liveData.budgets.length > 0 ? (
              <div className="space-y-3">
                {liveData.budgets.map((item) => {
                  const isOver = item.spent > item.budget;
                  const isNear = item.budget > 0 && item.spent / item.budget > 0.9;
                  const color = isOver ? "text-red-400" : isNear ? "text-yellow-400" : "text-muted";
                  const barColor = isOver ? "bg-red-400" : isNear ? "bg-yellow-400" : "bg-zinc-500";
                  return (
                    <div key={item.category}>
                      <div className="flex justify-between text-xs mb-1">
                        <span>{item.category}</span>
                        <span className={color}>${item.spent} / ${item.budget}</span>
                      </div>
                      <ProgressBar value={item.spent} max={item.budget || 1} color={barColor} height="h-1.5" />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="border border-dashed border-[#333] rounded-lg p-4">
                <p className="text-sm text-[#666]">No Budgets Configured</p>
                <p className="text-xs text-[#555] mt-1">Set up budgets in Monarch to see progress here.</p>
              </div>
            )
          ) : (
            <div className="space-y-3">
              {budgetItems.map((item) => {
                const isOver = item.spent > item.budget;
                const isNear = item.spent / item.budget > 0.9;
                const color = isOver ? "text-red-400" : isNear ? "text-yellow-400" : "text-muted";
                const barColor = isOver ? "bg-red-400" : isNear ? "bg-yellow-400" : "bg-zinc-500";
                return (
                  <div key={item.category}>
                    <div className="flex justify-between text-xs mb-1">
                      <span>{item.category}</span>
                      <span className={color}>${item.spent} / ${item.budget}</span>
                    </div>
                    <ProgressBar value={item.spent} max={item.budget} color={barColor} height="h-1.5" />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Alerts + Upcoming Bills */}
        <div className="col-span-1 space-y-4">
          {/* Alerts */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">Finance Alerts</h2>
            {dataSource === "live" ? (
              <div className="border border-dashed border-[#333] rounded-lg p-4">
                <p className="text-sm text-[#666]">Coming Soon</p>
                <p className="text-xs text-[#555] mt-1">Alerts will appear once spending patterns are analyzed.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {financeAlerts.map((alert) => {
                  const colors = alertColorMap[alert.severity];
                  return (
                    <div key={alert.id} className={`flex items-start gap-2 p-2 rounded-lg ${colors.bg} border ${colors.border}`}>
                      <span className={`${colors.dot} text-xs mt-0.5`}>●</span>
                      <div>
                        <p className="text-xs font-medium">{alert.message}</p>
                        <p className="text-xs text-muted">{alert.detail}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Upcoming Bills */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">Upcoming Bills</h2>
            {dataSource === "live" ? (
              liveData && liveData.bills.length > 0 ? (
                <div className="space-y-2">
                  {liveData.bills.map((bill, i) => (
                    <div
                      key={bill.id}
                      className={`flex justify-between items-center py-1.5 ${
                        i < liveData.bills.length - 1 ? "border-b border-border/50" : ""
                      }`}
                    >
                      <div>
                        <p className="text-xs font-medium">{bill.name}</p>
                        <p className="text-xs text-muted">{bill.dueDate}</p>
                      </div>
                      <span className="text-sm font-mono">${bill.amount.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="border border-dashed border-[#333] rounded-lg p-4">
                  <p className="text-sm text-[#666]">No Recurring Bills</p>
                  <p className="text-xs text-[#555] mt-1">No recurring bills found in Monarch.</p>
                </div>
              )
            ) : (
              <div className="space-y-2">
                {upcomingBills.map((bill, i) => (
                  <div
                    key={bill.id}
                    className={`flex justify-between items-center py-1.5 ${
                      i < upcomingBills.length - 1 ? "border-b border-border/50" : ""
                    }`}
                  >
                    <div>
                      <p className="text-xs font-medium">{bill.name}</p>
                      <p className="text-xs text-muted">{bill.dueDate}</p>
                    </div>
                    <span className="text-sm font-mono">${bill.amount.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            <Link href="/bills" className="text-xs text-accent hover:underline mt-3 block">
              View full calendar →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
