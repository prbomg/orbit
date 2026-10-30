"use client";
import { useState } from "react";
import { LogOut } from "lucide-react";
export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function logout() {
    setPending(true); setError(false);
    try {
      const response = await fetch("/api/auth/logout/", { method: "POST" });
      if (!response.ok) throw new Error();
      window.location.replace("/login/");
    } catch { setError(true); setPending(false); }
  }
  return <div><button type="button" onClick={logout} disabled={pending} aria-label={pending ? "Выходим…" : "Выйти из аккаунта"} title={compact ? "Выйти из аккаунта" : undefined} className={`mt-4 flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground ${compact ? "justify-center" : ""}`}><LogOut size={16} className="shrink-0" /><span className={compact ? "sr-only" : undefined}>{pending ? "Выходим…" : "Выйти из аккаунта"}</span></button>{error && <p role="alert" className="form-error">Не удалось выйти. Повторите попытку.</p>}</div>;
}
