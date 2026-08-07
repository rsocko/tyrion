"use client";

import { useState } from "react";
import { CoinMark } from "@/components/ui/CoinMark";

export default function ChatPage() {
  const [message, setMessage] = useState("");

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="mb-6">
        <p className="eyebrow mb-1">Master of Coin</p>
        <h1 className="text-3xl font-serif font-bold">Ask Tyrion</h1>
        <p className="text-sm text-muted mt-1">Questions about your spending, budgets, kids, and bills — answered plainly.</p>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 bg-card border border-border rounded-xl p-5 overflow-y-auto mb-4">
        <div className="space-y-4">
          {/* Sample conversation */}
          <div className="flex gap-3">
            <div className="shrink-0"><CoinMark size={28} /></div>
            <div className="bg-card-2/50 rounded-lg p-3 max-w-[80%]">
              <p className="text-sm">
                I&apos;m Tyrion, your Master of Coin. I can help you understand your spending patterns,
                track budgets, analyze kid spending, and answer questions about your bills. What would you like to know?
              </p>
            </div>
          </div>

          <div className="flex gap-3 justify-end">
            <div className="bg-accent/10 border border-accent/20 rounded-lg p-3 max-w-[80%]">
              <p className="text-sm">How much has Jake spent on gaming this month?</p>
            </div>
            <div className="w-7 h-7 rounded-full bg-card-2 flex items-center justify-center text-xs shrink-0">👤</div>
          </div>

          <div className="flex gap-3">
            <div className="shrink-0"><CoinMark size={28} /></div>
            <div className="bg-card-2/50 rounded-lg p-3 max-w-[80%]">
              <p className="text-sm">
                Jake has spent <span className="font-mono font-medium text-error">$142</span> on gaming this month (June 2026).
                This makes up 41% of his total spending. Notable purchases:
              </p>
              <ul className="text-sm text-muted mt-2 space-y-1 list-disc list-inside">
                <li>Steam Purchase — $59.99 (Jun 18)</li>
                <li>Epic Games Store — $39.99 (Jun 14)</li>
                <li>Roblox Premium — $12.99 (Jun 16)</li>
              </ul>
              <p className="text-sm mt-2 text-warning">
                ⚠️ He&apos;s exceeded his weekly gaming limit. You might want to discuss this.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Suggestions */}
      <div className="flex gap-2 mb-3 flex-wrap">
        <button className="px-3 py-1.5 rounded-lg text-xs bg-card border border-border hover:bg-card-2 transition-colors">
          What bills are due this week?
        </button>
        <button className="px-3 py-1.5 rounded-lg text-xs bg-card border border-border hover:bg-card-2 transition-colors">
          Am I over budget anywhere?
        </button>
        <button className="px-3 py-1.5 rounded-lg text-xs bg-card border border-border hover:bg-card-2 transition-colors">
          Compare spending to last month
        </button>
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask about your finances..."
          className="flex-1 bg-card border border-border rounded-lg px-4 py-2.5 text-sm placeholder:text-muted focus:outline-none focus:border-accent/50"
        />
        <button className="px-4 py-2.5 rounded-lg bg-accent text-background text-sm font-medium hover:bg-accent/90 transition-colors">
          Send
        </button>
      </div>
    </div>
  );
}
