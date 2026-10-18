"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Login failed");
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-3xl border border-white/80 bg-white/90 p-8 shadow-sm backdrop-blur"
      >
        <p className="text-xs uppercase tracking-[0.24em] text-amber-800">
          QUEST 2026 · Season 04
        </p>
        <h1
          className="mt-1 text-3xl text-[#142033]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Sign in
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Sheet recovery console access.
        </p>

        <label className="mt-6 block text-sm">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="mt-2 block w-full rounded-2xl border border-slate-200 bg-white p-3"
          />
        </label>
        <label className="mt-4 block text-sm">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-2 block w-full rounded-2xl border border-slate-200 bg-white p-3"
          />
        </label>

        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="mt-6 w-full rounded-2xl bg-[#142033] px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
