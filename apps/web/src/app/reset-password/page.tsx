"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    setToken(String(url.searchParams.get("token") ?? "").trim());
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("Reset token is missing or invalid.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to reset password");
      setSaved(true);
      setPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setError(err?.message ?? "Failed to reset password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="h-screen flex items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm border rounded-lg p-6 space-y-4">
        <div className="text-lg font-semibold">Reset password</div>
        {saved ? (
          <div className="space-y-3">
            <div className="text-sm text-green-700">Password updated. You can sign in now.</div>
            <Link className="inline-block px-3 py-2 border rounded text-sm" href="/">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="New password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Confirm new password"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
            />
            {error ? <div className="text-xs text-red-600">{error}</div> : null}
            <button className="w-full px-3 py-2 border rounded text-sm" type="submit" disabled={submitting}>
              {submitting ? "Updating..." : "Update password"}
            </button>
            <Link className="inline-block text-xs underline" href="/">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
