"use client";

import { TriageTransaction, KidProfile } from "@/lib/types";

const kidColorMap: Record<string, { bg: string; border: string; text: string; activeBg: string }> = {
  blue: {
    bg: "bg-blue-900/30",
    border: "border-blue-800/50",
    text: "text-blue-300",
    activeBg: "bg-blue-600",
  },
  purple: {
    bg: "bg-purple-900/30",
    border: "border-purple-800/50",
    text: "text-purple-300",
    activeBg: "bg-purple-600",
  },
  green: {
    bg: "bg-green-900/30",
    border: "border-green-800/50",
    text: "text-green-300",
    activeBg: "bg-green-600",
  },
};

interface TransactionCardProps {
  transaction: TriageTransaction;
  kids: KidProfile[];
  isRemoving: boolean;
  onAssignKid: (txnId: string, kidName: string) => void;
  onConfirmCategory: (txnId: string, category: string) => void;
  onFlag: (txnId: string) => void;
  onSkip: (txnId: string) => void;
}

export function TransactionCard({
  transaction: txn,
  kids,
  isRemoving,
  onAssignKid,
  onConfirmCategory,
  onFlag,
  onSkip,
}: TransactionCardProps) {
  const isFlagged = txn.triageStatus === "flagged";
  const hasSuggestedKid = txn.suggestedKidId && txn.suggestedKidName;
  const suggestedKid = kids.find((k) => k.id === txn.suggestedKidId);

  const formatAmount = (amount: number) => {
    const abs = Math.abs(amount).toFixed(2);
    return amount < 0 ? `-$${abs}` : `$${abs}`;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  // Status badge
  const renderBadge = () => {
    if (isFlagged) {
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/50 text-red-300 border border-red-800">
          🚩 Flagged
        </span>
      );
    }
    if (hasSuggestedKid && suggestedKid) {
      const colors = kidColorMap[suggestedKid.color];
      return (
        <span className={`text-xs px-2 py-0.5 rounded-full ${colors.bg} ${colors.text} border ${colors.border}`}>
          Suggested: {txn.suggestedKidName}
        </span>
      );
    }
    if (txn.triageStatus === "uncategorized") {
      if (txn.originalCategory) {
        return (
          <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-400 border border-yellow-800">
            Category: &ldquo;{txn.originalCategory}&rdquo;
          </span>
        );
      }
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-400 border border-yellow-800">
          Uncategorized
        </span>
      );
    }
    return null;
  };

  return (
    <div
      className={`bg-card rounded-xl p-5 transition-all ${
        isRemoving ? "animate-slide-out" : ""
      } ${
        isFlagged
          ? "border border-red-900/50"
          : "border border-border hover:border-accent/50"
      }`}
    >
      {/* Top row: badge + date + amount */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            {renderBadge()}
            <span className="text-xs text-muted">{formatDate(txn.date)}</span>
          </div>
          <h3 className="text-base font-medium mt-2">{txn.merchantName}</h3>
          <p className="text-xs text-muted mt-0.5">
            {txn.cardLabel} ...{txn.cardLast4}
            {txn.originalCategory ? ` • ${txn.originalCategory}` : ""}
          </p>
        </div>
        <span className="text-xl font-mono font-bold text-red-300">{formatAmount(txn.amount)}</span>
      </div>

      {/* Suggestion reason (pattern match info) */}
      {txn.suggestionReason && !isFlagged && (
        <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-blue-950/20 border border-blue-900/30">
          <span className="text-xs">🧠</span>
          <span className="text-xs text-blue-200">{txn.suggestionReason}</span>
        </div>
      )}

      {/* Flag reason */}
      {isFlagged && txn.flagReason && (
        <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-red-950/20 border border-red-900/30">
          <span className="text-xs">⚠️</span>
          <span className="text-xs text-red-200">{txn.flagReason}</span>
        </div>
      )}

      {/* Category assignment (for uncategorized) */}
      {txn.suggestedCategories && txn.suggestedCategories.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-muted mb-2">Assign category:</p>
          <div className="flex flex-wrap gap-1.5">
            {txn.suggestedCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => onConfirmCategory(txn.id, cat)}
                className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 border border-border hover:border-accent hover:bg-accent/10 transition-colors"
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Actions row */}
      <div className="flex items-center justify-between pt-3 border-t border-border">
        <div className="flex gap-1.5 flex-wrap">
          {/* If there's a suggested kid with high confidence, show confirm button */}
          {hasSuggestedKid && suggestedKid && (
            <button
              onClick={() => onAssignKid(txn.id, txn.suggestedKidName!)}
              className={`px-3 py-1.5 rounded-md text-xs text-white font-medium hover:opacity-90 transition-opacity ${
                kidColorMap[suggestedKid.color].activeBg
              }`}
            >
              ✓ Confirm {txn.suggestedKidName}
            </button>
          )}

          {/* Other kid buttons */}
          {kids
            .filter((k) => k.id !== txn.suggestedKidId)
            .map((kid) => {
              const colors = kidColorMap[kid.color];
              return (
                <button
                  key={kid.id}
                  onClick={() => onAssignKid(txn.id, kid.name)}
                  className={`px-2.5 py-1 rounded-md text-xs ${colors.bg} border ${colors.border} ${colors.text} hover:opacity-80 transition-opacity`}
                >
                  {kid.name}
                </button>
              );
            })}

          {/* "Mine" button */}
          <button
            onClick={() => onAssignKid(txn.id, "Mine")}
            className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 border border-border text-muted hover:bg-zinc-700 transition-colors"
          >
            Mine
          </button>
        </div>

        <div className="flex gap-1.5">
          {!isFlagged && (
            <button
              onClick={() => onFlag(txn.id)}
              className="px-2.5 py-1 rounded-md text-xs text-red-400 border border-red-900/50 hover:bg-red-950/30 transition-colors"
            >
              🚩 Flag
            </button>
          )}
          <button
            onClick={() => onSkip(txn.id)}
            className="px-2.5 py-1 rounded-md text-xs text-muted border border-border hover:bg-zinc-800 transition-colors"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
