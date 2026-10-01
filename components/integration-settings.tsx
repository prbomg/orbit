"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = { rucaptchaConfigured: boolean; openaiConfigured: boolean; openaiStored: boolean; openaiSource: string };
export function IntegrationSettings({ kind, planMode = "local" }: { kind: "openai" | "rucaptcha"; planMode?: "local" | "openai" }) {
  const name = kind === "openai" ? "OpenAI" : "RuCaptcha / 2Captcha";
  const [settings, setSettings] = useState<Settings | null>(null); const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false); const [key, setKey] = useState(""); const [visible, setVisible] = useState(false);
  const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const configured = kind === "openai" ? settings?.openaiConfigured : settings?.rucaptchaConfigured;
  const stored = kind === "openai" ? settings?.openaiStored : settings?.rucaptchaConfigured;
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/", { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Не удалось загрузить настройки"); setSettings(body);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function save(value: string | null) {
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/settings/", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [kind === "openai" ? "openaiApiKey" : "rucaptchaApiKey"]: value }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Не удалось сохранить ключ");
      setSettings(body); setKey(""); setVisible(false);
      setMessage(value ? kind === "openai" && planMode === "local" ? "Ключ сохранён, но локальный сценарий не обращается к OpenAI." : "Ключ сохранён в базе и доступен воркеру. Соединение с сервисом не проверялось." : kind === "openai" && body.openaiConfigured ? "Ключ удалён из базы. Воркер продолжит использовать ключ из окружения." : "Ключ удалён.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить ключ"); }
    finally { setSaving(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!key.trim() || /\s/.test(key.trim())) { setError("Введите ключ без пробелов."); return; } void save(key.trim()); }
  const Icon = kind === "openai" ? Sparkles : ShieldCheck;
  return <section className="panel"><div className="panel-heading"><div className="integration-title"><span className="integration-icon"><Icon size={23} /></span><div><h2>{name}</h2><p>{kind === "openai" ? planMode === "local" ? "Не требуется для локального сценария" : "План для прямого посещения URL" : "reCAPTCHA v2 и Яндекс SmartCaptcha"}</p></div></div><span className={`connection-label ${configured ? "text-primary" : ""}`}>{loading ? "Загрузка…" : kind === "openai" && planMode === "local" ? "Не используется" : configured ? "Ключ задан" : "Не настроено"}</span></div>
    <form onSubmit={submit} className="settings-form"><Label htmlFor={`${kind}-key`}>API-ключ {kind === "openai" ? "OpenAI" : "RuCaptcha"}</Label><div className="key-field"><KeyRound size={17} /><Input id={`${kind}-key`} type={visible ? "text" : "password"} disabled={loading || saving} value={key} onChange={event => { setKey(event.target.value); setError(""); setMessage(""); }} placeholder={stored ? "Новый ключ для замены" : "Введите API-ключ"} autoComplete="off" maxLength={500} spellCheck={false} className="pl-11 pr-12 font-mono" /><Button variant="ghost" size="icon" type="button" onClick={() => setVisible(!visible)} aria-label={`${visible ? "Скрыть" : "Показать"} ключ ${kind === "openai" ? "OpenAI" : "RuCaptcha"}`}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</Button></div>
      <p className="field-help">Сохранённый ключ не возвращается в браузер. {kind === "openai" ? planMode === "local" ? "Текущий режим строит сценарии на устройстве; OpenAI API не вызывается, даже если ключ сохранён." : `Источник: ${settings?.openaiSource === "database" ? "база данных" : settings?.openaiSource === "environment" ? "окружение воркера" : "не задан"}. Поиск и прогрев работают без OpenAI.` : "Воркер читает ключ при проверке капчи. Решения оплачиваются с баланса провайдера."}</p>
      {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="text-sm text-primary">{message}</p>}
      <div className="settings-save"><Button variant="ghost" type="button" disabled={!stored || loading || saving} onClick={() => void save(null)}><Trash2 size={16} />Удалить ключ</Button><Button type="submit" disabled={loading || saving || !key.trim()}><Check size={16} />{saving ? "Сохранение…" : "Сохранить ключ"}</Button></div>
    </form></section>;
}
