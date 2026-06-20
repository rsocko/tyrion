"use client";

export function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
      <div className="bg-zinc-800 border border-border text-white text-sm px-4 py-2.5 rounded-lg shadow-xl">
        {message}
      </div>
    </div>
  );
}
