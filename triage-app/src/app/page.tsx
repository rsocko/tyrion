"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AuthState,
  getAuthStatus,
  getHealth,
  login,
  loginWithCookies,
  logout,
  syncAndRecheck,
} from "@/lib/bridge-client";
import { connectionPresentation } from "@/lib/operational-state.mjs";

type ViewState = AuthState | "checking" | "unavailable";
type LoginMethod = "cookies" | "password";

export default function OperationsPage() {
  const [viewState, setViewState] = useState<ViewState>("checking");
  const [bridgeReachable, setBridgeReachable] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"demo" | "live" | null>(null);
  const [statusError, setStatusError] = useState("");
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("cookies");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRequested, setMfaRequested] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [busyAction, setBusyAction] = useState<"login" | "logout" | "sync" | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshStatus = useCallback(async () => {
    setViewState("checking");
    setStatusError("");
    const health = await getHealth();
    if (!health.data || !health.data.reachable) {
      setBridgeReachable(false);
      setMode(null);
      setViewState("unavailable");
      setStatusError(health.error || "The Monarch bridge is unavailable.");
      return;
    }

    setBridgeReachable(true);
    setMode(health.data.mode);
    const auth = await getAuthStatus();
    if (!auth.data) {
      setViewState("unavailable");
      setStatusError(
        auth.error || "The bridge is reachable, but protected status could not be checked."
      );
      return;
    }

    setMode(auth.data.mode);
    setViewState(auth.data.authState);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusyAction("login");
    setActionError("");
    setNotice("");

    const response =
      loginMethod === "cookies"
        ? await loginWithCookies(sessionId, csrfToken)
        : await login(email, password, mfaCode || undefined);

    setPassword("");
    setMfaCode("");
    setSessionId("");
    setCsrfToken("");

    if (response.data) {
      setMfaRequested(false);
      setNotice("Monarch authentication succeeded.");
      await refreshStatus();
    } else {
      if (response.code === "mfa_required") {
        setMfaRequested(true);
      }
      setActionError(response.error || "Authentication failed.");
    }
    setBusyAction(null);
  };

  const handleLogout = async () => {
    setBusyAction("logout");
    setActionError("");
    setNotice("");
    const response = await logout();
    if (response.data) {
      setNotice("The bridge-managed Monarch session was cleared.");
      await refreshStatus();
    } else {
      setActionError(response.error || "Logout failed.");
    }
    setBusyAction(null);
  };

  const handleSync = async () => {
    setBusyAction("sync");
    setActionError("");
    setNotice("");
    const response = await syncAndRecheck();
    if (response.data) {
      setNotice("The bounded 30-day sync completed and status was rechecked.");
      await refreshStatus();
    } else {
      setActionError(response.error || "Sync failed.");
      if (response.status === 401) {
        await refreshStatus();
      }
    }
    setBusyAction(null);
  };

  const presentation = connectionPresentation(viewState);
  const canAuthenticate = ["unauthenticated", "expired", "degraded"].includes(viewState);
  const isConnected = viewState === "connected";

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 border-b border-hair pb-6">
        <p className="eyebrow mb-2">Tyrion operations</p>
        <h1 className="font-serif text-3xl font-bold text-parchment sm:text-4xl">
          Monarch connector
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          Set up and maintain the bridge-owned Monarch session. Day-to-day finance
          work remains in Mission Control and Monarch.
        </p>
      </header>

      <section aria-labelledby="status-heading" className="mb-6 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <h2 id="status-heading" className="text-lg font-semibold">Connection status</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <StatusRow
                label="Bridge"
                value={
                  bridgeReachable === null
                    ? "Checking"
                    : bridgeReachable
                      ? "Reachable"
                      : "Unavailable"
                }
                tone={bridgeReachable === null ? "checking" : bridgeReachable ? "good" : "bad"}
              />
              <StatusRow
                label="Authentication"
                value={presentation.label}
                tone={presentation.tone}
              />
            </div>
            <p className="mt-4 text-sm text-muted" aria-live="polite">
              {presentation.description}
            </p>
            {statusError && <p role="alert" className="mt-2 text-sm text-error">{statusError}</p>}
          </div>
          <div className="flex items-center gap-2">
            {mode && (
              <span className="rounded border border-border bg-elevated px-2 py-1 text-xs text-muted">
                {mode} mode
              </span>
            )}
            <button
              type="button"
              onClick={() => void refreshStatus()}
              disabled={viewState === "checking" || busyAction !== null}
              className="rounded-md border border-border bg-elevated px-3 py-2 text-sm hover:border-gold disabled:opacity-50"
            >
              Recheck
            </button>
          </div>
        </div>
      </section>

      {canAuthenticate && (
        <section aria-labelledby="auth-heading" className="mb-6 rounded-xl border border-border bg-card p-5">
          <h2 id="auth-heading" className="text-lg font-semibold">Authenticate with Monarch</h2>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Authentication method">
            <MethodButton
              active={loginMethod === "cookies"}
              onClick={() => setLoginMethod("cookies")}
            >
              Browser cookies (recommended)
            </MethodButton>
            <MethodButton
              active={loginMethod === "password"}
              onClick={() => setLoginMethod("password")}
            >
              Email, password, and MFA fallback
            </MethodButton>
          </div>

          <form className="mt-5 space-y-4" onSubmit={handleLogin} autoComplete="off">
            {loginMethod === "cookies" ? (
              <>
                <details className="rounded-lg border border-border bg-background p-4 text-sm text-muted">
                  <summary className="cursor-pointer font-medium text-parchment">
                    Find the two browser cookie values
                  </summary>
                  <ol className="mt-3 list-decimal space-y-2 pl-5 leading-6">
                    <li>
                      Sign in at{" "}
                      <a
                        className="text-gold-hi underline"
                        href="https://app.monarchmoney.com"
                        target="_blank"
                        rel="noreferrer"
                      >
                        app.monarchmoney.com
                      </a>
                      .
                    </li>
                    <li>Open browser developer tools, then Application or Storage.</li>
                    <li>
                      Under Cookies, copy only the values named <code>session_id</code>{" "}
                      and <code>csrftoken</code>.
                    </li>
                  </ol>
                  <p className="mt-3 text-warning">
                    Treat cookie values like a password. Do not save, send, log, or
                    screenshot them.
                  </p>
                </details>
                <SecretField
                  id="session-id"
                  label="session_id value"
                  value={sessionId}
                  onChange={setSessionId}
                />
                <SecretField
                  id="csrf-token"
                  label="csrftoken value"
                  value={csrfToken}
                  onChange={setCsrfToken}
                />
              </>
            ) : (
              <>
                <p className="text-sm leading-6 text-warning">
                  Monarch may reject programmatic login or require browser verification.
                  Use browser cookies if this fallback is blocked.
                </p>
                <label className="block text-sm text-muted" htmlFor="monarch-email">
                  Monarch email
                </label>
                <input
                  id="monarch-email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <SecretField
                  id="monarch-password"
                  label="Monarch password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                />
                <label className="block text-sm text-muted" htmlFor="mfa-code">
                  MFA code {mfaRequested ? "(required)" : "(when requested)"}
                </label>
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required={mfaRequested}
                  minLength={4}
                  maxLength={32}
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </>
            )}

            <button
              type="submit"
              disabled={
                busyAction !== null ||
                (loginMethod === "cookies"
                  ? !sessionId.trim() || !csrfToken.trim()
                  : !email.trim() || !password)
              }
              className="w-full rounded-md bg-success px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busyAction === "login" ? "Authenticating..." : "Authenticate"}
            </button>
          </form>
        </section>
      )}

      {isConnected && (
        <section aria-labelledby="maintenance-heading" className="rounded-xl border border-border bg-card p-5">
          <h2 id="maintenance-heading" className="text-lg font-semibold">Maintenance</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Sync is intentionally limited to the most recent 30 days. This page does
            not display accounts, transactions, budgets, bills, or other finance data.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleSync}
              disabled={busyAction !== null}
              className="rounded-md bg-gold px-4 py-2.5 text-sm font-semibold text-background disabled:opacity-50"
            >
              {busyAction === "sync" ? "Syncing..." : "Sync 30 days and recheck"}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={busyAction !== null}
              className="rounded-md border border-error/60 px-4 py-2.5 text-sm font-semibold text-error disabled:opacity-50"
            >
              {busyAction === "logout" ? "Disconnecting..." : "Disconnect Monarch"}
            </button>
          </div>
        </section>
      )}

      <div className="mt-5 min-h-6" aria-live="polite">
        {notice && <p className="text-sm text-success">{notice}</p>}
        {actionError && <p role="alert" className="text-sm text-error">{actionError}</p>}
      </div>
    </main>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warning" | "bad" | "checking";
}) {
  const color =
    tone === "good"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "bad"
          ? "bg-error"
          : "animate-pulse bg-muted";
  return (
    <div className="flex min-w-48 items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} aria-hidden="true" />
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="ml-auto text-sm font-medium">{value}</span>
    </div>
  );
}

function MethodButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-sm ${
        active ? "border-gold text-parchment" : "border-border text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function SecretField({
  id,
  label,
  value,
  onChange,
  autoComplete = "off",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
}) {
  return (
    <>
      <label className="block text-sm text-muted" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        required
        spellCheck={false}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
      />
    </>
  );
}
