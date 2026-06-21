"use client";

import { useState, useEffect } from "react";

export type DataSource = "mock" | "live";

const STORAGE_KEY = "finance-data-source";

export function useDataSource(): DataSource {
  const [source, setSource] = useState<DataSource>("mock");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "live" || saved === "mock") setSource(saved);
    } catch {
      // localStorage not available
    }

    // Listen for changes from other tabs/components
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === "live" || e.newValue === "mock")) {
        setSource(e.newValue);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return source;
}

export function setDataSourcePreference(source: DataSource) {
  try {
    localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // localStorage not available
  }
}
