"use client";

import { useState, useTransition } from "react";
import { Card } from "@/ui-kit/components/Card";
import { btnPrimary } from "@/lib/buttonStyles";

interface LoginFormProps {
  next: string;
  action: (formData: FormData) => Promise<{ ok: false; error: string } | void>;
}

export default function LoginForm({ next, action }: LoginFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result && result.ok === false) setError(result.error);
    });
  }

  return (
    <Card className="p-6">
      <form action={handleSubmit} className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 transition-colors duration-100 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
        />
        <button type="submit" disabled={pending} className={`${btnPrimary} w-full`}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </form>
    </Card>
  );
}
