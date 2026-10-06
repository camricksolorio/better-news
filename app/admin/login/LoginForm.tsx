"use client";

import { useActionState } from "react";
import { login } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input
        name="secret"
        type="password"
        autoComplete="current-password"
        placeholder="Admin secret"
        required
        className="rounded border border-zinc-300 bg-white px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-zinc-950 px-3 py-2 text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950"
      >
        Sign in
      </button>
    </form>
  );
}
