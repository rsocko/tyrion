"use client";

import { TriageTransaction, KidProfile } from "@/lib/types";

const kidColorMap: Record<string, { bg: string; border: string; text: string; activeBg: string }> = {
  blue: {
    bg: "bg-jake/15",
    border: "border-jake/40",
    text: "text-jake",
    activeBg: "bg-jake",
  },
  purple: {
    bg: "bg-emma/15",
    border: "border-emma/40",
    text: "text-emma",
    activeBg: "bg-emma",
  },
  green: {
    bg: "bg-sophie/15",
    border: "border-sophie/40",
    text: "text-sophie",
    activeBg: "bg-sophie",
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
        <span className="text-xs px-2 py-0.5 rounded-full bg-error/15 text-error border border-error/40">
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
          <span className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/40">
            Category: &ldquo;{txn.originalCategory}&rdquo;
          </span>
        );
      }
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning border border-warning/40">
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
          ? "border border-error/40"
          : "border border-border hover:border-gold/50"
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
        <span className="text-xl font-mono font-bold text-error">{formatAmount(txn.amount)}</span>
      </div>

      {/* Suggestion reason (pattern match info) */}
      {txn.suggestionReason && !isFlagged && (
        <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-info/10 border border-info/25">
          <span className="text-xs">🧠</span>
          <span className="text-xs text-info">{txn.suggestionReason}</span>
        </div>
      )}

      {/* Flag reason */}
      {isFlagged && txn.flagReason && (
        <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-error/10 border border-error/25">
          <span className="text-xs">⚠️</span>
          <span className="text-xs text-error">{txn.flagReason}</span>
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
                className="px-2.5 py-1 rounded-md text-xs bg-card-2 border border-border hover:border-gold hover:bg-gold/10 transition-colors"
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
            className="px-2.5 py-1 rounded-md text-xs bg-card-2 border border-border text-muted hover:border-gold transition-colors"
          >
            Mine
          </button>
        </div>

        <div className="flex gap-1.5">
          {!isFlagged && (
            <button
              onClick={() => onFlag(txn.id)}
              className="px-2.5 py-1 rounded-md text-xs text-error border border-error/40 hover:bg-error/10 transition-colors"
            >
              🚩 Flag
            </button>
          )}
          <button
            onClick={() => onSkip(txn.id)}
            className="px-2.5 py-1 rounded-md text-xs text-muted border border-border hover:border-gold transition-colors"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
