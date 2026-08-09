"use client";

import { useSyncExternalStore } from "react";

export type DataSource = "mock" | "live";

const STORAGE_KEY = "finance-data-source";

function getSnapshot(): DataSource {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "live" ? "live" : "mock";
  } catch {
    return "mock";
  }
}

function subscribe(onStoreChange: () => void) {
  const handler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export function useDataSource(): DataSource {
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => "mock"
  );
}

export function setDataSourcePreference(source: DataSource) {
  try {
    localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // localStorage not available
  }
}
