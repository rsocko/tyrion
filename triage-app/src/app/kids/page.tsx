"use client";

import { useState } from "react";
import Link from "next/link";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { kidsData, kidsList } from "@/lib/mock-kids-data";
import { useDataSource } from "@/lib/use-data-source";

const kidColorClasses: Record<string, { activeBg: string; barColors: string[] }> = {
  blue: { activeBg: "bg-blue-600", barColors: ["bg-blue-500", "bg-blue-400", "bg-blue-300", "bg-blue-200"] },
  purple: { activeBg: "bg-purple-600", barColors: ["bg-purple-500", "bg-purple-400", "bg-purple-300", "bg-purple-200"] },
  green: { activeBg: "bg-green-600", barColors: ["bg-green-500", "bg-green-400", "bg-green-300", "bg-green-200"] },
};

export default function KidsPage() {
  const dataSource = useDataSource();
  const [selectedKid, setSelectedKid] = useState("jake");
  const data = kidsData[selectedKid];
  const profile = data.profile;
  const colors = kidColorClasses[profile.color];

  if (dataSource === "live") {
    return (
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="text-xs text-muted mb-4">
          <span className="hover:text-white cursor-pointer">Finance</span> / <span className="text-white">Kids Spending</span>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <span className="text-xs bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 px-2 py-1 rounded-full">
            Live Mode
          </span>
        </div>

        <div className="max-w-lg mx-auto mt-12">
          <div className="border border-dashed border-[#333] rounded-xl p-8 text-center">
            <div className="text-4xl mb-4">👨‍👩‍👧‍👦</div>
            <h2 className="text-lg font-semibold text-[#999] mb-2">Kid Attribution Not Yet Configured</h2>
            <p className="text-sm text-[#666] mb-6 leading-relaxed">
              To track per-kid spending, configure card rules and merchant patterns in Settings. 
              The kid attribution engine will automatically identify which transactions belong to each child.
            </p>
            <Link
              href="/settings"
              className="inline-block px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent/90 transition-colors"
            >
              Configure Kids
            </Link>
          </div>

          <div className="mt-6 border border-dashed border-[#333] rounded-lg p-4">
            <p className="text-xs text-[#555]">
              💡 <span className="text-[#666]">Demo mode:</span> Switch to Mock Data on the dashboard to see an example of how kid tracking works.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Breadcrumb */}
      <div className="text-xs text-muted mb-4">
        <span className="hover:text-white cursor-pointer">Finance</span> / <span className="text-white">Kids Spending</span>
      </div>

      {/* Kid Selector Tabs */}
      <div className="flex gap-2 mb-6">
        {kidsList.map((kid) => {
          const isActive = selectedKid === kid.id;
          return (
            <button
              key={kid.id}
              onClick={() => setSelectedKid(kid.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${
                isActive
                  ? `${kidColorClasses[kid.color].activeBg} text-white`
                  : "text-muted border border-border hover:bg-card"
              }`}
            >
              <div className={`w-2.5 h-2.5 rounded-full ${isActive ? "bg-white/60" : `bg-${kid.color}-500`}`} />
              {kid.name}
            </button>
          );
        })}
        <button className="px-4 py-2 rounded-lg text-sm text-muted border border-border hover:bg-card flex items-center gap-2">
          All Kids (Combined)
        </button>
      </div>

      {/* Kid Header */}
      <div className="bg-card border border-border rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{profile.name}&apos;s Spending</h1>
            <p className="text-sm text-muted mt-1">June 2026</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold font-mono">${profile.totalSpent}</p>
            {profile.totalSpent > profile.monthlyLimit ? (
              <p className="text-sm text-red-400">Over monthly limit (${profile.monthlyLimit}) by ${profile.totalSpent - profile.monthlyLimit}</p>
            ) : (
              <p className="text-sm text-green-400">Under monthly limit (${profile.monthlyLimit})</p>
            )}
          </div>
        </div>

        {/* Period Summaries */}
        <div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-border">
          <div>
            <p className="text-xs text-muted">Today</p>
            <p className="text-lg font-mono font-medium">${profile.todaySpent.toFixed(2)}</p>
            <p className={`text-xs ${profile.todaySpent > profile.dailyLimit ? "text-red-400" : "text-green-400"}`}>
              {profile.todaySpent > profile.dailyLimit ? "Over" : "Under"} ${profile.dailyLimit} daily limit
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">This Week</p>
            <p className={`text-lg font-mono font-medium ${profile.weeklySpent > profile.weeklyLimit ? "text-red-300" : ""}`}>
              ${profile.weeklySpent}
            </p>
            <p className={`text-xs ${profile.weeklySpent > profile.weeklyLimit ? "text-red-400" : "text-green-400"}`}>
              {profile.weeklySpent > profile.weeklyLimit ? `Over $${profile.weeklyLimit} weekly limit` : `Under $${profile.weeklyLimit} weekly limit`}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">This Month</p>
            <p className={`text-lg font-mono font-medium ${profile.totalSpent > profile.monthlyLimit ? "text-red-300" : ""}`}>
              ${profile.totalSpent}
            </p>
            <p className={`text-xs ${profile.totalSpent > profile.monthlyLimit ? "text-red-400" : "text-green-400"}`}>
              {profile.totalSpent > profile.monthlyLimit ? `Over $${profile.monthlyLimit} monthly limit` : `Under $${profile.monthlyLimit} monthly limit`}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Category Breakdown + Limits */}
        <div className="col-span-1">
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">By Category</h2>
            <div className="space-y-3">
              {data.categories.map((cat, i) => (
                <div key={cat.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span>{cat.name}</span>
                    <span className="font-mono">${cat.amount}</span>
                  </div>
                  <ProgressBar value={cat.percent} max={100} color={colors.barColors[i] || colors.barColors[0]} />
                </div>
              ))}
            </div>
          </div>

          {/* Threshold Settings */}
          <div className="bg-card border border-border rounded-xl p-5 mt-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">Limits</h2>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs">Daily</span>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-mono ${profile.todaySpent > profile.dailyLimit ? "text-red-300" : ""}`}>
                    ${profile.dailyLimit}
                  </span>
                  <button className="text-xs text-muted hover:text-white">✏️</button>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs">Weekly</span>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-mono ${profile.weeklySpent > profile.weeklyLimit ? "text-red-300" : ""}`}>
                    ${profile.weeklyLimit}
                  </span>
                  <button className="text-xs text-muted hover:text-white">✏️</button>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs">Monthly</span>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-mono ${profile.totalSpent > profile.monthlyLimit ? "text-red-300" : ""}`}>
                    ${profile.monthlyLimit}
                  </span>
                  <button className="text-xs text-muted hover:text-white">✏️</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Transaction List */}
        <div className="col-span-2">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{profile.name}&apos;s Transactions</h2>
              <select className="bg-zinc-800 border border-border rounded-md text-xs px-2 py-1 text-muted">
                <option>This Month</option>
                <option>Last Month</option>
                <option>Last 90 Days</option>
              </select>
            </div>

            <div className="space-y-1">
              {data.transactions.map((txn, i) => {
                const showDateLabel = i === 0 || data.transactions[i - 1].dateLabel !== txn.dateLabel;
                return (
                  <div key={txn.id}>
                    {showDateLabel && (
                      <p className={`text-xs text-muted font-medium ${i > 0 ? "pt-4" : "pt-2"} pb-1`}>{txn.dateLabel}</p>
                    )}
                    <div className="flex items-center justify-between p-3 rounded-lg hover:bg-zinc-800/50">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs">
                          {txn.icon}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{txn.merchant}</p>
                          <p className="text-xs text-muted">{txn.card} • {txn.category}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-mono">-${Math.abs(txn.amount).toFixed(2)}</p>
                        <p className={`text-xs ${txn.attributionColor}`}>{txn.attribution}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Discussion Items */}
            {data.discussions.length > 0 && (
              <div className="mt-6 pt-4 border-t border-border">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-yellow-400 mb-3">🚩 Discussion Items</h3>
                <div className="space-y-2">
                  {data.discussions.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-3 rounded-lg bg-yellow-950/20 border border-yellow-900/30">
                      <div>
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="text-xs text-muted">{item.description}</p>
                      </div>
                      <div className="flex gap-2">
                        <button className="px-2.5 py-1 text-xs rounded-md bg-yellow-900/50 text-yellow-300">Create Task</button>
                        <button className="px-2.5 py-1 text-xs rounded-md text-muted border border-border">Dismiss</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
