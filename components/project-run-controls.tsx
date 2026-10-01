"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useData } from "@/lib/data-store";
import { projectRequest } from "@/lib/projects";

type RunStatus = { state: "stopped" | "busy" | "running" | "waiting" | "stopping" | "completed" | "failed"; visible?: boolean; taskId?: string | null; errorType?: string | null; errorCode?: string | null; providerCode?: string | null };
const labels: Record<RunStatus["state"], string> = {
  stopped: "Остановлен", busy: "Исполнитель занят другим проектом", running: "Выполняется", waiting: "Ожидание прокси или повторной попытки", stopping: "Останавливается", completed: "Очередь проекта завершена", failed: "Процесс завершился с ошибкой",
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
  ERROR_CAPTCHA_UNSOLVABLE: "RuCaptcha приняла задание, но не смогла его распознать. При следующем запуске воркер выполнит ограниченные автоматические повторы.",
  solve_limit: "Лимит автоматических попыток решения капчи исчерпан. Исполнитель остановлен, новые платные запросы не отправляются.",
  image_capture_failed: "Не удалось получить исходное изображение капчи. Запрос в RuCaptcha не отправлен.",
  captcha_reload_failed: "Не удалось обновить страницу проверки для повторной попытки. Проверьте соединение через прокси.",
};

export function ProjectRunControls({ projectId }: { projectId: string }) {
  const { system, tasks } = useData();
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setStatus(await projectRequest<RunStatus>(`/api/projects/${projectId}/run/`)); }
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
  const captchaFailure = status?.errorType === "CaptchaError";
  const searchHomeFailure = status?.errorType === "SearchError" && status.errorCode === "search_home_timeout";
  const pastOpenAiError = system?.planMode === "local" && Boolean(status?.errorCode?.startsWith("http_"));
  const proxyFailure = status?.errorType === "ProxyCheckError" && status.state !== "running";
  const projectTasks = tasks.filter(task => task.projectId === projectId);
  const completed = projectTasks.reduce((sum, task) => sum + task.currentExecutions, 0);
  const planned = projectTasks.reduce((sum, task) => sum + task.targetExecutions, 0);
  return <section className="panel mb-6 p-5" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-sm font-medium">Исполнитель проекта</h2><p className="mt-1 text-xs text-muted-foreground">{proxyFailure ? active ? "Исполнитель запущен · ожидает повторной попытки через прокси" : "Исполнитель остановлен · последняя попытка не прошла через прокси" : pastOpenAiError ? "Локальный сценарий готов к запуску" : status?.state === "failed" && status.providerCode ? providerFailureTitles[status.providerCode] ?? labels.failed : status ? labels[status.state] : "Проверка состояния…"}</p>{planned > 0 && <p className="mt-2 text-sm">Выполнено <strong>{completed} из {planned}</strong> · осталось {Math.max(0, planned - completed)}</p>}</div>
      {active ? <Button variant="outline" disabled={pending || status?.state === "stopping"} onClick={() => void act("stop")}>{pending || status?.state === "stopping" ? <LoaderCircle className="animate-spin" size={16} /> : <Square size={16} />}Остановить</Button>
        : <div className="flex flex-wrap gap-2"><Button className="primary-button" disabled={pending || !status || status.state === "busy"} onClick={() => void act("start")}>{pending ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={16} />}Запустить проект</Button>{captchaFailure && <Button variant="outline" disabled={pending || !status || status.state === "busy"} onClick={() => void act("start", true)}><Play size={16} />Запустить с окном браузера</Button>}</div>}
    </div>
    {proxyFailure && <p role="alert" className="mt-3 text-sm text-amber-300">Локальный план готов, но настроенный прокси закрывает соединение с сайтом проекта. Проверьте прокси, его авторизацию и разрешённый IP на стороне провайдера. <Link href="/proxies/" className="underline">Прокси</Link></p>}
    {active && status?.visible && <p className="mt-3 text-sm text-primary">Браузер открыт на этом компьютере для наблюдения. Проверку Яндекса воркер обрабатывает автоматически через RuCaptcha, если получает данные задания.</p>}
    {captchaFailure && <p role="alert" className="mt-3 text-sm text-amber-300">{status?.errorCode === "missing_api_key" ? <>Обнаружена капча, но ключ RuCaptcha не задан. <Link href="/settings/" className="underline">Сохраните ключ</Link> и запустите проект снова.</> : status?.errorCode === "widget_not_detected" || status?.errorCode === "sitekey_missing" ? <>Яндекс показал проверку, но воркер не получил ни sitekey, ни поддерживаемую пару изображений после нажатия чекбокса. Платный запрос не отправлен. Откройте <Link href="/proxies/" className="underline">прокси</Link> и проверьте доступность Яндекса, затем повторите запуск.</> : captchaFailureLabels[status?.errorCode ?? ""] ?? `Капча не обработана (${status?.errorCode ?? "ошибка"}).`} {status?.state === "failed" && "Счётчик задачи не изменён."}</p>}
    {searchHomeFailure && <p role="alert" className="mt-3 text-sm text-amber-300">Не удалось открыть поисковик через текущий прокси. Ввод запроса и нажатие «Найти» в этой попытке не выполнялись. <Link href="/proxies/" className="underline">Проверить прокси</Link></p>}
    {!proxyFailure && pastOpenAiError ? <p className="mt-3 text-sm text-primary">Предыдущая попытка использовала OpenAI. Новый запуск строит сценарий локально и не требует API-ключа.</p>
      : !proxyFailure && !captchaFailure && !searchHomeFailure && status?.errorCode && <p role="alert" className="mt-3 text-sm text-amber-300">{status.providerCode && providerFailureLabels[status.providerCode] ? providerFailureLabels[status.providerCode] : failureLabels[status.errorCode] ?? "Ошибка сервиса OpenAI."} Код HTTP: {status.errorCode.replace("http_", "")}. Выполнений по этой попытке не добавлено. <Link href="/settings/" className="underline">Настройки ключа</Link></p>}
    {error && <p role="alert" className="form-error mt-3">{error}</p>}
  </section>;
}
