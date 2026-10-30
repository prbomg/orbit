"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { projectRequest as api } from "@/lib/projects";
import { sessionErrorMessage } from "@/lib/profile-readiness";

type Entry = { id: number; runId: string | null; createdAt: string; event: string; stage: number | null; attempt: number | null; proxyId: string | null; proxyLabel: string | null; details: { quality?: string; confirmedScrollPixels?: number; confirmedLinks?: number; operation?: string; phase?: string; result?: string; scrollTarget?: string; movedPixels?: number; plannedMs?: number; budgetMs?: number; navigationId?: number; responseScope?: string; responseDomain?: string; rowsCount?: number; writesCount?: number; failedWrites?: number; queueMs?: number; transactionMs?: number; maxQueueMs?: number; maxTransactionMs?: number; browserIp?:string; workerIp?:string; previousIp?:string; ipComparison?:string; routeComparison?:string; status?:number; domain?: string; reason?: string; nextStageAt?: string; retryAfter?: string; durationMs?: number; inputMethod?: string; pixels?: number; gestures?: number; cookiesCount?: number; originsCount?: number; localStorageEntriesCount?: number; indexedDBRecordsCount?: number } };
type History = { items: Entry[]; hasMore: boolean; nextCursor: number | null };
const labels: Record<string, string> = {
  warmup_visit_quality: "Проверка результата посещения", warmup_site_partial: "Посещение не выполнило требования плана", warmup_run_context: "Параметры запуска", warmup_run_finished: "Запуск завершён", warmup_storage_check: "Проверка сохранения после перезапуска",
  proxy_ip_check_retry:"Повторная проверка внешнего IP",proxy_ip_check_started:"Проверка внешнего IP браузера",proxy_ip_check_failed:"Не удалось определить IP браузера",proxy_ip_observed:"Внешний IP браузера определён",proxy_ip_matches_worker:"IP браузера совпадает с внешним IP сервера",proxy_ip_check_skipped:"Проверка IP отключена",
  warmup_wait: "Пауза завершена", warmup_link_clicked: "Внутренний переход подтверждён", warmup_link_skipped: "Внутренний переход не подтверждён",
  warmup_operation_started: "Операция началась", warmup_operation_completed: "Операция завершена", warmup_operation_failed: "Ошибка операции",
  warmup_duration: "Время работы с сайтами", warmup_history_read: "История посещений загружена", warmup_database_metrics: "Работа с базой данных",
  warmup_site_deferred: "Посещение отложено: сайт на паузе или занят", session_restored: "Восстановлена предыдущая сессия",
  proxy_tcp_verified: "TCP-пресет канала подтверждён", proxy_tcp_waiting: "Ожидание доставки TCP-пресета",
  motion_emulation_started: "Эмуляция датчиков движения включена", motion_emulation_unavailable: "Эмуляция датчиков движения недоступна",
  resumed: "Прогрев продолжен по сохранённому расписанию", verification_queued: "Назначена проверка готовности", plan_upgraded: "План продолжен по сценарию на 72 часа",
  history_started: "Журнал включён. Предыдущие запуски не записаны",
  queued: "Профиль поставлен в очередь", restart_queued: "Назначен новый прогрев с первого этапа", paused: "Прогрев приостановлен",
  profile_enabled: "Профиль включён", profile_disabled: "Профиль выключен", attempt_started: "Запуск этапа",
  profile_loaded: "Сохранённая сессия загружена", profile_generated: "Параметры нового профиля подготовлены",
  profile_browser_upgraded: "Версия Chromium профиля обновлена с сохранением сессии", profile_browser_bound: "Профиль привязан к установленной версии Chromium",
  proxy_rotation_started: "Началась смена IP", proxy_rotation_completed: "Запрос смены IP выполнен",
  proxy_rotation_waiting: "Ожидание подготовки общего прокси", proxy_rotation_shared: "Используется текущий IP общего прокси",
  fingerprint_verified: "Постоянные параметры проверены", warmup_site_started: "Началось посещение сайта",
  warmup_scroll: "Прокрутка страницы", warmup_site_completed: "Посещение сайта завершено", warmup_site_skipped: "Сайт пропущен, выбран следующий",
  warmup_session_check: "Восстановление сессии проверено", warmup_final_fingerprint: "Финальная проверка отпечатка пройдена",
  session_saved: "Сессия сохранена", stage_completed: "Этап завершён", next_stage_scheduled: "Следующий этап назначен",
  warmup_completed: "Все этапы пройдены, профиль готов", attempt_stopped: "Запуск остановлен",
  attempt_failed: "Попытки этапа исчерпаны", retry_scheduled: "Назначен повтор", attempt_interrupted: "Исполнитель прервался",
};
const siteReasons: Record<string, string> = { navigation_timeout: "Операция на странице не завершилась вовремя", site_network: "Ошибка подключения к сайту", site_navigation: "Не удалось завершить переход", warmup_site_http: "Сайт вернул ошибку HTTP" };
const skippedReasons: Record<string, string> = {
  requirements_met: "Требования плана выполнены.", short_page: "Короткая страница доступна целиком; прокрутка не требуется.", content_unavailable: "Содержимое страницы не подтверждено.", interaction_not_confirmed: "Нет подтверждённой прокрутки или перехода.", navigation_not_confirmed: "Обязательный внутренний переход не подтверждён.", return_not_confirmed: "Возвращение на ранее посещённый сайт не подтверждено.",
  no_confirmed_transition: "Подходящая ссылка не найдена или изменение страницы не подтверждено.",
  no_eligible_link: "Подходящая внутренняя ссылка не найдена.", boundary: "Достигнута граница прокрутки.",
  no_clear_scroll_point: "Не найдена свободная область для жеста.", target_unavailable: "Элемент больше недоступен.",
  site_cooldown_or_busy: "Сайт временно занят или ожидает окончания паузы.",
};
const date = (value: string) => new Date(value).toLocaleString("ru-RU");

const operations: Record<string, string> = {
  content_check: "Проверка содержимого", prepare: "Подготовка", navigation: "Загрузка страницы", navigation_guard: "Проверка переходов",
  navigation_cleanup: "Завершение переходов", navigation_reset: "Восстановление страницы",
  active_check: "Проверка состояния задания", page_check: "Проверка страницы", scroll: "Прокрутка",
  internal_link: "Внутренняя ссылка", site_save: "Сохранение результата", site_reservation: "Ожидание доступа к сайту",
};
const results: Record<string, string> = {
  scrolled: "Содержимое сдвинулось", blocked: "Содержимое не сдвинулось", boundary: "Достигнута граница прокрутки",
  url_changed: "Открыт новый адрес", content_changed: "Изменилось основное содержимое", no_change: "Изменение страницы не подтверждено",
};
const phases: Record<string, string> = { initial: "Первый экран", after_scroll: "После прокрутки", after_link: "После перехода", reading: "Чтение" };
const seconds = (ms: number) => `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с`;
export function WarmupEventDetails({ details: d }: { details: Entry["details"] }) {
  return <>
    {d.quality&&<p>{d.quality==='passed'?'Требования выполнены':'Требования выполнены частично'} · подтверждённых переходов: {d.confirmedLinks??0} · прокрутка: {d.confirmedScrollPixels??0} px</p>}
    {d.operation && <p>Операция: {operations[d.operation] || d.operation}</p>}
    {d.domain && <p className="break-all">Сайт: {d.domain}</p>}
    {d.status !== undefined && <p className="break-all">HTTP {d.status}{d.responseScope === "document" ? " · текущий документ" : d.responseScope === "navigation" ? " · ответ перехода, документ не подтверждён" : ""}{d.navigationId ? ` · переход №${d.navigationId}` : ""}{d.responseDomain ? ` · ${d.responseDomain}` : ""}</p>}
    {d.responseScope === "unknown" && <p className="text-muted-foreground">HTTP-ответ для текущего перехода не получен</p>}
    {d.inputMethod && <p>{d.inputMethod === "touch" ? "Сенсорный свайп" : d.inputMethod === "wheel" ? "Прокрутка колёсиком" : "Жест не выполнен"}{d.gestures !== undefined ? ` · жестов: ${d.gestures}` : ""}</p>}
    {d.pixels !== undefined && <p>Запрошено: {Math.abs(d.pixels)} px {d.pixels >= 0 ? "вниз" : "вверх"}{d.movedPixels !== undefined ? ` · смещение: ${d.movedPixels} px` : ""}{d.scrollTarget ? ` · ${d.scrollTarget === "container" ? "вложенная область" : d.scrollTarget === "page" ? "страница" : "область не выбрана"}` : ""}</p>}
    {d.result && <p>{results[d.result] || d.result}</p>}
    {d.phase && <p>Пауза: {phases[d.phase] || d.phase}</p>}
    {d.durationMs !== undefined && <p>Фактически: {seconds(d.durationMs)}{d.plannedMs !== undefined ? ` · по плану: ${seconds(d.plannedMs)}` : ""}</p>}
    {d.budgetMs !== undefined && <p>Предел времени: {seconds(d.budgetMs)}</p>}
    {d.rowsCount !== undefined && <p>Записей истории: {d.rowsCount}</p>}
    {d.writesCount !== undefined && <><p>Транзакций: {d.writesCount} · ошибок: {d.failedWrites ?? 0}</p><p>Очередь записи: {seconds(d.queueMs ?? 0)} · максимум: {seconds(d.maxQueueMs ?? 0)}</p><p>Транзакции: {seconds(d.transactionMs ?? 0)} · максимум: {seconds(d.maxTransactionMs ?? 0)}</p></>}
  </>;
}

export function ProfileWarmupJournal({ profileId }: { profileId: string }) {
  const latest = useRef(0);
  const [filter, setFilter] = useState('all');
  const [entries, setEntries] = useState<Entry[]>([]), [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false, initial = true, inFlight = false;
    latest.current = 0; setEntries([]); setLoading(true); setError(""); setHasMore(false);
    async function load() {
      if (document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      try {
        let result = await api<History>(`/api/profiles/${profileId}/history/${latest.current ? `?after=${latest.current}&limit=100` : ''}`);
        const items = [...result.items];
        if (latest.current) while (result.hasMore && result.items.length) {
          result = await api<History>(`/api/profiles/${profileId}/history/?after=${result.items.at(-1)!.id}&limit=100`);
          items.push(...result.items);
        }
        latest.current = Math.max(latest.current, ...items.map(e => e.id));
        if (disposed) return;
        setEntries(previous => [...new Map([...previous, ...items].map(entry => [entry.id, entry])).values()].sort((a, b) => b.id - a.id));
        if (initial) setHasMore(result.hasMore);
        initial = false; setError(""); setLoading(false);
      } catch (cause) { if (!disposed) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить журнал"); setLoading(false); } }
      finally { inFlight = false; }
    }
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [profileId]);
  async function older() {
    const cursor = entries.at(-1)?.id; if (!cursor) return;
    setBusy(true);
    try {
      const result = await api<History>(`/api/profiles/${profileId}/history/?before=${cursor}`);
      setEntries(previous => [...new Map([...previous, ...result.items].map(entry => [entry.id, entry])).values()].sort((a, b) => b.id - a.id));
      setHasMore(result.hasMore); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить предыдущие события"); }
    finally { setBusy(false); }
  }
  const grouped = [...entries.reduce((map, entry) => { const key = entry.runId || `event-${entry.id}`; const rows = map.get(key) || []; rows.push(entry); map.set(key, rows); return map; }, new Map<string, Entry[]>()).values()].filter(group => filter === 'all' || filter === 'issues' && group.some(e => e.details.reason) || filter === 'sessions' && group.some(e => e.runId));
  function exportJournal() {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `profile-${profileId}-journal.json`; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="rounded-lg border p-4 text-sm" aria-label="Журнал прогрева">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">Журнал запусков</h3><Button size="sm" variant="outline" disabled={!entries.length} onClick={exportJournal}>Экспорт загруженных событий</Button></div>
    <p className="mt-1 text-xs text-muted-foreground">События сгруппированы по запуску. Последние сверху, обновление автоматически.</p>
    <select aria-label="Фильтр журнала" className="mt-3 h-9 rounded-md border bg-background px-2" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Все события</option><option value="sessions">Запуски сессий</option><option value="issues">С ошибками и повторами</option></select>
    {error && <p role="alert" className="mt-3 text-destructive">{error}</p>}
    {loading ? <p className="mt-3">Загрузка…</p> : !grouped.length ? <p className="mt-3 text-muted-foreground">Событий по выбранному фильтру нет.</p> : <ol className="mt-4 space-y-3">{grouped.map(group => {
      const first = group.at(-1)!, last = group.find(e => !['warmup_database_metrics', 'warmup_duration', 'warmup_run_finished', 'warmup_run_context'].includes(e.event)) || group[0], saved = group.find(e => e.event === 'session_saved'), domains = [...new Set(group.filter(e => e.event === 'warmup_site_completed').map(e => e.details.domain))], duration = saved?.details.durationMs, observed=group.find(entry=>entry.event==='proxy_ip_observed'&&entry.details.browserIp);
      return <li className="rounded-lg border p-3" key={first.runId || first.id}>
        <p className="font-medium">{first.runId ? `Сессия ${first.stage ?? '—'} · попытка ${first.attempt ?? '—'}` : labels[first.event] || first.event}</p>
        <p className="mt-1 text-xs text-muted-foreground">{date(first.createdAt)}{duration !== undefined ? ` · длительность ${Math.round(duration / 1000)} сек.` : first.runId ? ' · запуск ещё не завершён или длительность не записана' : ''}</p>
        {first.proxyLabel && <p className="mt-1 text-xs">Прокси: {first.proxyLabel}</p>}{observed && <p className="mt-1 break-all font-mono text-xs text-primary">IP браузера: {observed.details.browserIp}{observed.details.workerIp?` · Внешний IP сервера: ${observed.details.workerIp}`:""}</p>}
        {domains.length > 0 && <p className="mt-2 break-words text-xs">Посещены: {domains.join(', ')}</p>}
        {saved && <p className="mt-1 text-xs text-primary">Сессия сохранена · cookies {saved.details.cookiesCount ?? 0} · сайты с данными {saved.details.originsCount ?? 0}</p>}
        {first.runId && <p className="mt-1 text-xs">{labels[last.event] || last.event}</p>}
        {last.details.reason && <p className="mt-1 text-xs text-amber-300">{sessionErrorMessage(last.details.reason)}</p>}
        <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">События запуска ({group.length})</summary><ol className="mt-2 space-y-2">{[...group].reverse().map(entry => <li className="border-l pl-3 text-xs" key={entry.id}><p>{labels[entry.event] || entry.event} · {date(entry.createdAt)}</p>{entry.details.browserIp&&<p className="break-all font-mono">IP браузера: {entry.details.browserIp}{entry.details.previousIp?` · предыдущий: ${entry.details.previousIp}`:""}</p>}{entry.details.routeComparison==="matches_worker"&&<p className="text-amber-300">IP совпадает с адресом исполнителя: требуется проверить маршрут.</p>}<WarmupEventDetails details={entry.details} />{entry.details.reason && <p className={skippedReasons[entry.details.reason] ? "text-muted-foreground" : "text-amber-300"}>{skippedReasons[entry.details.reason] || (entry.event === 'warmup_site_skipped' ? siteReasons[entry.details.reason] || entry.details.reason : sessionErrorMessage(entry.details.reason))}</p>}{entry.details.nextStageAt && <p>Следующий запуск: {date(entry.details.nextStageAt)}</p>}{entry.details.retryAfter && <p>Повтор не раньше: {date(entry.details.retryAfter)}</p>}</li>)}</ol></details>
      </li>;
    })}</ol>}
    {hasMore && <Button type="button" className="mt-4" size="sm" variant="outline" disabled={busy} onClick={() => void older()}>{busy ? 'Загрузка…' : 'Предыдущие события'}</Button>}
  </section>;
}
