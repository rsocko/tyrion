"use client";

import { useState, useEffect } from "react";
import { weekSummary, billWeeks, cashFlow } from "@/lib/mock-bills-data";
import { useDataSource } from "@/lib/use-data-source";
import { getRecurring } from "@/lib/bridge-client";

interface LiveBill {
  id: string;
  name: string;
  amount: number;
  nextDate: string;
  frequency: string;
  isAutoPay: boolean;
}

export default function BillsPage() {
  const dataSource = useDataSource();
  const [liveBills, setLiveBills] = useState<LiveBill[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);

  useEffect(() => {
    if (dataSource === "live") {
      setLiveLoading(true);
      getRecurring()
        .then((res) => {
          if (res.data && Array.isArray(res.data.recurring)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mapped = res.data.recurring.map((r: any, i: number) => ({
              id: r.id || `recurring-${i}`,
              name: r.name || r.merchant?.name || "Unknown",
              amount: Math.abs(r.amount || 0),
              nextDate: r.nextDate || r.nextDueDate || "",
              frequency: r.frequency || r.interval || "Monthly",
              isAutoPay: r.isAutoPay ?? r.autoPay ?? false,
            }));
            setLiveBills(mapped);
          } else if (res.data && Array.isArray(res.data)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mapped = (res.data as any[]).map((r: any, i: number) => ({
              id: r.id || `recurring-${i}`,
              name: r.name || r.merchant?.name || "Unknown",
              amount: Math.abs(r.amount || 0),
              nextDate: r.nextDate || r.nextDueDate || "",
              frequency: r.frequency || r.interval || "Monthly",
              isAutoPay: r.isAutoPay ?? r.autoPay ?? false,
            }));
            setLiveBills(mapped);
          }
        })
        .finally(() => setLiveLoading(false));
    }
  }, [dataSource]);

  if (dataSource === "live") {
    return (
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-serif font-bold">Upcoming Bills &amp; Payments</h1>
            <p className="text-sm text-muted mt-1">
              {liveBills.length > 0
                ? `${liveBills.length} recurring bills from Monarch`
                : "Live data from Monarch Money"}
            </p>
          </div>
          <span className="text-xs bg-success/30 text-success border border-success/50 px-2 py-1 rounded-full">
            Live Mode
          </span>
        </div>

        {liveLoading && (
          <div className="mb-4 px-3 py-2 rounded-md bg-success/20 border border-success/30 text-xs text-success">
            Fetching recurring bills from Monarch Money...
          </div>
        )}

        {!liveLoading && liveBills.length === 0 ? (
          <div className="border border-dashed border-card-2 rounded-xl p-8 text-center mt-8">
            <div className="text-4xl mb-4">📋</div>
            <h2 className="text-lg font-semibold text-muted mb-2">No Recurring Bills Found</h2>
            <p className="text-sm text-muted">
              No recurring bills were found in Monarch. Bills will appear here once Monarch detects recurring transactions.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-card-2/50 border-b border-border">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                Recurring Bills ({liveBills.length})
              </p>
            </div>
            <div className="divide-y divide-border">
              {liveBills.map((bill) => (
                <div key={bill.id} className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-card-2 flex items-center justify-center">
                      <span className="text-lg">💰</span>
                    </div>
                    <div>
                      <p className="text-sm font-medium">{bill.name}</p>
                      <p className="text-xs text-muted">
                        {bill.frequency} • {bill.isAutoPay ? "Auto-pay" : "Manual pay"}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-mono font-bold">${bill.amount.toLocaleString()}</p>
                    {bill.nextDate && (
                      <p className="text-xs text-muted">Next: {bill.nextDate}</p>
                    )}
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      bill.isAutoPay
                        ? "bg-success/30 text-success border border-success/50"
                        : "bg-warning/30 text-warning border border-warning/50"
                    }`}
                  >
                    {bill.isAutoPay ? "Auto-pay" : "Manual"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-5xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-serif font-bold">Upcoming Bills &amp; Payments</h1>
          <p className="text-sm text-muted mt-1">Next 30 days • Total due: $4,218</p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 rounded-md text-sm bg-card border border-border">Calendar View</button>
          <button className="px-3 py-1.5 rounded-md text-sm bg-accent text-background">List View</button>
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
            <div className={`px-5 py-3 bg-card-2/50 border-b border-border ${weekIdx > 0 ? "border-t" : ""}`}>
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
                    <p className={`text-xs ${bill.urgent ? "text-warning" : "text-muted"}`}>
                      {bill.dueDateDisplay}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      bill.autoPay
                        ? "bg-success/30 text-success border border-success/50"
                        : "bg-warning/30 text-warning border border-warning/50"
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
            <p className="text-xl font-mono font-bold text-success">${cashFlow.currentBalance.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">After All Bills (30 days)</p>
            <p className="text-xl font-mono font-bold">${cashFlow.projectedBalance.toLocaleString()}</p>
            <p className="text-xs text-muted mt-1">
              Assumes avg ${cashFlow.discretionary.toLocaleString()} discretionary + ${cashFlow.totalBills.toLocaleString()} bills
            </p>
          </div>
        </div>
        <div className="mt-4 p-3 rounded-lg bg-success/20 border border-success/30">
          <p className={`text-xs ${cashFlow.statusColor}`}>{cashFlow.status}</p>
        </div>
      </div>
    </div>
  );
}
