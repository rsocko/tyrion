"use client";

import { weekSummary, billWeeks, cashFlow } from "@/lib/mock-bills-data";

export default function BillsPage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Upcoming Bills & Payments</h1>
          <p className="text-sm text-muted mt-1">Next 30 days • Total due: $4,218</p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 rounded-md text-sm bg-card border border-border">Calendar View</button>
          <button className="px-3 py-1.5 rounded-md text-sm bg-accent text-white">List View</button>
        </div>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {weekSummary.map((week) => (
          <div key={week.label} className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted">{week.label}</p>
            <p className="text-xl font-bold font-mono">${week.total.toLocaleString()}</p>
            <p className="text-xs text-muted">{week.count} bills</p>
          </div>
        ))}
      </div>

      {/* Bills List */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {billWeeks.map((week, weekIdx) => (
          <div key={week.label}>
            {/* Week Header */}
            <div className={`px-5 py-3 bg-zinc-900/50 border-b border-border ${weekIdx > 0 ? "border-t" : ""}`}>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                {week.label} ({week.dateRange})
              </p>
            </div>

            {/* Bills in this week */}
            <div className="divide-y divide-border">
              {week.bills.map((bill) => (
                <div key={bill.id} className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg ${bill.iconBg} flex items-center justify-center`}>
                      <span className="text-lg">{bill.icon}</span>
                    </div>
                    <div>
                      <p className="text-sm font-medium">{bill.name}</p>
                      <p className="text-xs text-muted">
                        {bill.paymentMethod} • {bill.autoPay ? "Auto-pay" : "Manual pay"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-mono font-bold">${bill.amount.toLocaleString()}</p>
                    <p className={`text-xs ${bill.urgent ? "text-yellow-400" : "text-muted"}`}>
                      {bill.dueDateDisplay}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      bill.autoPay
                        ? "bg-green-900/30 text-green-400 border border-green-800/50"
                        : "bg-yellow-900/30 text-yellow-400 border border-yellow-800/50"
                    }`}
                  >
                    {bill.autoPay ? "Auto-pay" : "Manual"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Cash Flow Projection */}
      <div className="mt-6 bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">Cash Flow Projection</h2>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-muted mb-1">Checking Balance Now</p>
            <p className="text-xl font-mono font-bold text-green-400">${cashFlow.currentBalance.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">After All Bills (30 days)</p>
            <p className="text-xl font-mono font-bold">${cashFlow.projectedBalance.toLocaleString()}</p>
            <p className="text-xs text-muted mt-1">
              Assumes avg ${cashFlow.discretionary.toLocaleString()} discretionary + ${cashFlow.totalBills.toLocaleString()} bills
            </p>
          </div>
        </div>
        <div className="mt-4 p-3 rounded-lg bg-green-950/20 border border-green-900/30">
          <p className={`text-xs ${cashFlow.statusColor}`}>{cashFlow.status}</p>
        </div>
      </div>
    </div>
  );
}
