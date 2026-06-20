"use client";

import Link from "next/link";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { KidBadge } from "@/components/ui/KidBadge";
import {
  summaryCards,
  kidsWeekly,
  budgetItems,
  financeAlerts,
  upcomingBills,
} from "@/lib/mock-dashboard-data";

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

export default function DashboardPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Finance Dashboard</h1>
          <p className="text-sm text-muted mt-1">June 2026 • Week 3</p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 rounded-md text-sm bg-card border border-border">This Month</button>
          <button className="px-3 py-1.5 rounded-md text-sm text-muted border border-border/50">Last Month</button>
          <button className="px-3 py-1.5 rounded-md text-sm text-muted border border-border/50">Custom</button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {summaryCards.map((card) => (
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

          <Link href="/kids" className="text-xs text-accent hover:underline mt-2 block">
            View kid details →
          </Link>
        </div>

        {/* Center: Budget vs Actual */}
        <div className="col-span-1 bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">Budget vs Actual</h2>

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
        </div>

        {/* Right: Alerts + Upcoming Bills */}
        <div className="col-span-1 space-y-4">
          {/* Alerts */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">Finance Alerts</h2>
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
          </div>

          {/* Upcoming Bills */}
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">Upcoming Bills</h2>
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
            <Link href="/bills" className="text-xs text-accent hover:underline mt-3 block">
              View full calendar →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
