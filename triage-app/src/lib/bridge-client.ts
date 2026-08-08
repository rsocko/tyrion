const BRIDGE_PROXY_BASE = "/api/bridge";

export type AuthState = "unauthenticated" | "connected" | "expired" | "degraded";

export interface ContractEnvelope {
  contractVersion: "1.0";
}

export interface BridgeResponse<T> {
  data?: T;
  code?: string;
  error?: string;
  status: number;
}

export interface HealthResponse extends ContractEnvelope {
  status: "ok" | "degraded";
  mode: "demo" | "live";
  reachable: boolean;
  authenticated: boolean;
  authState: AuthState;
}

export interface AuthStatusResponse extends ContractEnvelope {
  authenticated: boolean;
  authState: AuthState;
  email: string | null;
  mode: "demo" | "live";
}

export interface AuthActionResponse extends ContractEnvelope {
  status: "success" | "mfa_required" | "logged_out";
  message: string;
  email: string | null;
}

export interface SyncResponse extends ContractEnvelope {
  status: "complete";
}

async function bridgeFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<BridgeResponse<T>> {
  try {
    const response = await fetch(`${BRIDGE_PROXY_BASE}${path}`, {
      ...options,
      cache: "no-store",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    } & T;

    if (!response.ok) {
      return {
        code: payload.error?.code,
        error: payload.error?.message || `Request failed (${response.status})`,
        status: response.status,
      };
    }
    return { data: payload, status: response.status };
  } catch {
    return { code: "bridge_unavailable", error: "Bridge unavailable", status: 0 };
  }
}

export function getHealth() {
  return bridgeFetch<HealthResponse>("/health");
}

export function getAuthStatus() {
  return bridgeFetch<AuthStatusResponse>("/auth/status");
}

export function login(email: string, password: string, mfaCode?: string) {
  return bridgeFetch<AuthActionResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, mfaCode: mfaCode || undefined }),
  });
}

export function loginWithCookies(sessionId: string, csrfToken: string) {
  return bridgeFetch<AuthActionResponse>("/auth/login-with-cookies", {
    method: "POST",
    body: JSON.stringify({ sessionId, csrfToken }),
  });
}

export function logout() {
  return bridgeFetch<AuthActionResponse>("/auth/logout", { method: "POST" });
}

export function syncAndRecheck() {
  return bridgeFetch<SyncResponse>("/sync?days=30", { method: "POST" });
}
