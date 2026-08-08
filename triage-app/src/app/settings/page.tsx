"use client";

import { useState, useEffect, useCallback } from "react";
import { getAuthStatus, login, loginWithCookies, logout, syncData } from "@/lib/bridge-client";

type ConnectionStatus = "connected" | "unauthenticated" | "expired" | "degraded" | "checking" | "error";

export default function SettingsPage() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("checking");
  const [email, setEmail] = useState("");
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("unknown");

  // Login form state
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginMethod, setLoginMethod] = useState<"password" | "cookies">("cookies");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [csrfToken, setCsrfToken] = useState("");

  // Sync controls
  const [syncInterval, setSyncInterval] = useState("4h");
  const [syncing, setSyncing] = useState(false);

  // Toast
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const checkStatus = useCallback(async () => {
    setConnectionStatus("checking");
    const res = await getAuthStatus();
    if (res.data) {
      setMode(res.data.mode);
      if (res.data.authenticated) {
        setConnectionStatus("connected");
        setEmail(res.data.email || "");
      } else {
        setConnectionStatus(res.data.authState);
      }
    } else {
      setConnectionStatus("error");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    setLoginLoading(true);
    const res = loginMethod === "password"
      ? await login(loginEmail, loginPassword, mfaCode || undefined)
      : await loginWithCookies(sessionId, csrfToken);
    if (res.data) {
      showToast("Connected to Monarch Money");
      setLoginPassword("");
      setMfaCode("");
      setSessionId("");
      setCsrfToken("");
      checkStatus();
    } else {
      setLoginError(res.error || "Authentication failed.");
    }
    setLoginLoading(false);
  };

  const handleLogout = async () => {
    await logout();
    setConnectionStatus("unauthenticated");
    setEmail("");
    showToast("Disconnected from Monarch Money");
  };

  const handleSync = async () => {
    setSyncing(true);
    const days = syncInterval === "1h" ? 7 : syncInterval === "4h" ? 30 : syncInterval === "12h" ? 60 : 90;
    const res = await syncData(days);
    if (res.data) {
      setLastSync(new Date().toLocaleString());
      showToast(`Synced ${res.data.transactionsFetched} transactions`);
    } else if (res.status === 401) {
      await checkStatus();
      showToast("Monarch session expired - reconnect with fresh browser cookies");
    } else {
      showToast("Sync failed - check connection");
    }
    setSyncing(false);
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="mb-6">
        <h1 className="text-3xl font-serif font-bold">Settings</h1>
        <p className="text-sm text-muted mt-1">Manage your Monarch Money connection and preferences</p>
      </div>

      {/* Connection Status Card */}
      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${
              connectionStatus === "connected" ? "bg-success" :
              connectionStatus === "checking" ? "bg-warning animate-pulse" :
              "bg-error"
            }`} />
            <div>
              <h2 className="text-sm font-semibold">Monarch Money Connection</h2>
              <p className="text-xs text-muted mt-0.5">
                {connectionStatus === "connected" && (
                  email ? `Connected as ${email}` : "Connected"
                )}
                {connectionStatus === "unauthenticated" && "Not authenticated"}
                {connectionStatus === "expired" && "Session expired — authenticate again"}
                {connectionStatus === "degraded" && "Session unavailable — check Monarch and retry"}
                {connectionStatus === "checking" && "Checking connection..."}
                {connectionStatus === "error" && "Bridge unavailable — is it running on port 8100?"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {mode !== "unknown" && (
              <span className="text-xs px-2 py-0.5 rounded bg-elevated border border-card-2 text-muted">
                {mode} mode
              </span>
            )}
            {connectionStatus === "connected" && (
              <button
                onClick={handleLogout}
                className="text-xs px-3 py-1.5 rounded-md border border-error/50 text-error hover:bg-error/30 transition-colors"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
        {lastSync && (
          <p className="text-xs text-muted mt-3 border-t border-border pt-3">
            Last sync: {lastSync}
          </p>
        )}
      </div>

      {/* Login Form — only shown when disconnected */}
      {(["unauthenticated", "expired", "degraded", "error"] as ConnectionStatus[]).includes(connectionStatus) && (
        <div className="bg-card border border-border rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold mb-4">Connect to Monarch Money</h2>
          <div className="flex gap-2 mb-4">
            {(["cookies", "password"] as const).map((method) => (
              <button
                key={method}
                type="button"
                onClick={() => setLoginMethod(method)}
                className={`text-xs px-3 py-1.5 rounded-md border ${
                  loginMethod === method ? "border-success text-success" : "border-card-2 text-muted"
                }`}
              >
                {method === "password"
                  ? "Email and password (best effort)"
                  : "Browser cookies (recommended)"}
              </button>
            ))}
          </div>
          <form onSubmit={handleLogin} className="space-y-3" autoComplete="off">
            {loginMethod === "password" ? (
              <>
                <p className="text-xs text-warning">
                  Monarch may block programmatic password login even when account MFA
                  is disabled. Use browser cookies if Monarch rejects this method.
                </p>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="Monarch email"
                  autoComplete="username"
                  className="w-full px-3 py-2 rounded-md bg-background border border-card-2 text-sm"
                />
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Monarch password"
                  autoComplete="current-password"
                  className="w-full px-3 py-2 rounded-md bg-background border border-card-2 text-sm"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="MFA code (when requested)"
                  autoComplete="one-time-code"
                  className="w-full px-3 py-2 rounded-md bg-background border border-card-2 text-sm"
                />
              </>
            ) : (
              <>
                <details className="rounded-md border border-card-2 bg-background px-3 py-2 text-xs text-muted">
                  <summary className="cursor-pointer font-medium text-foreground">
                    How to get browser cookies in Microsoft Edge
                  </summary>
                  <ol className="mt-3 list-decimal space-y-2 pl-5">
                    <li>
                      Sign in at{" "}
                      <a
                        href="https://app.monarchmoney.com"
                        target="_blank"
                        rel="noreferrer"
                        className="text-success underline"
                      >
                        app.monarchmoney.com
                      </a>
                      {" "}and leave that tab open.
                    </li>
                    <li>
                      Press <kbd className="font-mono">F12</kbd> or{" "}
                      <kbd className="font-mono">Ctrl+Shift+I</kbd> to open Edge
                      DevTools.
                    </li>
                    <li>
                      Open <strong>Application</strong>. If it is hidden, select the{" "}
                      <strong>+</strong> tab and choose <strong>Application</strong>.
                    </li>
                    <li>
                      In the left sidebar, expand <strong>Storage</strong>, then{" "}
                      <strong>Cookies</strong>. Select the Monarch entry that contains
                      cookies named <code>session_id</code> and <code>csrftoken</code>.
                    </li>
                    <li>
                      Copy each cookie&apos;s <strong>Value</strong> into its matching
                      field below. Tyrion constructs the cookie header in memory.
                    </li>
                  </ol>
                  <p className="mt-3 text-warning">
                    Treat these values like a password. Paste them only into this local
                    page. Do not send, save, screenshot, or commit them.
                  </p>
                </details>
                <label htmlFor="monarch-session-id" className="block text-xs text-muted">
                  <code>session_id</code> value
                </label>
                <input
                  id="monarch-session-id"
                  type="password"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-background border border-card-2 text-xs focus:outline-none focus:border-success/50 font-mono"
                  placeholder="Paste the session_id value"
                  spellCheck={false}
                />
                <label htmlFor="monarch-csrf-token" className="block text-xs text-muted">
                  <code>csrftoken</code> value
                </label>
                <input
                  id="monarch-csrf-token"
                  type="password"
                  value={csrfToken}
                  onChange={(e) => setCsrfToken(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-background border border-card-2 text-xs focus:outline-none focus:border-success/50 font-mono"
                  placeholder="Paste the csrftoken value"
                  spellCheck={false}
                />
              </>
            )}
            {loginError && (
              <p className="text-xs text-error bg-error/20 border border-error/30 rounded-md px-3 py-2">
                {loginError}
              </p>
            )}
            <button
              type="submit"
              disabled={
                loginLoading ||
                (loginMethod === "password"
                  ? !loginEmail.trim() || !loginPassword
                  : !sessionId.trim() || !csrfToken.trim())
              }
              className="w-full py-2 rounded-md bg-success hover:bg-success text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loginLoading ? "Connecting..." : "Connect"}
            </button>
          </form>
        </div>
      )}

      {/* Sync Controls */}
      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-4">Sync Controls</h2>
        <div className="flex items-center gap-4">
          <button
            onClick={handleSync}
            disabled={syncing || connectionStatus !== "connected"}
            className="px-4 py-2 rounded-md bg-elevated border border-card-2 text-sm hover:bg-hair transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted">Interval:</label>
            <select
              value={syncInterval}
              onChange={(e) => setSyncInterval(e.target.value)}
              className="px-2 py-1 rounded-md bg-background border border-card-2 text-sm focus:outline-none"
            >
              <option value="1h">Every 1 hour</option>
              <option value="4h">Every 4 hours</option>
              <option value="12h">Every 12 hours</option>
              <option value="daily">Daily</option>
            </select>
          </div>
        </div>
      </div>

      {/* Kids Configuration (placeholder) */}
      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Kid Configuration</h2>
        <p className="text-xs text-muted mb-3">Manage spending limits and categories per child.</p>
        <div className="space-y-2">
          {["Jake", "Emma", "Sophie"].map((kid) => (
            <div key={kid} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <span className="text-sm">{kid}</span>
              <span className="text-xs text-muted">Configured</span>
            </div>
          ))}
        </div>
      </div>

      {/* Alert Preferences (placeholder) */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-3">Alert Preferences</h2>
        <p className="text-xs text-muted">Configure when and how you receive spending alerts.</p>
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">Budget overages</span>
            <span className="text-xs text-success">Enabled</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Kid spending alerts</span>
            <span className="text-xs text-success">Enabled</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Large transactions (&gt;$200)</span>
            <span className="text-xs text-success">Enabled</span>
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in">
          <div className="bg-card-2 border border-card-2 text-white text-sm px-4 py-2.5 rounded-lg shadow-xl">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
