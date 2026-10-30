"use client";
import { useEffect, useState } from "react";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
type Policy = { primary: string; after: number };
export function CaptchaPolicySettings({ embedded = false, onPrimaryChange }: { embedded?: boolean; onPrimaryChange?: (primary: string) => void }) {
  const [primary, setPrimary] = useState("rucaptcha"), [after, setAfter] = useState(2);
  const [saved, setSaved] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const dirty = saved !== null && (saved.primary !== primary || saved.after !== after);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), cache: "no-store" }).then(async response => {
      if (!response.ok) throw Error("Не удалось загрузить приоритет сервисов");
      const data = await response.json(); setPrimary(data.captchaPrimary); setAfter(data.captchaFallbackAfter); setSaved({ primary: data.captchaPrimary, after: data.captchaFallbackAfter }); onPrimaryChange?.(data.captchaPrimary);
    }).catch(() => { if (!controller.signal.aborted) setError("Не удалось загрузить приоритет. Обновите страницу, чтобы повторить."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onPrimaryChange]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  async function save() {
    if (!dirty) return; setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/settings/", { method: "PATCH", signal: AbortSignal.timeout(12000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ captchaPrimary: primary, captchaFallbackAfter: after }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || "Не удалось сохранить настройки");
      setSaved({ primary: data.captchaPrimary, after: data.captchaFallbackAfter }); onPrimaryChange?.(data.captchaPrimary); setMessage("Приоритет сохранён. Применится в новых сессиях обработки капчи.");
    } catch (cause) { setError(cause instanceof Error && cause.name !== "TimeoutError" && !(cause instanceof TypeError) ? cause.message : "Не удалось сохранить приоритет. Проверьте соединение и повторите."); }
    finally { setSaving(false); }
  }
  const name = (value: string) => value === "capguru" ? "Cap.Guru" : "RuCaptcha";
  const content = <>
    <div className="captcha-order" aria-label="Сохранённый порядок сервисов">{loading ? "Загружаем настройки…" : saved ? <><strong>{name(saved.primary)}</strong><ArrowRight size={17} aria-hidden="true" /><strong>{name(saved.primary === "capguru" ? "rucaptcha" : "capguru")}</strong><span>После {saved.after} {saved.after === 1 ? "ошибки" : "ошибок"}</span></> : "Порядок недоступен"}</div>
    <div className="captcha-policy-fields"><div><Label htmlFor="captcha-primary">Основной сервис</Label><select id="captcha-primary" value={primary} disabled={loading || saving || !saved} onChange={event => { setPrimary(event.target.value); setMessage(""); }}><option value="rucaptcha">RuCaptcha</option><option value="capguru">Cap.Guru</option></select></div><div><Label htmlFor="captcha-fallback">Переключаться после</Label><select id="captcha-fallback" value={after} disabled={loading || saving || !saved} onChange={event => { setAfter(Number(event.target.value)); setMessage(""); }}>{[1,2,3].map(value => <option key={value} value={value}>{value} {value === 1 ? "ошибки" : "ошибок"} подряд</option>)}</select></div></div>
    <div className="captcha-policy-actions"><div aria-live="polite">{dirty ? <span className="text-sm text-amber-300">Есть несохранённые изменения</span> : <span className="field-help">Приоритет действует для заданий с двумя картинками.</span>}</div><div className="flex flex-wrap gap-2">{dirty && <Button type="button" variant="ghost" disabled={saving} onClick={() => { setPrimary(saved!.primary); setAfter(saved!.after); setMessage(""); setError(""); }}><RotateCcw size={14} />Отменить</Button>}<Button type="button" onClick={() => void save()} disabled={!dirty || saving}><Check size={15} />{saving ? "Сохранение…" : "Сохранить приоритет"}</Button></div></div>
    {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="text-sm text-primary">{message}</p>}
    <details className="captcha-policy-help"><summary>Как работает переключение</summary><p className="field-help mt-3">Запасной сервис используется после заданного количества последовательных ошибок сервиса или отклонённых решений в одной браузерной сессии. Успешная загрузка страницы сбрасывает счётчик. После переключения сессия остаётся на запасном сервисе. HTTP 429 от сайта не учитывается. Общий лимит платных попыток сохраняется.</p><p className="field-help mt-2">Если ключ основного отсутствует, используется запасной. Для работы обоих нужны оба ключа. Остальные типы капчи обрабатывает RuCaptcha.</p></details>
  </>;
  return embedded ? <div className="captcha-policy">{content}</div> : <section className="panel"><div className="panel-heading"><h2>Порядок сервисов капчи</h2></div><div className="captcha-policy">{content}</div></section>;
}
