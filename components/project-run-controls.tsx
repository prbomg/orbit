"use client";
import { resourceWait } from "@/lib/task-presentation";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useData } from "@/lib/data-store";
import { projectRequest } from "@/lib/projects";

type RunStatus = { nextCheckAt?: string | null; nextAt?: string | null; waitReason?: string | null; state: "stopped" | "busy" | "running" | "waiting" | "stopping" | "completed" | "failed"; visible?: boolean; taskId?: string | null; errorType?: string | null; errorCode?: string | null; providerCode?: string | null };
const labels: Record<RunStatus["state"], string> = {
  stopped: "Остановлен", busy: "Работает общий исполнитель из командной строки", running: "Выполняется", waiting: "Ожидание готовых профилей, прокси или повторной попытки", stopping: "Останавливается", completed: "Очередь проекта завершена", failed: "Процесс завершился с ошибкой",
};
const failureLabels: Record<string, string> = {
  http_401: "OpenAI отклонил API-ключ (401). Проверьте ключ в настройках.",
  http_403: "OpenAI запретил запрос (403). Проверьте доступ API-ключа и организации к модели gpt-4o-mini.",
  http_429: "OpenAI ограничил запросы или доступный баланс (429). Проверьте лимиты и оплату API.",
};
const providerFailureLabels: Record<string, string> = {
  credit_balance_exhausted: "Баланс OpenAI API исчерпан. Пополните баланс или проверьте платёжные настройки аккаунта.",
  insufficient_quota: "Квота OpenAI API исчерпана. Проверьте лимиты и оплату аккаунта.",
  billing_hard_limit_reached: "Достигнут лимит расходов OpenAI API. Увеличьте лимит в платёжных настройках.",
  rate_limit_exceeded: "Превышен лимит частоты запросов OpenAI. Повторите запуск позже.",
  slow_down: "OpenAI просит снизить частоту запросов. Повторите запуск позже.",
  organization_spend_limit_exceeded: "Достигнут лимит расходов организации OpenAI. Проверьте лимит организации.",
  project_spend_limit_exceeded: "Достигнут лимит расходов проекта OpenAI. Проверьте лимит проекта.",
  organization_usage_limit_exceeded: "Достигнут лимит использования OpenAI API для организации.",
  invalid_api_key: "OpenAI отклонил API-ключ. Замените его в настройках.",
  model_not_found: "Модель gpt-4o-mini недоступна для этого ключа или проекта OpenAI.",
  unsupported_country_region_territory: "OpenAI не разрешил запрос из текущего региона.",
  organization_verification_required: "OpenAI требует подтверждения организации для этого запроса.",
};
const providerFailureTitles: Record<string, string> = {
  credit_balance_exhausted: "Баланс OpenAI API исчерпан",
  insufficient_quota: "Квота OpenAI API исчерпана",
  billing_hard_limit_reached: "Достигнут лимит расходов OpenAI",
  rate_limit_exceeded: "Превышен лимит запросов OpenAI",
  slow_down: "OpenAI ограничил частоту запросов",
  organization_spend_limit_exceeded: "Лимит расходов организации исчерпан",
  project_spend_limit_exceeded: "Лимит расходов проекта исчерпан",
  organization_usage_limit_exceeded: "Лимит использования организации исчерпан",
  invalid_api_key: "API-ключ OpenAI отклонён",
  model_not_found: "Модель OpenAI недоступна",
  unsupported_country_region_territory: "Запрос запрещён из этого региона",
  organization_verification_required: "Нужно подтвердить организацию OpenAI",
};
const captchaFailureLabels: Record<string, string> = {
  checkbox_not_completed: "Чекбокс проверки Яндекса не отреагировал на два нажатия. Платный запрос не отправлен.",
  checkbox_navigation_timeout: "Переход после чекбокса проверки Яндекса не завершился за отведённое время. Платный запрос не отправлен.",
  ERROR_CAPTCHA_UNSOLVABLE: "Сервис капчи принял задание, но не смог его распознать. При следующем запуске воркер выполнит ограниченные автоматические повторы.",
  solve_limit: "Достигнут лимит пяти платных решений капчи за сессию. Задача повторяется с другим профилем и прокси; пять одинаковых ошибок подряд останавливают только эту задачу.",
  incorrect_limit: "Три некорректных решения капчи за сессию. Задача повторяется с другим профилем и прокси.",
  image_capture_failed: "Не удалось получить исходное изображение капчи. Запрос на распознавание не отправлен.",
  captcha_reload_failed: "Не удалось обновить страницу проверки для повторной попытки. Проверьте соединение через прокси.",
};

const searchFailureLabels: Record<string, string> = {
  search_home_timeout: "Страница поисковика не загрузилась за отведённое время.",
  search_input_not_found: "Не удалось найти доступное поле поиска после повторной попытки.",
  search_input_activation_timeout: "Не удалось открыть поле поиска после повторной попытки.",
  search_input_typing_timeout: "Поле поиска перестало принимать ввод.",
  search_submit_timeout: "Не удалось отправить поисковый запрос.",
  search_results_timeout: "Поисковая выдача не обновилась за отведённое время.",
  search_navigation_unstable: "Страница продолжает переходы; проверка интерфейса не завершена.",
  search_query_mismatch: "Поисковик изменил текст запроса после повторной отправки.",
  search_overlay_blocked: "Всплывающее окно мешает продолжению; закрыть его не удалось.",
};

export function ProjectRunControls({ projectId, projectName, iconOnly = false, showStatus = false }: { projectId: string; projectName?: string; iconOnly?: boolean; showStatus?: boolean }) {
  const { system, tasks } = useData();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setStatus(await projectRequest<RunStatus>(`/api/projects/${projectId}/run/`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось узнать состояние исполнителя"); }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function act(action: "start" | "stop", visible = false) {
    setPending(true); setError("");
    try { setStatus(await projectRequest<RunStatus>(`/api/projects/${projectId}/run/`, { method: "POST", body: JSON.stringify(action === "start" ? { action, visible } : { action }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось управлять исполнителем"); }
    finally { setPending(false); }
  }
  const active = status?.state === "running" || status?.state === "waiting" || status?.state === "stopping";
  const captchaFailure = status?.errorType === "CaptchaError" && status.state === "failed";
  const searchFailure = status?.errorType === "SearchError" && status.state === "failed";
  const openAiFailure = status?.errorType === "OpenAIPlanError" && status.state === "failed";
  const pastOpenAiError = openAiFailure && system?.planMode === "local";
  const httpCode = status?.errorCode?.match(/^http_(\d{3})$/)?.[1];
  const proxyFailure = status?.errorType === "ProxyCheckError" && status.state !== "running";
  const projectTasks = tasks.filter(task => task.projectId === projectId);
  const completed = projectTasks.reduce((sum, task) => sum + task.currentExecutions, 0);
  const planned = projectTasks.reduce((sum, task) => sum + task.targetExecutions, 0);
  if (iconOnly) {
    const stopping = status?.state === "stopping";
    const label = !status ? "Проверка состояния проекта" : stopping ? "Приостановка проекта" : active ? "Приостановить проект" : "Запустить проект";
    const compact = !status ? "Проверка…" : status.state === "waiting" ? status.waitReason === "schedule" ? "По расписанию" : "Ожидание" : status.state === "completed" ? "Завершён" : status.state === "failed" ? "Ошибка" : status.state === "busy" ? "Занят" : labels[status.state];
    return <div className={showStatus ? "project-run-compact" : "relative"}>
      {showStatus && <span className={`project-state ${active ? "project-state-active" : status?.state === "failed" ? "project-state-error" : ""}`} title={status ? labels[status.state] : undefined}><span aria-hidden="true" />{error ? "Нет связи" : compact}</span>}
      <Button size="icon" variant={active ? "outline" : "secondary"} disabled={pending || !status || stopping || status.state === "busy"}
        aria-label={`${label}${projectName ? ` ${projectName}` : ""}`} title={`${label}${status ? ` · ${labels[status.state]}` : ""}`}
        onClick={() => void act(active ? "stop" : "start")}>
        {pending || stopping || !status ? <LoaderCircle className="animate-spin" size={16} /> : active ? <Pause size={16} /> : <Play size={16} />}
      </Button>
      {error && <p role="alert" className="mt-2 max-w-64 text-xs text-destructive">{error}</p>}
    </div>;
  }
  return <section className="panel mb-6 p-5" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-sm font-medium">Исполнитель проекта</h2><p className="mt-1 text-xs text-muted-foreground">{status?.state === "waiting" && resourceWait[status.waitReason || ""] ? resourceWait[status.waitReason || ""] : status?.state === "waiting" && status.waitReason === "rate_limit" ? "Пауза после HTTP 429: сервер ограничил частоту запросов" : status?.state === "waiting" && status.waitReason === "schedule" ? "Ожидание разрешённого времени по расписанию проекта" : status?.state === "waiting" && status.waitReason === "daily_limit" ? "На сегодня дневные лимиты выполнены" : status?.state === "waiting" && status.waitReason === "daily_schedule" ? "Ожидание следующего запуска по дневному плану" : proxyFailure ? active ? "Исполнитель запущен · ожидает повторной попытки через прокси" : "Исполнитель остановлен · последняя попытка не прошла через прокси" : pastOpenAiError ? "Локальный сценарий готов к запуску" : openAiFailure && status?.providerCode ? providerFailureTitles[status.providerCode] ?? labels.failed : status ? labels[status.state] : "Проверка состояния…"}</p>{status?.state === "waiting" && status.nextCheckAt && <p className="mt-1 text-xs text-muted-foreground">Следующая проверка ресурсов: {new Date(status.nextCheckAt).toLocaleTimeString("ru-RU")}{status.nextAt ? ` · пауза до ${new Date(status.nextAt).toLocaleTimeString("ru-RU")}` : ""}</p>}{planned > 0 && <p className="mt-2 text-sm">Выполнено <strong>{completed} из {planned}</strong> · осталось {Math.max(0, planned - completed)}</p>}</div>
      {active ? <Button variant="outline" disabled={pending || status?.state === "stopping"} onClick={() => void act("stop")}>{pending || status?.state === "stopping" ? <LoaderCircle className="animate-spin" size={16} /> : <Square size={16} />}Остановить</Button>
        : <div className="flex flex-wrap gap-2"><Button className="primary-button" disabled={pending || !status || status.state === "busy"} onClick={() => void act("start")}>{pending ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}Запустить проект</Button>{captchaFailure && <Button variant="outline" disabled={pending || !status || status.state === "busy"} onClick={() => void act("start", true)}><Play size={16} />Запустить с окном браузера</Button>}</div>}
    </div>
    {proxyFailure && <p role="alert" className="mt-3 text-sm text-amber-300">Локальный план готов, но настроенный прокси закрывает соединение с сайтом проекта. Проверьте прокси, его авторизацию и разрешённый IP на стороне провайдера. <Link href="/proxies/" className="underline">Прокси</Link></p>}
    {active && status?.visible && <p className="mt-3 text-sm text-primary">Браузер открыт на этом компьютере для наблюдения. Проверку Яндекса воркер обрабатывает автоматически через RuCaptcha, если получает данные задания.</p>}
    {captchaFailure && <p role="alert" className="mt-3 text-sm text-amber-300">{status?.errorCode === "missing_api_key" ? <>Обнаружена капча, но ключ RuCaptcha не задан. <Link href="/settings/" className="underline">Сохраните ключ</Link> и запустите проект снова.</> : status?.errorCode === "widget_not_detected" || status?.errorCode === "sitekey_missing" ? <>Яндекс показал проверку, но воркер не получил ни sitekey, ни поддерживаемую пару изображений после нажатия чекбокса. Платный запрос не отправлен. Откройте <Link href="/proxies/" className="underline">прокси</Link> и проверьте доступность Яндекса, затем повторите запуск.</> : captchaFailureLabels[status?.errorCode ?? ""] ?? `Капча не обработана (${status?.errorCode ?? "ошибка"}).`} {status?.state === "failed" && "Счётчик задачи не изменён."}</p>}
    {searchFailure && <p role="alert" className="mt-3 text-sm text-amber-300">{searchFailureLabels[status?.errorCode ?? ""] ?? "Не удалось завершить поиск. Подробности доступны в журнале задачи."} Выполнений по этой попытке не добавлено.</p>}
    {!proxyFailure && pastOpenAiError ? <p className="mt-3 text-sm text-primary">Предыдущая попытка использовала OpenAI. Новый запуск строит сценарий локально и не требует API-ключа.</p>
      : openAiFailure && status?.errorCode && <p role="alert" className="mt-3 text-sm text-amber-300">{status.providerCode && providerFailureLabels[status.providerCode] ? providerFailureLabels[status.providerCode] : failureLabels[status.errorCode] ?? "Ошибка сервиса OpenAI."} {httpCode ? `Код HTTP: ${httpCode}.` : `Код: ${status.errorCode}.`} Выполнений по этой попытке не добавлено. <Link href="/settings/" className="underline">Настройки ключа</Link></p>}
    {status?.state === "failed" && !proxyFailure && !captchaFailure && !searchFailure && !openAiFailure && <p role="alert" className="mt-3 text-sm text-amber-300">Ошибка выполнения{status.errorCode ? ` · ${status.errorCode}` : ""}. Подробности доступны в журнале задачи.</p>}
    {error && <p role="alert" className="form-error mt-3">{error}</p>}
  </section>;
}
