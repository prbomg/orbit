"use client";
import DEVICE_CATALOG from "@/utils/device-catalog.json";

type Passport = { deviceTemplate?:{id:string;revision:number;catalogVersion:string}; requestedSource?:string;generation?:{version:string;deviceSet:string;adapter:string;distribution?:{revision:number;fixedTemplateId:string|null}};validation?:{status:string;errors:string[];warnings:string[]}; source: string; resolved: boolean; fallbackReason?: string; timezone?: string; limitations?: string[]; providerAudioHash?: string; fingerprint: { navigator: { userAgent: string; hardwareConcurrency: number; deviceMemory?: number; userAgentData?: { model?: string; platformVersion?:string; uaFullVersion?:string; architecture?:string; bitness?:string } }; screen: { width: number; height: number; devicePixelRatio: number }; videoCard: { vendor: string; renderer: string }; fonts?: string[] } };
type BatterySnapshot = { level?: number; charging?: boolean; supported?: boolean; observedAt?: string };
type MotionSnapshot = { mode: string; scenario?: string; state: string; checkedAt?: string; updateHz?: number; touchCoupled?: boolean; updateIntervalMs?: { min: number; max: number } };
type Comparison = {basis:string;rows:{key:string;label:string;declared:unknown;observed:unknown;status:string}[];unverified:string[]};
const display=(value:unknown)=>value===null||value===undefined?'—':value===''?'Пустая строка':typeof value==='boolean'?(value?'Да':'Нет'):typeof value==='object'?JSON.stringify(value):String(value);
type Check = {comparison?:Comparison; status: string; checkedAt: string; audioHash: string | null; canvasHash: string; warnings: string[]; checks: Record<string, boolean>; dynamic?: { battery?: BatterySnapshot; motion?: MotionSnapshot }; observed: { availableFonts: string[]; battery?: BatterySnapshot | null } };
export type FingerprintInfo = { fingerprint?: Passport | null; fingerprintHash?: string | null; fingerprintState?: string; fingerprintCheck?: Check | null };

export function FingerprintDetails({ profile }: { profile: FingerprintInfo }) {
  const p = profile.fingerprint, c = profile.fingerprintCheck;
  if (!p) return <div className="rounded-lg border p-4 text-sm text-muted-foreground">Отпечаток будет подготовлен при следующем запуске. Существующая сессия сохранит свои параметры.</div>;
  const f = p.fingerprint;
  const template=p.deviceTemplate?.catalogVersion===DEVICE_CATALOG.version?DEVICE_CATALOG.templates.find(t=>t.id===p.deviceTemplate?.id&&t.revision===p.deviceTemplate?.revision):undefined;
  const incompatibleArchitecture = Boolean(f.navigator.userAgentData?.architecture) || (p.generation?.version==='5' ? f.navigator.userAgentData?.bitness!=='64' : Boolean(f.navigator.userAgentData?.bitness));
  const compatibilityWarnings = [...new Set([...(p.validation?.warnings||[]), ...(/Android/.test(f.navigator.userAgent)&&!/Chrome\/\d+\.0\.0\.0 /.test(f.navigator.userAgent)?['android_ua_reduction']:[]), ...(incompatibleArchitecture?['android_client_hint_architecture']:[])])];
  const battery = c?.dynamic?.battery || c?.observed.battery;
  const motion = c?.dynamic?.motion;
  return <section className="space-y-3 rounded-lg border p-4 text-sm">
    <h3 className="font-medium">Паспорт устройства</h3>
    <p>Источник: {p.source === "mobileproxy" ? "MobileProxy" : p.source === "legacy" ? "Прежний профиль" : "Локальный генератор"}{!p.resolved ? " · выбор источника при первом прогреве" : ""}</p>
    <p>Настройка источника: {p.requestedSource==='auto'?'Автоматически':p.requestedSource==='mobileproxy'?'MobileProxy':p.requestedSource==='local'?'Локальный генератор':'Прежний профиль'}</p>
    {p.generation&&<p className="text-xs text-muted-foreground">Поколение генератора: {p.generation.version} · набор устройств: {p.generation.deviceSet}</p>}
    {p.generation?.distribution&&<p className="text-xs text-muted-foreground">Распределение при создании: версия {p.generation.distribution.revision} · {p.generation.distribution.fixedTemplateId?"фиксированный шаблон":"выбор по сохранённым весам"}</p>}
    {p.validation&&<p>Проверка паспорта до прогрева: {p.validation.status==='passed'?'пройдена':'обнаружены несовместимые параметры'}</p>}
    {p.validation?.errors.map(code=><p className="text-destructive" key={code}>{({device_template_missing:'Шаблон устройства не найден.',device_template_version:'Версия шаблона не согласована с каталогом.',device_template_identity:'Модель или Android не соответствуют шаблону.',device_template_gpu:'GPU не соответствует шаблону.',device_model_gpu:'GPU не согласован с моделью.',device_template_screen:'Экран не соответствует шаблону.',device_template_hardware:'Память, CPU или касания не соответствуют шаблону.',device_distribution_invalid:'Некорректное распределение моделей.',device_distribution_selection:'Выбранная модель не соответствует сохранённому распределению.',android_device_memory:'Некорректная браузерная оценка памяти.',android_device_identity:'Не указаны корректная модель и версия Android.',android_header_platform:'Платформа HTTP-заголовков не совпадает с паспортом.',android_header_brands:'Версии в HTTP Client Hints не согласованы.',android_platform:'Платформа браузера не соответствует Android.',passport_user_agent:'Параметры браузера и HTTP-заголовки не совпадают.',passport_language:'Язык паспорта не согласован со списком языков.',passport_screen:'Некорректные размеры экрана.',passport_cpu:'Некорректные параметры CPU.',passport_touch:'Некорректные параметры сенсорного экрана.',passport_gpu:'В паспорте отсутствуют параметры GPU.',passport_timezone:'Некорректный часовой пояс.',passport_client_hints:'Параметры Client Hints не согласованы с платформой.'} as Record<string,string>)[code]||'Паспорт требует проверки.'}</p>)}
    {p.fallbackReason && <p className="text-amber-300">Использован локальный генератор. Причина: {({mobileproxy_proxy_not_found:'прокси не найден в аккаунте провайдера',mobileproxy_cooldown:'провайдер временно на паузе',mobileproxy_http_429:'провайдер ограничил частоту запросов',mobileproxy_key_missing:'не задан ключ провайдера',mobileproxy_rejected:'провайдер отклонил запрос'} as Record<string,string>)[p.fallbackReason]||'провайдер недоступен или ответил некорректно'}.</p>}
    {template&&<div className="space-y-2 rounded-md border p-3"><p>Шаблон: {template.name} · Android {template.os} · ревизия {template.revision}</p><p>Матрица по каталогу: {template.physicalScreen.width} × {template.physicalScreen.height} px · режим отрисовки: {template.renderScreen.width} × {template.renderScreen.height} px</p><p>RAM выбранного варианта: {template.physicalMemoryGb} ГБ · браузерная оценка: {template.browser.memory} ГБ</p><p className="text-xs text-muted-foreground">{template.evidence.note}</p><p className="text-xs">Проверка сведений: {template.evidence.reviewedAt} · измерение физического устройства: {template.evidence.measuredAt||'не проводилось'}</p>{template.evidence.sources.map(source=><a key={source.url} className="block text-xs text-primary underline" href={source.url} target="_blank" rel="noreferrer">{source.scope}</a>)}</div>}
    <h4 className="font-medium">Постоянные параметры</h4>
    <p>Модель: {f.navigator.userAgentData?.model || "не указана"}</p>
    <p>Android: {f.navigator.userAgentData?.platformVersion||"не указан"} · версия браузера в паспорте: {f.navigator.userAgentData?.uaFullVersion||"не указана"}</p>
    {compatibilityWarnings.filter(code=>code.startsWith('android_')).map(code=><p className="text-amber-300" key={code}>{({android_ua_reduction:'Сохранённый профиль использует прежний формат User-Agent.',android_client_hint_architecture:'Сохранённый профиль передаёт архитектуру или разрядность, отличающиеся от стандартных Android Client Hints.',android_browser_version:'Версия браузера расходится с Client Hints.'} as Record<string,string>)[code]||code} Для изменения постоянных параметров требуется отдельная миграция сохранённой сессии.</p>)}
    <p>Экран: {f.screen.width} × {f.screen.height} · DPR {f.screen.devicePixelRatio}</p>
    <p>CPU: {f.navigator.hardwareConcurrency} потоков · оценка памяти браузером: {f.navigator.deviceMemory ?? "—"} ГБ</p>
    <p className="break-words">WebGL: {f.videoCard.vendor} / {f.videoCard.renderer}</p>
    <p>Часовой пояс: {p.timezone || "прежняя конфигурация"}</p>
    <p className="break-all text-xs text-muted-foreground">ID постоянных параметров: {profile.fingerprintHash}</p>
    <p>Проверка постоянных параметров: {c?.status === "passed" ? "параметры согласованы" : c?.status === "failed" ? "обнаружено расхождение" : "ожидает запуска браузера"}</p>
    {c && <>
      <p>Проверен: {new Date(c.checkedAt).toLocaleString("ru-RU")}</p>
      <p className="break-all text-xs">Аудио, измеренный хеш: {c.audioHash || "недоступен"}</p>
      <p className="break-all text-xs">Canvas, измеренный хеш: {c.canvasHash}</p>
      <p>Доступные шрифты из паспорта: {c.observed.availableFonts.join(", ") || "не обнаружены"}</p>
      {Object.entries(c.checks).filter(([name, ok]) => name !== "battery" && !ok).map(([name]) => <p className="text-destructive" key={name}>Расхождение: {name}</p>)}
      {c.warnings.filter(w => w !== "Battery API недоступен").map(w => <div key={w}><p className="text-amber-300">{w}</p><p className="text-xs text-muted-foreground">{w.includes('шрифт')?'Проверьте установленные шрифты перед использованием этого набора устройств.':w.includes('Версия браузера')?'Проверьте профиль после обновления браузера. Его постоянные параметры сохраняются.':w.includes('кодек')?'Для сценариев с видео и аудио нужна отдельная проверка воспроизведения.':'Ограничение отражено в паспорте качества.'}</p></div>)}
    </>}
    {c?.comparison&&<div className="space-y-3 border-t pt-3"><h4 className="font-medium">Заявлено / измерено в браузере</h4><p className="text-xs text-muted-foreground">Совпадение подтверждает применение эмуляции. Это не проверка физического смартфона. Время измерения: {new Date(c.checkedAt).toLocaleString('ru-RU')}.</p><div className="overflow-x-auto"><table className="w-full table-fixed text-left text-xs"><thead><tr><th className="p-2">Параметр</th><th className="p-2">Заявлено</th><th className="p-2">Измерено</th><th className="p-2">Результат</th></tr></thead><tbody>{c.comparison.rows.map(row=><tr key={row.key} className="border-t"><td className="break-words p-2">{row.label}</td><td className="break-all p-2">{display(row.declared)}</td><td className="break-all p-2">{display(row.observed)}</td><td className="break-words p-2">{({matched:'Совпадает',mismatch:'Расхождение',unavailable:'Нет измерения',unverified:'Без эталона'} as Record<string,string>)[row.status]||row.status}</td></tr>)}</tbody></table></div>{c.comparison.unverified.map(note=><p key={note} className="text-xs text-muted-foreground">{note}</p>)}</div>}
    {c&&!c.comparison&&<p className="text-xs text-muted-foreground">Таблица сравнения появится после следующей штатной проверки профиля.</p>}
    <div className="space-y-2 border-t pt-3">
      <h4 className="font-medium">Динамическое состояние</h4>
      {typeof battery?.level === "number"
        ? <><p>Батарея (эмуляция): {Math.round(battery.level * 100)}% · {battery.charging ? "заряжается" : "разряжается"}</p><p className="text-xs text-muted-foreground">Снимок последней проверки: {new Date(battery.observedAt || c!.checkedAt).toLocaleString("ru-RU")}</p></>
        : <p>Батарея: {battery?.supported === false ? "Battery API недоступен" : "состояние ещё не измерено"}</p>}
      <p className="text-xs text-muted-foreground">Заряд меняется по времени и сохраняет непрерывность между запусками. Это эмуляция, а не измерение реального устройства. Батарея не входит в ID отпечатка и не влияет на готовность профиля.</p>
      <div className="space-y-2 border-t pt-2">
        <p>Датчики движения: {motion?.state === "active" ? motion.touchCoupled ? "симуляция с реакцией на касания" : "эмуляция спокойного удержания телефона" : motion?.state === "unavailable" ? "эмуляция недоступна в браузере" : motion?.state === "disabled" ? "эмуляция выключена" : "ожидают следующего запуска"}</p>
        {motion?.state === "active" && <p className="text-xs text-muted-foreground">{motion.touchCoupled ? "Наклон и ускорение реагируют на касания и плавно затухают после жеста. " : "Показания спокойного удержания моделируются программно. "}{motion.updateIntervalMs && <>Заданный интервал обновления показаний — {motion.updateIntervalMs.min.toFixed(1)}–{motion.updateIntervalMs.max.toFixed(1)} мс. </>}Частоту событий определяет браузер. Данные не измерены на физическом устройстве.</p>}
        {motion?.checkedAt && <p className="text-xs text-muted-foreground">Состояние при последней проверке: {new Date(motion.checkedAt).toLocaleString("ru-RU")}</p>}
        <p className="text-xs text-muted-foreground">Показания моделируются заново для каждой сессии. Чтение датчиков разрешено в сессии профиля; HTTPS и политика доступа страницы продолжают действовать. Это эмуляция, а не показания физического устройства; в постоянный отпечаток и оценку готовности они не входят.</p>
      </div>
    </div>
    {p.limitations?.map(w => <p className="text-xs text-muted-foreground" key={w}>{w}</p>)}
  </section>;
}
