"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BRIDGE_CONNECTION_EVENT,
  BridgeConnectionAlert,
} from "@/lib/bridge-client";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [connectionAlert, setConnectionAlert] =
    useState<BridgeConnectionAlert>(null);

  useEffect(() => {
    const handleConnection = (event: Event) => {
      setConnectionAlert(
        (event as CustomEvent<BridgeConnectionAlert>).detail
      );
    };
    window.addEventListener(BRIDGE_CONNECTION_EVENT, handleConnection);
    return () => {
      window.removeEventListener(BRIDGE_CONNECTION_EVENT, handleConnection);
    };
  }, []);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {connectionAlert && (
          <div
            role="alert"
            className="m-4 flex items-center justify-between gap-4 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm"
          >
            <span>{connectionAlert.message}</span>
            <Link
              href="/settings"
              className="shrink-0 rounded border border-warning/60 px-3 py-1.5 font-medium text-warning"
            >
              {connectionAlert.kind === "expired" ? "Reconnect" : "View connection"}
            </Link>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
