/**
 * Bridge Client — wraps fetch calls to the Next.js bridge proxy API routes.
 * All requests go through /api/bridge/[...path] to avoid CORS issues.
 */

const BRIDGE_PROXY_BASE = "/api/bridge";

interface BridgeResponse<T = unknown> {
  data?: T;
  error?: string;
  status: number;
}

async function bridgeFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<BridgeResponse<T>> {
  try {
    const url = `${BRIDGE_PROXY_BASE}${path}`;
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    const data = await res.json();

    if (!res.ok) {
      return { error: data.error || data.message || `Request failed (${res.status})`, status: res.status };
    }

    return { data: data as T, status: res.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Network error", status: 0 };
  }
}

// Auth endpoints
export async function login(email: string, password: string, mfaCode?: string) {
  return bridgeFetch<{ status: string; message: string; email: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, mfa_code: mfaCode || undefined }),
  });
}

export async function getAuthStatus() {
  return bridgeFetch<{
    authenticated: boolean;
    email?: string;
    mode: string;
    session_file?: string;
  }>("/auth/status");
}

export async function logout() {
  return bridgeFetch<{ status: string; message: string }>("/auth/logout", { method: "POST" });
}

// Data endpoints
export async function getTransactions(params?: {
  start_date?: string;
  end_date?: string;
  limit?: number;
  account_id?: string;
  category_id?: string;
}) {
  const searchParams = new URLSearchParams();
  if (params?.start_date) searchParams.set("start_date", params.start_date);
  if (params?.end_date) searchParams.set("end_date", params.end_date);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.account_id) searchParams.set("account_id", params.account_id);
  if (params?.category_id) searchParams.set("category_id", params.category_id);
  const qs = searchParams.toString();
  return bridgeFetch<{ transactions: unknown[]; total: number }>(`/transactions${qs ? `?${qs}` : ""}`);
}

export async function getAccounts() {
  return bridgeFetch<{ accounts: unknown[] }>("/accounts");
}

export async function getCategories() {
  return bridgeFetch<{ categories: unknown[] }>("/categories");
}

export async function getRecurring() {
  return bridgeFetch<{ recurring: unknown[] }>("/recurring");
}

export async function getBudgets() {
  return bridgeFetch<{ budgets: unknown[] }>("/budgets");
}

export async function getCashflow(startDate?: string, endDate?: string) {
  const searchParams = new URLSearchParams();
  if (startDate) searchParams.set("start_date", startDate);
  if (endDate) searchParams.set("end_date", endDate);
  const qs = searchParams.toString();
  return bridgeFetch<{
    totalIncome: number;
    totalExpenses: number;
    netCashflow: number;
    byCategory: unknown[];
  }>(`/cashflow${qs ? `?${qs}` : ""}`);
}

export async function syncData(days = 90) {
  return bridgeFetch<{
    status: string;
    mode: string;
    transactions_fetched: number;
    accounts_synced: number;
    sync_timestamp: string;
  }>(`/sync?days=${days}`, { method: "POST" });
}

export async function getHealth() {
  return bridgeFetch<{ status: string; mode: string; authenticated: boolean }>("/health");
}
