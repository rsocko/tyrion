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

export const BRIDGE_CONNECTION_EVENT = "tyrion:bridge-connection";

export type BridgeConnectionAlert = {
  kind: "expired" | "unavailable";
  message: string;
} | null;

type BridgeFetchBehavior = {
  retryable?: boolean;
  notifyConnection?: boolean;
  clearAlertOnSuccess?: boolean;
};

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

function publishConnectionAlert(alert: BridgeConnectionAlert) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<BridgeConnectionAlert>(BRIDGE_CONNECTION_EVENT, {
        detail: alert,
      })
    );
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function bridgeFetch<T>(
  path: string,
  options: RequestInit = {},
  behavior: BridgeFetchBehavior = {}
): Promise<BridgeResponse<T>> {
  const attempts = behavior.retryable ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
        const retry = behavior.retryable
          && TRANSIENT_STATUSES.has(res.status)
          && attempt < attempts - 1;
        if (retry) {
          await wait(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        if (
          behavior.notifyConnection
          && (res.status === 401 || TRANSIENT_STATUSES.has(res.status))
        ) {
          publishConnectionAlert(
            res.status === 401
              ? {
                  kind: "expired",
                  message: "Monarch authentication expired. Reconnect with fresh browser cookies.",
                }
              : {
                  kind: "unavailable",
                  message: "Monarch is temporarily unavailable. Tyrion stopped after bounded retries.",
                }
          );
        }
        return { error: message || `Request failed (${res.status})`, status: res.status };
      }

      if (behavior.clearAlertOnSuccess) {
        publishConnectionAlert(null);
      }
      return { data: data as T, status: res.status };
    } catch {
      const retry = behavior.retryable && attempt < attempts - 1;
      if (retry) {
        await wait(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (behavior.notifyConnection) {
        publishConnectionAlert({
          kind: "unavailable",
          message: "The Monarch bridge is unavailable. Tyrion stopped after bounded retries.",
        });
      }
      return { error: "Bridge unavailable", status: 0 };
    }
  }

  return { error: "Bridge unavailable", status: 0 };
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
  }, { clearAlertOnSuccess: true });
}

export function loginWithCookies(sessionId: string, csrfToken: string) {
  return bridgeFetch<AuthAction>("/auth/login-with-cookies", {
    method: "POST",
    body: JSON.stringify({ sessionId, csrfToken }),
  }, { clearAlertOnSuccess: true });
}

export function getAuthStatus() {
  return bridgeFetch<ContractEnvelope & {
    authenticated: boolean;
    authState: "unauthenticated" | "connected" | "expired" | "degraded";
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
  }>(
    `/transactions${query ? `?${query}` : ""}`,
    {},
    { retryable: true, notifyConnection: true }
  );
}

export function getAccounts() {
  return bridgeFetch<DataEnvelope & { accounts: Account[] }>(
    "/accounts",
    {},
    { retryable: true, notifyConnection: true }
  );
}

export function getCategories() {
  return bridgeFetch<DataEnvelope & { categories: Category[] }>(
    "/categories",
    {},
    { retryable: true, notifyConnection: true }
  );
}

export function getRecurring() {
  return bridgeFetch<DataEnvelope & { recurring: RecurringObligation[] }>(
    "/recurring",
    {},
    { retryable: true, notifyConnection: true }
  );
}

export function getBudgets() {
  return bridgeFetch<DataEnvelope & { budgets: Budget[] }>(
    "/budgets",
    {},
    { retryable: true, notifyConnection: true }
  );
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
  }>(
    `/cashflow${query ? `?${query}` : ""}`,
    {},
    { retryable: true, notifyConnection: true }
  );
}

export function syncData(days = 90) {
  return bridgeFetch<DataEnvelope & {
    status: "complete";
    transactionsFetched: number;
    accountsSynced: number;
    syncedAt: string;
    dateRange: { start: string; end: string };
  }>(
    `/sync?days=${days}`,
    { method: "POST" },
    { retryable: true, notifyConnection: true }
  );
}

export function getHealth() {
  return bridgeFetch<ContractEnvelope & {
    status: "ok" | "degraded";
    mode: "demo" | "live";
    reachable: boolean;
    authenticated: boolean;
    authState: "unauthenticated" | "connected" | "expired" | "degraded";
  }>("/health");
}

export function getContract() {
  return bridgeFetch<ContractEnvelope & {
    stability: "stable";
    supportedVersions: string[];
  }>("/contract");
}
