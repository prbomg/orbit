"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles, Trash2, RefreshCw, Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Account = { key: string | null; balance: number | null; checkedAt: string | null; errorCode: string | null };
type Settings = { rucaptchaConfigured: boolean; capguruConfigured: boolean; openaiConfigured: boolean; openaiStored: boolean; openaiSource: string };
export function IntegrationSettings({ kind, planMode = "local", roleLabel }: { kind: "openai" | "rucaptcha" | "capguru"; planMode?: "local" | "openai"; roleLabel?: string }) {
  const name = kind === "openai" ? "OpenAI" : kind === "capguru" ? "Cap.Guru" : "RuCaptcha / 2Captcha";
  const keyField = kind === "openai" ? "openaiApiKey" : kind === "capguru" ? "capguruApiKey" : "rucaptchaApiKey";
  const accountUrl = `/api/settings/${kind}/`;
  const [settings, setSettings] = useState<Settings | null>(null); const [loading, setLoading] = useState(true);
  const [savedKey, setSavedKey] = useState(""); const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false); const [key, setKey] = useState(""); const [visible, setVisible] = useState(kind !== "openai");
  const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const configured = kind === "openai" ? settings?.openaiConfigured : kind === "capguru" ? settings?.capguruConfigured : settings?.rucaptchaConfigured;
  const stored = kind === "openai" ? settings?.openaiStored : kind === "capguru" ? settings?.capguruConfigured : settings?.rucaptchaConfigured;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(kind !== "openai" ? accountUrl : "/api/settings/", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Не удалось загрузить настройки"); setSettings(body); if (kind !== "openai") { setAccount(body); setKey(body.key ?? ""); setSavedKey(body.key ?? ""); }
    }).catch(cause => { if (!controller.signal.aborted) setError("Не удалось загрузить настройки сервиса. Обновите страницу, чтобы повторить."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind]);
  async function refreshBalance() {
    setBalanceLoading(true);
    try {
      const response = await fetch(accountUrl + "?refresh=1", { cache: "no-store", signal: AbortSignal.timeout(12000) });
      const body = await response.json(); if (!response.ok) throw new Error("Не удалось обновить баланс");
      setAccount(body);
    } catch { setAccount(previous => ({ key: previous?.key ?? null, balance: null, checkedAt: previous?.checkedAt ?? null, errorCode: "BALANCE_UNAVAILABLE" })); }
    finally { setBalanceLoading(false); }
  }
  async function save(value: string | null) {
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/settings/", { method: "PATCH", signal: AbortSignal.timeout(12000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [keyField]: value }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Не удалось сохранить ключ");
      setSettings(body); setKey(kind !== "openai" ? value ?? "" : ""); setSavedKey(kind !== "openai" ? value ?? "" : ""); setVisible(kind !== "openai");
      if (kind !== "openai") await refreshBalance();
      setMessage(kind !== "openai" ? value ? "Ключ сохранён. Применится в новых сессиях обработки капчи." : "Ключ удалён." : value ? kind === "openai" && planMode === "local" ? "Ключ сохранён, но локальный сценарий не обращается к OpenAI." : "Ключ сохранён в базе и доступен воркеру. Соединение с сервисом не проверялось." : kind === "openai" && body.openaiConfigured ? "Ключ удалён из базы. Воркер продолжит использовать ключ из окружения." : "Ключ удалён.");
    } catch (cause) { setError(cause instanceof Error && cause.name !== "TimeoutError" && !(cause instanceof TypeError) ? cause.message : "Не удалось сохранить ключ. Проверьте соединение и повторите."); }
    finally { setSaving(false); }
  }
  const dirty = !loading && key.trim() !== savedKey;
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  async function copyKey() { try { await navigator.clipboard.writeText(key); setCopied(true); } catch { setError("Не удалось скопировать ключ. Выделите и скопируйте его вручную."); } }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!dirty || saving) return; if (!key.trim() || /\s/.test(key.trim())) { setError("Введите ключ без пробелов."); return; } void save(key.trim()); }
  const Icon = kind === "openai" ? Sparkles : ShieldCheck;
  return <section className={`panel integration-card ${roleLabel === "Основной" ? "integration-card-primary" : ""}`} data-provider={kind}><div className="panel-heading"><div className="integration-title min-w-0"><span className="integration-icon"><Icon size={23} /></span><div>{roleLabel && <span className="provider-role">{roleLabel}</span>}<h2>{name}</h2><p>{kind === "openai" ? planMode === "local" ? "Не требуется для локального сценария" : "План для прямого посещения URL" : kind === "capguru" ? "Распознавание по двум картинкам" : "reCAPTCHA v2 и Яндекс SmartCaptcha"}</p></div></div><span className={`connection-label ${configured ? "text-primary" : ""}`}>{loading ? "Загрузка…" : kind === "openai" && planMode === "local" ? "Не используется" : configured ? "Ключ сохранён" : "Не настроено"}</span></div>
    <form onSubmit={submit} className="settings-form"><Label htmlFor={`${kind}-key`}>API-ключ {name}</Label><div className="key-field"><KeyRound size={17} /><Input id={`${kind}-key`} type={visible ? "text" : "password"} disabled={loading || saving} value={key} onChange={event => { setKey(event.target.value); setCopied(false); setError(""); setMessage(""); }} placeholder={stored ? "Новый ключ для замены" : "Введите API-ключ"} autoComplete="off" maxLength={500} spellCheck={false} className="pl-11 pr-20 font-mono" /><Button variant="ghost" size="icon" type="button" className="key-copy" disabled={loading || !key} onClick={() => void copyKey()} aria-label={`Копировать ключ ${name}`}><Copy size={16} /></Button><Button variant="ghost" size="icon" type="button" onClick={() => setVisible(!visible)} aria-label={`${visible ? "Скрыть" : "Показать"} ключ ${name}`}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</Button></div>
      {copied && <p role="status" className="text-xs text-primary">Ключ скопирован.</p>}
      <p className="field-help">{kind === "openai" ? planMode === "local" ? "Сохранённый ключ не возвращается в браузер. Текущий режим строит сценарии на устройстве; OpenAI API не вызывается, даже если ключ сохранён." : `Сохранённый ключ не возвращается в браузер. Источник: ${settings?.openaiSource === "database" ? "база данных" : settings?.openaiSource === "environment" ? "окружение воркера" : "не задан"}. Поиск и прогрев работают без OpenAI.` : "Ключ доступен для просмотра и копирования."}</p>
      {kind !== "openai" && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"><div><p className="text-xs text-muted-foreground">Баланс сервиса</p><p className="mt-1 font-mono text-xl" data-testid={`${kind}-balance`}>{loading || balanceLoading ? "Загрузка…" : account?.balance != null ? account.balance.toLocaleString("ru-RU", { maximumFractionDigits: 5 }) : "—"}</p>{account?.errorCode && <p role="status" className="mt-2 text-xs text-amber-300">{account.errorCode === "ERROR_ZERO_BALANCE" ? "На счёте нет средств" : ["ERROR_WRONG_USER_KEY", "ERROR_KEY_DOES_NOT_EXIST"].includes(account.errorCode) ? "Сервис не принял API-ключ" : "Баланс временно недоступен"}<span className="block font-mono mt-1">{account.errorCode}</span></p>}{account?.balance != null && <p className="mt-1 text-xs text-primary">Баланс получен от сервиса</p>}{account?.checkedAt && <p className="mt-1 text-xs text-muted-foreground">Проверен {new Date(account.checkedAt).toLocaleTimeString("ru-RU")}</p>}</div><Button type="button" size="sm" variant="outline" disabled={loading || saving || balanceLoading || !configured} aria-label={`Обновить баланс ${name}`} onClick={() => void refreshBalance()}><RefreshCw size={14} />Обновить</Button></div>}
      {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="text-sm text-primary">{message}</p>}
      <div className="integration-draft" aria-live="polite">{dirty && <span className="text-xs text-amber-300">Есть несохранённые изменения</span>}</div>
      <div className="settings-save"><Button variant="ghost" type="button" disabled={!dirty || saving} onClick={() => { setKey(savedKey); setError(""); setMessage(""); setCopied(false); }}><RotateCcw size={15} />Отменить</Button><Button type="submit" disabled={loading || saving || !dirty || !key.trim()}><Check size={16} />{saving ? "Сохранение…" : "Сохранить ключ"}</Button></div>
      {stored && <details className="integration-key-actions"><summary>Управление ключом</summary><Button variant="ghost" className="mt-2 text-destructive" type="button" disabled={loading || saving} onClick={() => void save(null)}><Trash2 size={15} />Удалить ключ</Button></details>}
    </form></section>;
}
