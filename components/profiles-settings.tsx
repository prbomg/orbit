"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DeviceDistributionSettings } from "@/components/device-distribution-settings";
import { ProfileGenerationPreview } from "@/components/profile-generation-preview";
import { ProjectSchedule } from "@/components/project-schedule";
import type { PoolSettings } from "@/components/profile-pool-settings";
import type { DeviceTemplate } from "@/utils/deviceCatalog";
import plans from "@/utils/warmupPlan";
import { preset, type SchedulePreset } from "@/utils/projectSchedule";
import { projectRequest as api } from "@/lib/projects";

export type ProfilesSettingsConfig = PoolSettings & {
  fingerprintCatalog: { version: string; templates: DeviceTemplate[] };
  fingerprintDeviceWeights: Record<string, number>;
  fingerprintDistributionRevision: number;
  fingerprintDevicePreset: "mixed" | "s23_android14";
  fingerprintMode: string;
  fingerprintLocale: string;
  fingerprintTimezone: string;
  mobileProxyConfigured: boolean;
};
const fields = ["fingerprintDeviceWeights", "fingerprintDevicePreset", "fingerprintMode", "fingerprintLocale", "fingerprintTimezone", "warmupPlanPreset", "autoReplenishEnabled", "minReadyProfiles", "replenishBatchSize", "warmupEnabled", "warmupScheduleHours", "warmupScheduleTimezone", "warmupConcurrency", "warmupSharedProxy", "warmupStageIntervalHours", "maxPendingProfiles", "dailyProfileDemand", "readinessFreshnessHours"] as const;
const sections = [["creation", "Создание профилей"], ["preparation", "Подготовка"], ["reserve", "Запас и автопополнение"], ["integrations", "Интеграции"]] as const;
const selectClass = "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";
function Field({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-2"><Label htmlFor={id}>{title}</Label>{children}</div>;
}
function More({ title, children }: { title: string; children: ReactNode }) {
  return <details className="min-w-0 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{title}</summary><div className="mt-4 min-w-0 space-y-4">{children}</div></details>;
}

export function ProfilesSettings({ config, onSaved }: { config: ProfilesSettingsConfig; onSaved: (next: ProfilesSettingsConfig) => void }) {
  const [base, setBase] = useState(config), [draft, setDraft] = useState(config);
  const [section, setSection] = useState<string>("creation"), [key, setKey] = useState("");
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const changes = Object.fromEntries(fields.filter(field => JSON.stringify(draft[field]) !== JSON.stringify(base[field])).map(field => [field, draft[field]]));
  const dirty = Object.keys(changes).length > 0 || Boolean(key.trim());
  const conflict = dirty && config.updatedAt !== base.updatedAt;
  useEffect(() => { if (!dirty) { setBase(config); setDraft(config); } }, [config, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const leave = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.("a[href]");
      if (!anchor || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0 || anchor.getAttribute("target") === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.getAttribute("href")!, window.location.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname) return;
      if (!window.confirm("В настройках профилей есть несохранённые изменения. Покинуть страницу?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  useEffect(() => { setRevealed(false); setCurrentKey(null); }, [section]);
  async function revealKey() {
    if (revealed) { setRevealed(false); setCurrentKey(null); return; }
    setBusy(true); setError("");
    try { const result = await api<{ key: string | null }>("/api/settings/mobileproxy-key/"); setCurrentKey(result.key); setRevealed(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось получить токен"); } finally { setBusy(false); }
  }
  function change<K extends keyof ProfilesSettingsConfig>(field: K, value: ProfilesSettingsConfig[K]) { setDraft(previous => ({ ...previous, [field]: value })); setMessage(""); setError(""); }
  function reset() { setBase(config); setDraft(config); setKey(""); setRevealed(false); setCurrentKey(null); setMessage(""); setError(""); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !dirty || conflict || !event.currentTarget.reportValidity()) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await api<ProfilesSettingsConfig>("/api/settings/", { method: "PATCH", body: JSON.stringify({ ...changes, ...(key.trim() ? { mobileProxyApiKey: key.trim() } : {}), expectedUpdatedAt: base.updatedAt }) });
      setBase(next); setDraft(next); setKey(""); setRevealed(false); setCurrentKey(null); onSaved(next); setMessage("Настройки сохранены. Параметры создания применятся к новым профилям; расписание — ко всей очереди.");
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить настройки"); } finally { setBusy(false); }
  }
  const plan = plans.createPlan({ warmupPlanPreset: draft.warmupPlanPreset || "standard", warmupStageIntervalMinutes: (Number.isFinite(draft.warmupStageIntervalHours) && draft.warmupStageIntervalHours > 0 ? draft.warmupStageIntervalHours : 12) * 60 });
  const pipeline = Math.ceil(draft.dailyProfileDemand * plan.minAgeHours / 24 * 1.25);
  const hours = [...draft.warmupScheduleHours].filter(value => value === "1").length;
  const scheduleSummary = hours === 168 ? "Ежедневно, круглосуточно" : hours === 0 ? "Новые сеансы не запускаются" : `Своё расписание · ${hours} ч. в неделю`;
  const numbers = (items: [keyof Pick<ProfilesSettingsConfig, "minReadyProfiles" | "replenishBatchSize" | "warmupConcurrency" | "warmupStageIntervalHours" | "maxPendingProfiles" | "dailyProfileDemand" | "readinessFreshnessHours">, string, number, number?][]) => <div className="grid gap-4 sm:grid-cols-2">{items.map(([field, title, min, max]) => <Field key={field} id={field} title={title}><Input id={field} type="number" min={min} max={max} step={field === "warmupStageIntervalHours" ? "any" : 1} required value={draft[field]} onChange={e => change(field, Number(e.target.value))} /></Field>)}</div>;
  const checkbox = (field: "warmupEnabled" | "warmupSharedProxy" | "autoReplenishEnabled", title: string) => <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft[field]} onChange={e => change(field, e.target.checked)} />{title}</label>;
  return <form onSubmit={save} noValidate className="min-w-0 space-y-4" aria-label="Настройки профилей">
    <div className="grid min-w-0 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav className="flex min-w-0 flex-wrap content-start gap-2 lg:flex-col" aria-label="Разделы настроек профилей">{sections.map(([id, title]) => <Button key={id} type="button" className="justify-start whitespace-normal text-left" variant={section === id ? "default" : "outline"} aria-pressed={section === id} onClick={() => setSection(id)}>{title}</Button>)}</nav>
      <section className="panel min-w-0">
        <div className="panel-heading"><div><h2>{sections.find(([id]) => id === section)?.[1]}</h2><p>{section === "creation" || section === "integrations" ? "Применяется к новым профилям. Существующие паспорта сохраняются." : section === "preparation" ? "План — для новых циклов; расписание и потоки — для всей очереди." : "Управляет автоматическим созданием новых профилей."}</p></div></div>
        <fieldset disabled={busy} className="min-w-0 space-y-5 border-t p-4 sm:p-5">
          {section === "creation" && <>
            <Field id="fp-mode" title="Источник профилей"><select id="fp-mode" className={selectClass} value={draft.fingerprintMode} onChange={e => change("fingerprintMode", e.target.value)}><option value="auto">Авто: MobileProxy → локальный</option><option value="local">Локальный генератор</option><option value="mobileproxy">Только MobileProxy</option></select></Field>
            {draft.fingerprintMode !== "local" && <p className="text-sm text-muted-foreground">MobileProxy: {draft.mobileProxyConfigured ? "подключён" : "не подключён"}. <button type="button" className="text-primary underline" onClick={() => setSection("integrations")}>Настроить подключение</button></p>}
            {draft.fingerprintMode !== "mobileproxy" && <>
              <div className="grid gap-4 sm:grid-cols-2"><Field id="fp-locale" title="Язык локальных профилей"><Input id="fp-locale" required maxLength={35} value={draft.fingerprintLocale} onChange={e => change("fingerprintLocale", e.target.value)} /></Field><Field id="fp-timezone" title="Часовой пояс локальных профилей"><Input id="fp-timezone" required maxLength={80} value={draft.fingerprintTimezone} onChange={e => change("fingerprintTimezone", e.target.value)} /></Field></div>
              <Field id="fp-preset" title="Набор устройств"><select id="fp-preset" className={selectClass} value={draft.fingerprintDevicePreset} onChange={e => change("fingerprintDevicePreset", e.target.value as ProfilesSettingsConfig["fingerprintDevicePreset"])}><option value="mixed">Смешанный набор Android-устройств</option><option value="s23_android14">Samsung Galaxy S23 · Android 14</option></select></Field>
              {draft.fingerprintDevicePreset === "mixed" ? <More title={`Настроить распределение · ${draft.fingerprintCatalog.templates.filter(t => draft.fingerprintDeviceWeights[t.id] > 0).length} активных моделей`}><DeviceDistributionSettings catalog={draft.fingerprintCatalog} weights={draft.fingerprintDeviceWeights} revision={draft.fingerprintDistributionRevision} disabled={busy} onChange={weights => change("fingerprintDeviceWeights", weights)} /></More> : <p className="text-sm text-muted-foreground">Samsung Galaxy S23 · SM-S911B · 360 × 780 CSS px · DPR 3 · 8 ГБ.</p>}
            </>}
            <More title="Предварительная проверка генерации"><ProfileGenerationPreview config={draft} disabled={busy} /></More>
            <More title="Как выбирается источник"><p className="text-sm text-muted-foreground">В режиме «Авто» при ошибке MobileProxy используется локальный генератор. В режиме «Только MobileProxy» ошибка останавливает попытку. Язык и часовой пояс MobileProxy берутся из ответа провайдера. Координаты и оператор этим не подтверждаются.</p></More>
          </>}
          {section === "preparation" && <>
            {checkbox("warmupEnabled", "Прогрев включён")}
            <Field id="warmup-plan" title="План подготовки"><select id="warmup-plan" className={selectClass} value={draft.warmupPlanPreset || "standard"} onChange={e => change("warmupPlanPreset", e.target.value)}><option value="standard">Стандартная подготовка — 6 сессий, 3 сайта</option><option value="storage">Сохранение состояния — 1 сессия, 1 сайт</option><option value="revisit">Повторное посещение — 2 сессии, 1 сайт</option><option value="navigation">Мобильная навигация — 2 сессии, 2 сайта</option></select></Field>
            <div className="rounded-lg border bg-muted/20 p-4 text-sm" aria-label="Описание выбранного плана"><p className="font-medium">{plan.offsetsHours.length} сессий · минимум {plan.minAgeHours} ч.</p><p className="mt-2 text-muted-foreground">{plan.offsetsHours.map((offset: number, index: number) => index === 0 ? "Начало" : `+${Number(offset.toFixed(1))} ч.`).join(" → ")}</p><p className="mt-2 field-help">Начатые планы сохраняются. Каждый план включает проверку сохранения после перезапуска. Очередь, разрешённые часы и проверки готовности могут увеличить срок.</p></div>
            {numbers([["warmupConcurrency", "Потоков прогрева", 1]])}
            <div className="space-y-3 rounded-lg border p-4"><h3 className="text-sm font-medium">Расписание прогрева</h3><p className="text-sm">{scheduleSummary} · {draft.warmupScheduleTimezone}</p><div className="flex flex-wrap gap-2">{([["all", "Круглосуточно"], ["day", "Днём · 08–20"], ["work", "Будни · 08–20"]] as [SchedulePreset, string][]).map(([id, title]) => <Button type="button" key={id} size="sm" variant={draft.warmupScheduleHours === preset(id) ? "default" : "outline"} onClick={() => change("warmupScheduleHours", preset(id))}>{title}</Button>)}</div><More title="Изменить дни, часы и часовой пояс"><ProjectSchedule scope="warmup" hours={draft.warmupScheduleHours} timezone={draft.warmupScheduleTimezone} onHours={value => change("warmupScheduleHours", value)} onTimezone={value => change("warmupScheduleTimezone", value)} disabled={busy} /></More></div>
            <More title="Дополнительные параметры подготовки">{numbers([["warmupStageIntervalHours", "Интервал плана, часы", 1 / 60, 168], ["readinessFreshnessHours", "Срок актуальности проверки, часы", 1, 720]])}{checkbox("warmupSharedProxy", "Совместная работа на прокси")}<p className="field-help">Потоки ограничивают число одновременных сеансов. Ожидание между сессиями поток не занимает. После истечения актуальности нужна проверка готовности.</p></More>
          </>}
          {section === "reserve" && <>
            {checkbox("autoReplenishEnabled", "Автоматически пополнять запас")}
            <p className="field-help">{draft.autoReplenishEnabled ? "Новые профили создаются автоматически при нехватке готового запаса." : "Автопополнение выключено. Можно создавать партии вручную."}</p>
            {numbers([["minReadyProfiles", "Готовых профилей в запасе", 1, 10000], ["replenishBatchSize", "Создавать за один раз", 1, 1000]])}
            <More title="Потребность и ограничения очереди">{numbers([["dailyProfileDemand", "Потребность в сутки", 0, 10000], ["maxPendingProfiles", "Лимит автоматической очереди", 100, 10000]])}<p className="field-help">Рекомендуется в подготовке: {pipeline} профилей — потребность за срок плана + 25% на повторы. При потребности 0 поддерживается только готовый запас. Ручные партии не ограничиваются лимитом автоматической очереди.</p>{pipeline > draft.maxPendingProfiles && <p className="text-sm text-amber-300">Лимит очереди меньше расчётной потребности.</p>}</More>
          </>}
          {section === "integrations" && <>
            <div className="rounded-lg border p-4 text-sm"><h3 className="font-medium">MobileProxy</h3><p className="mt-2 text-muted-foreground">{draft.mobileProxyConfigured ? "API-токен настроен" : "API-токен не настроен"}. Используется при выборе источника «Авто» или «Только MobileProxy».</p></div>
            <Field id="fp-current-key" title="Подключённый API-токен"><div className="flex min-w-0 flex-wrap gap-2"><Input className="min-w-0 flex-1" id="fp-current-key" type={revealed ? "text" : "password"} readOnly autoComplete="off" value={revealed ? currentKey || "" : draft.mobileProxyConfigured ? "••••••••••••••••" : ""} placeholder="Ключ не настроен" /><Button type="button" variant="outline" disabled={busy || !draft.mobileProxyConfigured} onClick={() => void revealKey()}>{revealed ? "Скрыть токен" : "Показать токен"}</Button></div></Field>
            <Field id="fp-api-key" title="Заменить API-токен MobileProxy"><Input id="fp-api-key" type="password" autoComplete="new-password" placeholder="Оставьте пустым, чтобы не менять" value={key} onChange={e => { setKey(e.target.value); setMessage(""); }} maxLength={500} /></Field>
            <p className="field-help">Токен сохраняется общей кнопкой внизу. Он не сохраняется в черновики на диске или в хранилище браузера.</p>
          </>}
        </fieldset>
      </section>
    </div>
    <div className={`${dirty || busy ? "sticky bottom-3 z-20 shadow-lg" : ""} rounded-lg border bg-background p-3`} aria-label="Сохранение настроек профилей">
      {conflict && <p role="alert" className="mb-3 text-sm text-amber-300">Настройки изменены после открытия формы. Черновик сохранён в этой вкладке. Нажмите «Загрузить актуальные», чтобы заменить его текущими настройками.</p>}
      {error && <p role="alert" className="mb-3 break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-sm">{busy ? "Сохранение…" : dirty ? "Есть несохранённые изменения" : message || "Все изменения сохранены"}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || !dirty} onClick={reset}>{conflict ? "Загрузить актуальные" : "Отменить"}</Button><Button type="submit" disabled={busy || !dirty || conflict}>Сохранить настройки</Button></div></div>
    </div>
  </form>;
}
