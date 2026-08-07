"use client";

export function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
      <div className="bg-elevated border border-border text-parchment text-sm px-4 py-2.5 rounded-lg shadow-xl">
        {message}
      </div>
    </div>
  );
}
