"use client";

import { useState, useCallback, useEffect } from "react";
import { TriageTransaction, FilterTab, RuleSuggestion } from "@/lib/types";
import { mockTransactions, kids, ruleSuggestions } from "@/lib/mock-data";
import { TransactionCard } from "@/components/transaction-card";
import { Toast } from "@/components/toast";
import { useDataSource } from "@/lib/use-data-source";
import { getTransactions, Transaction } from "@/lib/bridge-client";

function mapMonarchTransactions(raw: Transaction[]): TriageTransaction[] {
  return raw.map((t) => {
    const categoryName = t.category?.name || null;
    const isUncategorized = !categoryName || categoryName === "Uncategorized";
    return {
      id: t.id,
      merchantName: t.merchant.name,
      amount: Math.abs(t.amount),
      date: t.date,
      cardLabel: t.account.displayName,
      cardLast4: t.account.mask || "****",
      originalCategory: categoryName || undefined,
      triageStatus: isUncategorized ? "uncategorized" : "suggested-kid",
      suggestedCategories: isUncategorized ? ["Groceries", "Shopping", "Dining Out"] : undefined,
    };
  });
}

export default function TriagePage() {
  const dataSource = useDataSource();
  const [transactions, setTransactions] = useState<TriageTransaction[]>(mockTransactions);
  const [liveTransactions, setLiveTransactions] = useState<TriageTransaction[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [dismissedRules, setDismissedRules] = useState<Set<string>>(new Set());

  // Fetch live transactions
  useEffect(() => {
    if (dataSource === "live") {
      setLiveLoading(true);
      const endDate = new Date().toISOString().split("T")[0];
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      getTransactions({ start_date: startDate, end_date: endDate, limit: 100 })
        .then((res) => {
          if (res.data && Array.isArray(res.data.transactions)) {
            setLiveTransactions(mapMonarchTransactions(res.data.transactions));
          }
        })
        .finally(() => setLiveLoading(false));
    }
  }, [dataSource]);

  const activeTransactions = dataSource === "live" ? liveTransactions : transactions;

  const filteredTransactions = activeTransactions.filter((txn) => {
    if (removingIds.has(txn.id)) return true;
    switch (activeTab) {
      case "uncategorized":
        return txn.triageStatus === "uncategorized";
      case "unassigned":
        return !txn.suggestedKidId && txn.triageStatus !== "flagged";
      case "flagged":
        return txn.triageStatus === "flagged";
      default:
        return true;
    }
  });

  const counts = {
    all: activeTransactions.length,
    uncategorized: activeTransactions.filter((t) => t.triageStatus === "uncategorized").length,
    unassigned: activeTransactions.filter((t) => !t.suggestedKidId && t.triageStatus !== "flagged").length,
    flagged: activeTransactions.filter((t) => t.triageStatus === "flagged").length,
  };

  const removeTransaction = useCallback((id: string, message: string) => {
    setRemovingIds((prev) => new Set(prev).add(id));
    setToast(message);
    setTimeout(() => {
      setTransactions((prev) => prev.filter((t) => t.id !== id));
      setLiveTransactions((prev) => prev.filter((t) => t.id !== id));
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 300);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleAssignKid = useCallback(
    (txnId: string, kidName: string) => {
      removeTransaction(txnId, `Assigned to ${kidName} ✓`);
    },
    [removeTransaction]
  );

  const handleConfirmCategory = useCallback(
    (txnId: string, category: string) => {
      removeTransaction(txnId, `Categorized as "${category}" ✓`);
    },
    [removeTransaction]
  );

  const handleFlag = useCallback(
    (txnId: string) => {
      const updater = (prev: TriageTransaction[]) =>
        prev.map((t) =>
          t.id === txnId ? { ...t, triageStatus: "flagged" as const, flagReason: "Manually flagged for review" } : t
        );
      setTransactions(updater);
      setLiveTransactions(updater);
      setToast("Flagged for review 🚩");
      setTimeout(() => setToast(null), 2500);
    },
    []
  );

  const handleSkip = useCallback((txnId: string) => {
    const updater = (prev: TriageTransaction[]) => {
      const idx = prev.findIndex((t) => t.id === txnId);
      if (idx === -1) return prev;
      const item = prev[idx];
      return [...prev.slice(0, idx), ...prev.slice(idx + 1), item];
    };
    setTransactions(updater);
    setLiveTransactions(updater);
    setToast("Skipped — moved to end");
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleDismissRule = useCallback((pattern: string) => {
    setDismissedRules((prev) => new Set(prev).add(pattern));
  }, []);

  const visibleRules = dataSource === "mock" ? ruleSuggestions.filter((r) => !dismissedRules.has(r.merchantPattern)) : [];

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "uncategorized", label: "Uncategorized", count: counts.uncategorized },
    { key: "unassigned", label: "Unassigned Kid", count: counts.unassigned },
    { key: "flagged", label: "Flagged", count: counts.flagged },
  ];

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-serif font-bold">Transaction Triage</h1>
          <p className="text-sm text-muted mt-1">Review, categorize, and assign transactions</p>
        </div>
        <div className="flex gap-2 items-center">
          {dataSource === "live" && (
            <span className="text-xs bg-success/30 text-success border border-success/50 px-2 py-1 rounded-full mr-2">
              Live • {counts.all} transactions
            </span>
          )}
          <span className="text-xs bg-accent/20 text-accent px-2 py-1 rounded-full">
            {counts.all} remaining
          </span>
        </div>
      </div>

      {liveLoading && dataSource === "live" && (
        <div className="mb-4 px-3 py-2 rounded-md bg-success/20 border border-success/30 text-xs text-success">
          Fetching live transactions from Monarch Money...
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-6 border-b border-border pb-3">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              activeTab === tab.key
                ? "bg-accent text-background"
                : "text-muted hover:bg-card"
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* Transaction Cards */}
      <div className="space-y-3">
        {filteredTransactions.length === 0 ? (
          <div className="text-center py-12 text-muted">
            <p className="text-lg">🎉 All caught up!</p>
            <p className="text-sm mt-1">No transactions need attention in this view.</p>
          </div>
        ) : (
          filteredTransactions.map((txn) => (
            <TransactionCard
              key={txn.id}
              transaction={txn}
              kids={kids}
              isRemoving={removingIds.has(txn.id)}
              onAssignKid={handleAssignKid}
              onConfirmCategory={handleConfirmCategory}
              onFlag={handleFlag}
              onSkip={handleSkip}
            />
          ))
        )}
      </div>

      {/* Rule Suggestions */}
      {visibleRules.map((rule) => (
        <RuleSuggestionBanner
          key={rule.merchantPattern}
          rule={rule}
          onDismiss={() => handleDismissRule(rule.merchantPattern)}
        />
      ))}

      {/* Toast */}
      {toast && <Toast message={toast} />}
    </div>
  );
}

function RuleSuggestionBanner({
  rule,
  onDismiss,
}: {
  rule: RuleSuggestion;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-6 p-4 rounded-xl bg-accent/5 border border-accent/20 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">💡 Rule suggestion</p>
          <p className="text-xs text-muted mt-0.5">
            You&apos;ve assigned &ldquo;{rule.merchantPattern}&rdquo; to {rule.kidName}{" "}
            {rule.assignmentCount} times this month. Create an auto-rule?
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-md text-xs bg-accent text-background hover:bg-accent/90"
          >
            Create Rule
          </button>
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-md text-xs bg-card border border-border hover:bg-card/80"
          >
            As &ldquo;likely&rdquo;
          </button>
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-white"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
