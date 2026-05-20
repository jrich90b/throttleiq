"use client";

import { useEffect, useState } from "react";

type AuthState = "loading" | "authed" | "guest";

export default function CommandLayout({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkAuth() {
    const resp = await fetch("/api/auth/me", { cache: "no-store" });
    const data = await resp.json().catch(() => null);
    setAuthState(resp.ok && data?.ok && data?.user ? "authed" : "guest");
  }

  useEffect(() => {
    void checkAuth();
  }, []);

  async function submitLogin() {
    setBusy(true);
    setError("");
    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Sign in failed.");
      setEmail("");
      setPassword("");
      setAuthState("authed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  if (authState === "loading") {
    return (
      <main className="lr-auth-shell">
        <div className="lr-auth-loading">Loading...</div>
      </main>
    );
  }

  if (authState === "guest") {
    return (
      <main className="lr-auth-shell">
        <div className="lr-auth-card w-full max-w-sm space-y-4">
          <div className="lr-auth-title text-lg font-semibold">Command sign in</div>
          <input
            className="lr-auth-input w-full px-3 py-2 text-sm"
            placeholder="Email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") void submitLogin();
            }}
          />
          <input
            className="lr-auth-input w-full px-3 py-2 text-sm"
            placeholder="Password"
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") void submitLogin();
            }}
          />
          {error ? <div className="text-xs lr-auth-error">{error}</div> : null}
          <button className="lr-auth-primary-btn w-full px-3 py-2 rounded text-sm" onClick={submitLogin} disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </div>
      </main>
    );
  }

  return children;
}
