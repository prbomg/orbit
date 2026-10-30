"use client";
import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function LoginForm() {
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    setPending(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: data.get("email"), password: data.get("password"), rememberMe: data.get("rememberMe") === "on" }) });
      if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error || "Не удалось войти. Повторите попытку."); }
      window.location.replace("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подключиться к сервису"); setPending(false); }
  }
  return <form onSubmit={submit} className="login-form">
    <div className="grid gap-2"><Label htmlFor="email">Рабочая почта</Label><Input id="email" name="email" type="email" autoComplete="username" placeholder="name@company.ru" maxLength={254} required disabled={pending} className="h-12" /></div>
    <div className="grid gap-2"><Label htmlFor="password">Пароль</Label><div className="relative"><Input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" placeholder="Введите пароль" maxLength={256} required disabled={pending} className="h-12 pr-12" /><button type="button" aria-label={visible ? "Скрыть пароль" : "Показать пароль"} aria-pressed={visible} onClick={() => setVisible(!visible)} className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></div>
    <div className="grid gap-1"><label htmlFor="remember-me" className="flex cursor-pointer items-center gap-3 text-sm"><input id="remember-me" name="rememberMe" type="checkbox" disabled={pending} className="h-4 w-4 accent-primary" />Запомнить меня</label><p className="text-xs text-muted-foreground">Сохранять вход на этом устройстве 30 дней</p></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <Button type="submit" disabled={pending} className="h-12 w-full text-sm">{pending ? <><LoaderCircle className="animate-spin" size={17} />Входим…</> : <>Войти в пространство<ArrowRight size={17} /></>}</Button>
  </form>;
}
