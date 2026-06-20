"use client";

import { useState, useCallback } from "react";
import { TriageTransaction, FilterTab, RuleSuggestion } from "@/lib/types";
import { mockTransactions, kids, ruleSuggestions } from "@/lib/mock-data";
import { TransactionCard } from "@/components/transaction-card";
import { Toast } from "@/components/toast";

export default function TriageInbox() {
  const [transactions, setTransactions] = useState<TriageTransaction[]>(mockTransactions);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [dismissedRules, setDismissedRules] = useState<Set<string>>(new Set());

  const filteredTransactions = transactions.filter((txn) => {
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
    all: transactions.length,
    uncategorized: transactions.filter((t) => t.triageStatus === "uncategorized").length,
    unassigned: transactions.filter((t) => !t.suggestedKidId && t.triageStatus !== "flagged").length,
    flagged: transactions.filter((t) => t.triageStatus === "flagged").length,
  };

  const removeTransaction = useCallback((id: string, message: string) => {
    setRemovingIds((prev) => new Set(prev).add(id));
    setToast(message);
    setTimeout(() => {
      setTransactions((prev) => prev.filter((t) => t.id !== id));
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
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === txnId ? { ...t, triageStatus: "flagged" as const, flagReason: "Manually flagged for review" } : t
        )
      );
      setToast("Flagged for review 🚩");
      setTimeout(() => setToast(null), 2500);
    },
    []
  );

  const handleSkip = useCallback((txnId: string) => {
    setTransactions((prev) => {
      const idx = prev.findIndex((t) => t.id === txnId);
      if (idx === -1) return prev;
      const item = prev[idx];
      return [...prev.slice(0, idx), ...prev.slice(idx + 1), item];
    });
    setToast("Skipped — moved to end");
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handleDismissRule = useCallback((pattern: string) => {
    setDismissedRules((prev) => new Set(prev).add(pattern));
  }, []);

  const visibleRules = ruleSuggestions.filter((r) => !dismissedRules.has(r.merchantPattern));

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "uncategorized", label: "Uncategorized", count: counts.uncategorized },
    { key: "unassigned", label: "Unassigned Kid", count: counts.unassigned },
    { key: "flagged", label: "Flagged", count: counts.flagged },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-lg font-semibold">Mission Control</span>
          <nav className="flex gap-1 ml-6">
            <span className="px-3 py-1.5 rounded-md text-sm text-muted">Tasks</span>
            <span className="px-3 py-1.5 rounded-md text-sm text-muted">Alerts</span>
            <span className="px-3 py-1.5 rounded-md text-sm bg-card text-white font-medium">Finance</span>
            <span className="px-3 py-1.5 rounded-md text-sm text-muted">Today</span>
            <span className="px-3 py-1.5 rounded-md text-sm text-muted">AI</span>
          </nav>
        </div>
        <div className="text-xs text-muted">{counts.all} items to review</div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Transaction Triage</h1>
            <p className="text-sm text-muted mt-1">Review, categorize, and assign transactions</p>
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-xs bg-accent/20 text-accent px-2 py-1 rounded-full">
              {counts.all} remaining
            </span>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-2 mb-6 border-b border-border pb-3">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                activeTab === tab.key
                  ? "bg-accent text-white"
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
      </main>

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
            className="px-3 py-1.5 rounded-md text-xs bg-accent text-white hover:bg-accent/90"
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
