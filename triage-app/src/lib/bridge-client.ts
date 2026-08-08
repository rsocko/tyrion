/**
 * Typed client for Monarch bridge contract v1.
 * Requests use the Next.js proxy to avoid browser CORS concerns.
 */

const BRIDGE_PROXY_BASE = "/api/bridge";

export interface ContractEnvelope {
  contractVersion: "1.0";
}

export interface Provenance {
  provider: "demo" | "live";
  fetchedAt: string;
}

export interface DataEnvelope extends ContractEnvelope {
  provenance: Provenance;
}

export interface Merchant {
  name: string;
  logoUrl: string | null;
}

export interface CategoryRef {
  id: string;
  name: string;
}

export interface AccountRef {
  id: string;
  displayName: string;
  mask: string | null;
}

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  merchant: Merchant;
  category: CategoryRef | null;
  account: AccountRef;
  isPending: boolean;
  isRecurring: boolean;
  notes: string | null;
  tags: string[];
}

export interface Account {
  id: string;
  displayName: string;
  type: string;
  mask: string | null;
  institution: string | null;
  currentBalance: number;
  isActive: boolean;
}

export interface Category extends CategoryRef {
  group: string | null;
  icon: string | null;
}

export interface RecurringObligation {
  id: string;
  merchant: string;
  amount: number;
  frequency: string;
  nextExpectedDate: string | null;
  account: AccountRef | null;
  category: CategoryRef | null;
}

export interface Budget {
  category: CategoryRef;
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number | null;
}

interface BridgeResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

async function bridgeFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<BridgeResponse<T>> {
  try {
    const res = await fetch(`${BRIDGE_PROXY_BASE}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });
    const data: unknown = await res.json();

    if (!res.ok) {
      const payload = data as {
        error?: string | { message?: string };
        message?: string;
      };
      const message = typeof payload.error === "object"
        ? payload.error.message
        : payload.error || payload.message;
      return { error: message || `Request failed (${res.status})`, status: res.status };
    }

    return { data: data as T, status: res.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Network error", status: 0 };
  }
}

type AuthAction = ContractEnvelope & {
  status: "success" | "mfa_required" | "logged_out";
  message: string;
  email: string | null;
};

export function login(email: string, password: string, mfaCode?: string) {
  return bridgeFetch<AuthAction>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, mfaCode: mfaCode || undefined }),
  });
}

export function getAuthStatus() {
  return bridgeFetch<ContractEnvelope & {
    authenticated: boolean;
    email: string | null;
    mode: "demo" | "live";
  }>("/auth/status");
}

export function logout() {
  return bridgeFetch<AuthAction>("/auth/logout", { method: "POST" });
}

export function getTransactions(params?: {
  start_date?: string;
  end_date?: string;
  limit?: number;
  cursor?: string;
  account_id?: string;
  category_id?: string;
}) {
  const searchParams = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined) searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return bridgeFetch<DataEnvelope & {
    transactions: Transaction[];
    total: number;
    page: { limit: number; nextCursor: string | null };
  }>(`/transactions${query ? `?${query}` : ""}`);
}

export function getAccounts() {
  return bridgeFetch<DataEnvelope & { accounts: Account[] }>("/accounts");
}

export function getCategories() {
  return bridgeFetch<DataEnvelope & { categories: Category[] }>("/categories");
}

export function getRecurring() {
  return bridgeFetch<DataEnvelope & { recurring: RecurringObligation[] }>("/recurring");
}

export function getBudgets() {
  return bridgeFetch<DataEnvelope & { budgets: Budget[] }>("/budgets");
}

export function getCashflow(startDate?: string, endDate?: string) {
  const searchParams = new URLSearchParams();
  if (startDate) searchParams.set("start_date", startDate);
  if (endDate) searchParams.set("end_date", endDate);
  const query = searchParams.toString();
  return bridgeFetch<DataEnvelope & {
    startDate: string;
    endDate: string;
    income: number;
    expenses: number;
    net: number;
    byCategory: Array<{ category: string; amount: number }>;
  }>(`/cashflow${query ? `?${query}` : ""}`);
}

export function syncData(days = 90) {
  return bridgeFetch<DataEnvelope & {
    status: "complete";
    transactionsFetched: number;
    accountsSynced: number;
    syncedAt: string;
    dateRange: { start: string; end: string };
  }>(`/sync?days=${days}`, { method: "POST" });
}

export function getHealth() {
  return bridgeFetch<ContractEnvelope & {
    status: "ok" | "error";
    mode: "demo" | "live";
    authenticated: boolean;
  }>("/health");
}

export function getContract() {
  return bridgeFetch<ContractEnvelope & {
    stability: "stable";
    supportedVersions: string[];
  }>("/contract");
}
