"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Event = { time: string; event: string; url?: string; tab?: number; status?: number; action?: string; method?: string; source?: string; element?: string; sourceType?: string; captureState?: string; capturedResponses?: number; width?: number; height?: number; step?: number; attempt?: number; total?: number; durationMs?: number; errorType?: string; code?: string; pagesVisited?: number; page?: number; organicResults?: number; linksFollowed?: number };
type Snapshot = { task: { status: string; currentExecutions: number; targetExecutions: number }; run: { state: string; active: boolean; currentTaskId: string | null; updatedAt: string | null }; events: Event[]; imageVersion: number | null };
const names: Record<string, string> = {
  captcha_image_ready: "Изображение подготовлено",
  captcha_image_capture_failed: "Не удалось подготовить изображение",
  captcha_retrying: "Повторная попытка решения капчи",
  captcha_coordinate_applied: "Нажатие по координатам RuCaptcha выполнено",
  navigation: "Переход", navigation_response: "Ответ сайта", plan_ready: "План действий готов", proxy_rotation_started: "Смена IP началась", proxy_rotation_completed: "IP сменён",
  session_started: "Сессия началась", session_completed: "Выполнение сохранено", session_failed: "Ошибка сессии", session_search_missed: "Сайт не найден", session_wait: "Ожидание на странице",
  action_started: "Действие началось", action_completed: "Действие выполнено", action_skipped: "Действие пропущено", action_failed: "Ошибка действия",
  profile_saved: "Профиль сохранён", search_started: "Поиск начался", search_home_opening: "Открытие поисковика", search_home_failed: "Поисковик не открылся", search_query_entered: "Запрос введён", search_submit_started: "Отправка поиска началась", search_submit_completed: "Кнопка поиска нажата", search_page_scanned: "Страница выдачи проверена", search_vital_refinement: "Запрос уточнён", search_target_clicked: "Переход на целевой сайт", search_target_not_found: "Целевой сайт не найден", target_visit_started: "Посещение сайта началось", target_internal_link: "Переход внутри сайта", target_visit_finished: "Посещение сайта завершено", visit_scroll: "Прокрутка страницы", proxy_rotation_wait: "Ожидание смены IP", captcha_checkbox_clicked: "Чекбокс проверки нажат", captcha_widget_wait: "Ожидание задания капчи", captcha_manual_required: "Нужно вручную пройти проверку в окне браузера", captcha_manual_completed: "Ручная проверка завершена", captcha_detected: "Капча обнаружена", captcha_requested: "Запрос в RuCaptcha отправлен", captcha_token_received: "Ответ RuCaptcha получен", captcha_token_applied: "Ответ применён", captcha_coordinates_received: "Координаты RuCaptcha получены", captcha_coordinates_applied: "Координаты нажаты", captcha_submitting: "Форма капчи отправляется", captcha_submitted: "Капча отправлена", captcha_failed: "Ошибка обработки капчи", captcha_unrecognized: "Параметры капчи недоступны",
};
const actionNames: Record<string, string> = { scroll_down: "Прокрутка вниз", scroll_up: "Прокрутка вверх", pause: "Пауза", move_mouse_randomly: "Движение мыши", click_random_link: "Клик по ссылке" };
const errorNames: Record<string, string> = { ProxyCheckError: "Прокси не смог открыть сайт", ProxyRotationError: "Не удалось сменить IP", SearchError: "Ошибка поиска", TaskStoppedError: "Задача остановлена", CaptchaError: "Ошибка обработки капчи", ProfileError: "Ошибка профиля" };
const codeNames: Record<string, string> = { canvas_snapshot: "не удалось получить снимок canvas в исходном размере", profile_storage_failed: "не удалось получить cookies и хранилище браузера", profile_state_invalid: "данные браузера не прошли проверку профиля", profile_permission_denied: "нет прав на запись папки профилей", profile_disk_full: "недостаточно места для сохранения профиля", profile_write_failed: "не удалось записать файл профиля", profile_generation_failed: "не удалось подобрать корректный мобильный профиль", browser_image_decode: "браузер не смог декодировать изображение", image_source_read: "источник изображения недоступен", original_response_missing: "исходный ответ изображения не найден", original_response_type: "сервер вернул неподдерживаемый формат", original_response_body: "не удалось прочитать исходные байты изображения", original_image_decode: "не удалось обработать байты изображения", submission_rejected: "Яндекс вернул страницу проверки после отправки", ERROR_ZERO_BALANCE: "на счёте RuCaptcha недостаточно средств", ERROR_WRONG_USER_KEY: "неверный формат ключа RuCaptcha", ERROR_KEY_DOES_NOT_EXIST: "ключ RuCaptcha не найден", missing_api_key: "ключ RuCaptcha не задан", widget_not_detected: "параметры виджета не найдены", sitekey_missing: "sitekey не найден", search_home_timeout: "поисковик не открылся через прокси", ERROR_CAPTCHA_UNSOLVABLE: "RuCaptcha не смогла распознать задание", solve_limit: "лимит попыток решения капчи исчерпан", image_capture_failed: "не удалось получить изображение в исходном разрешении", captcha_reload_failed: "не удалось обновить страницу проверки" };
const eventLabel = (event: Event) => {
  if (event.event === "captcha_image_ready" || event.event === "captcha_image_capture_failed") {
    const image = event.source === "instruction" ? "Инструкция" : "Основная картинка";
    return event.event === "captcha_image_ready" ? `${image} получена · ${event.width}×${event.height}` : `${image}: ошибка получения`;
  }
  if (event.event === "captcha_retrying") return `Повторная попытка решения капчи ${event.attempt ?? ""}${event.total ? `/${event.total}` : ""}`;
  if (event.event === "captcha_coordinate_applied") return `Нажатие по координатам ${event.step ?? ""}${event.total ? `/${event.total}` : ""}`;
  if (event.event === "search_submit_started") return event.method === "button" ? "Нажатие кнопки «Найти»" : "Отправка через Enter";
  if (event.event === "search_submit_completed") return event.method === "button" ? "Кнопка «Найти» нажата" : "Enter нажат";
  return names[event.event] ?? event.event;
};
const time = (value: string) => new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const captureDetails = (event: Event) => event.event === "captcha_image_capture_failed" && event.capturedResponses !== undefined
  ? `Элемент: ${event.element} · источник: ${event.sourceType === "none" ? "без URL" : event.sourceType} · сохранено ответов: ${event.capturedResponses} · захват ${event.captureState === "active" ? "включён" : "выключен"}` : null;

export function LiveTaskView({ taskId, projectId, projectName, targetUrl }: { taskId: string; projectId: string; projectName: string; targetUrl: string }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/tasks/${taskId}/live/`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Не удалось получить состояние задачи");
        if (!cancelled) { setData(body); setError(""); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Ошибка обновления"); }
    };
    void update();
    const timer = window.setInterval(() => void update(), 2500);
    document.addEventListener("visibilitychange", update);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [taskId]);
  const latest = data?.events.at(-1);
  const lastFailure = [...(data?.events ?? [])].reverse().find(event => event.event === "session_failed");
  const isLive = Boolean(data?.run.active);
  const imageUrl = data?.imageVersion ? `/api/tasks/${taskId}/live/screenshot/?v=${data.imageVersion}` : null;
  return <div className="space-y-6">
    <div className="page-heading"><div><div className="eyebrow">НАБЛЮДЕНИЕ ЗА ЗАДАЧЕЙ</div><h1>Ход выполнения<span className="heading-dot">.</span></h1><p>{projectName} · {new URL(targetUrl).hostname}</p></div><Button asChild variant="outline"><Link href={`/projects/${projectId}/`}><ArrowLeft size={16} />К проекту</Link></Button></div>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4 text-sm">
      <Badge variant={isLive ? "default" : "outline"} className="gap-1.5"><Eye size={13} />{isLive ? "Сессия идёт" : data?.run.state === "waiting" ? "Ожидание следующей попытки" : data?.run.state === "running" ? "Другая задача или подготовка" : "Исполнитель остановлен"}</Badge>
      <span className="text-muted-foreground">Выполнено {data?.task.currentExecutions ?? "—"} из {data?.task.targetExecutions ?? "—"}</span>
      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><RefreshCw size={13} />Обновление каждые 2,5 секунды</span>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
      <section className="panel overflow-hidden"><div className="panel-heading"><h2>Экран браузера</h2><span className="muted-label">{imageUrl ? `${isLive ? "Текущий" : "Последний"} кадр · ${new Date(data!.imageVersion!).toLocaleTimeString("ru-RU")}` : "Нет кадра"}</span></div>
        {imageUrl ? <a href={imageUrl} target="_blank" rel="noopener noreferrer" className="block bg-black"><img src={imageUrl} alt="Снимок текущей страницы браузера" className="mx-auto max-h-[75vh] w-auto max-w-full object-contain" /><span className="flex items-center justify-center gap-1 p-2 text-xs text-white/70">Открыть кадр полностью <ExternalLink size={12} /></span></a> : <div className="flex min-h-80 items-center justify-center p-8 text-center text-sm text-muted-foreground">{lastFailure?.errorType === "ProxyCheckError" ? "Прокси не смог открыть сайт. Исполнитель ждёт следующей попытки; кадр появится после успешного соединения." : "Кадр появится, когда исполнитель откроет разрешённую страницу проекта или поисковика."}</div>}
        <p className="border-t p-3 text-xs text-muted-foreground">Это обновляемый снимок вкладки, а не видеотрансляция. После остановки показывается последний кадр текущего запуска.</p>
      </section>
      <section className="panel overflow-hidden"><div className="panel-heading"><h2>Переходы и действия</h2><span className="muted-label">{data?.events.length ?? 0} записей</span></div>
        <div className="max-h-[75vh] space-y-0 overflow-y-auto px-4 pb-4">{data?.events.length ? [...data.events].reverse().map((event, index) => <div key={`${event.time}-${index}`} className="border-b border-border/70 py-3 last:border-b-0"><div className="flex items-baseline justify-between gap-3"><strong className="text-sm">{eventLabel(event)}</strong><time className="shrink-0 font-mono text-xs text-muted-foreground">{time(event.time)}</time></div>{event.url && <p className="mt-1 break-all font-mono text-xs text-primary">{event.url}</p>}{event.action && <p className="mt-1 text-xs text-muted-foreground">{actionNames[event.action] ?? event.action}{event.step ? ` · ${event.step}${event.total ? `/${event.total}` : ""}` : ""}</p>}{event.status && <p className="mt-1 text-xs text-muted-foreground">HTTP {event.status}{event.tab ? ` · вкладка ${event.tab}` : ""}</p>}{event.page && <p className="mt-1 text-xs text-muted-foreground">Страница {event.page}{event.organicResults !== undefined ? ` · найдено ссылок: ${event.organicResults}` : ""}</p>}{event.durationMs && <p className="mt-1 text-xs text-muted-foreground">Пауза / длительность: {Math.round(event.durationMs / 1000)} с</p>}{event.linksFollowed && <p className="mt-1 text-xs text-muted-foreground">Внутренних переходов: {event.linksFollowed}</p>}{event.errorType && <p className="mt-1 text-xs text-destructive">{errorNames[event.errorType] ?? event.errorType}{event.code ? ` · ${codeNames[event.code] ?? event.code}` : ""}</p>}{!event.errorType && event.code && <p className="mt-1 text-xs text-amber-300">{codeNames[event.code] ?? event.code}</p>}{captureDetails(event) && <p className="mt-1 text-xs text-muted-foreground">{captureDetails(event)}</p>}{event.pagesVisited && <p className="mt-1 text-xs text-muted-foreground">Проверено страниц: {event.pagesVisited}</p>}</div>) : <p className="py-10 text-center text-sm text-muted-foreground">События появятся при следующем запуске задачи.</p>}</div>
      </section>
    </div>
    <p className="page-hint">Последнее событие: {latest ? `${eventLabel(latest)} в ${time(latest.time)}` : "пока нет"}. Для безопасности в адресах скрыты параметры URL и якоря.</p>
  </div>;
}
