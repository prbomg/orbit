"use client";
import { useState, type KeyboardEvent } from "react";
import { Activity, Archive, Settings2, ShieldCheck } from "lucide-react";
import { CaptchaPolicySettings } from "@/components/captcha-policy-settings";
import { IntegrationSettings } from "@/components/integration-settings";
import { ServiceStatus } from "@/components/service-status";
import { ResourceUsagePanel } from "@/components/resource-usage";
import { ServiceBackupsPanel } from "@/components/service-backups";
import { ReleaseManagerPanel } from "@/components/release-manager";
import { useData } from "@/lib/data-store";
const sections = [{ id: "integrations", name: "Интеграции", icon: ShieldCheck }, { id: "monitoring", name: "Мониторинг", icon: Activity }, { id: "backups", name: "Резервные копии", icon: Archive }, { id: "maintenance", name: "Обслуживание", icon: Settings2 }] as const;
type Section = typeof sections[number]["id"];
export default function SettingsPage() {
  const { system } = useData();
  const [tab, setTab] = useState<Section>("integrations");
  const [visited, setVisited] = useState<Set<Section>>(new Set(["integrations"]));
  const [primary, setPrimary] = useState("rucaptcha");
  function select(id: Section) { setTab(id); setVisited(previous => new Set([...previous, id])); }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
    if (next === null) return; event.preventDefault(); select(sections[next].id); document.getElementById(`settings-tab-${sections[next].id}`)?.focus();
  }
  const providers = primary === "capguru" ? ["capguru", "rucaptcha"] as const : ["rucaptcha", "capguru"] as const;
  return <>
    <div className="page-heading"><div><div className="eyebrow">ВАШЕ ПРОСТРАНСТВО</div><h1>Настройки<span className="heading-dot">.</span></h1><p>Подключения сервисов, мониторинг и обслуживание Orbit.</p></div></div>
    <div className="settings-tabs settings-backup-tabs" role="tablist" aria-label="Разделы настроек">{sections.map(({ id, name, icon: Icon }, index) => <button key={id} id={`settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`settings-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => select(id)} onKeyDown={event => navigate(event, index)}><Icon size={17} aria-hidden="true" /><span>{name}</span></button>)}</div>
    <div id="settings-panel-integrations" role="tabpanel" aria-labelledby="settings-tab-integrations" hidden={tab !== "integrations"}>
      <section className="panel captcha-settings-block"><div className="panel-heading"><div><h2>Сервисы капчи</h2><p>Приоритет распознавания, API-ключи и балансы</p></div><ShieldCheck className="text-primary" size={23} aria-hidden="true" /></div>
        <CaptchaPolicySettings onPrimaryChange={setPrimary} embedded />
        <div className="captcha-provider-grid">{providers.map((kind, index) => <IntegrationSettings key={kind} kind={kind} roleLabel={index === 0 ? "Основной" : "Запасной"} />)}</div>
      </section>
    </div>
    <div id="settings-panel-monitoring" role="tabpanel" aria-labelledby="settings-tab-monitoring" hidden={tab !== "monitoring"}>{visited.has("monitoring") && <><ServiceStatus settingsContext /><ResourceUsagePanel /></>}</div>
    <div id="settings-panel-backups" role="tabpanel" aria-labelledby="settings-tab-backups" hidden={tab !== "backups"}>{visited.has("backups") && <ServiceBackupsPanel />}</div>
    <div id="settings-panel-maintenance" role="tabpanel" aria-labelledby="settings-tab-maintenance" hidden={tab !== "maintenance"}>{visited.has("maintenance") && <>
      <ReleaseManagerPanel />
      <details className="panel settings-admin"><summary>Для администратора<span>Параметры запуска и команды</span></summary><div className="border-t p-5 sm:p-6"><p className="field-help mb-5">Текущие значения доступны для просмотра. Изменения окружения сервера применяются при перезапуске исполнителя.</p><dl className="grid gap-5 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Устройства</dt><dd className="mt-1">{system?.mobileDevices.join(" / ") ?? "Android / iOS"}</dd></div><div><dt className="text-muted-foreground">Браузер</dt><dd className="mt-1">Chromium · {system?.headless ? "без окна" : "с окном"}</dd></div>
        <div><dt className="text-muted-foreground">Прямое посещение</dt><dd className="mt-1">{system?.directVisitSeconds.join("–") ?? "60–120"} секунд</dd></div><div><dt className="text-muted-foreground">Поисковое посещение</dt><dd className="mt-1">{system?.searchVisitSeconds.join("–") ?? "60–300"} секунд</dd></div>
        <div><dt className="text-muted-foreground">Прокси</dt><dd className="mt-1">{system?.proxyScheme.toUpperCase() ?? "HTTP"}</dd></div><div><dt className="text-muted-foreground">Пауза после смены IP</dt><dd className="mt-1">{system?.rotationWaitSeconds ?? 15} секунд</dd></div>
      </dl><details className="mt-6 border-t pt-4"><summary className="cursor-pointer text-sm">Команды ручного запуска</summary><p className="field-help mt-3">Запуск из папки приложения:</p><code className="mt-2 block rounded-md bg-background p-3 text-sm">pnpm worker</code><p className="field-help mt-3">Одна попытка: <code>pnpm worker:once</code>. Запуском проектов можно управлять в разделе «Проекты».</p></details></div></details>
    </>}</div>
  </>;
}
