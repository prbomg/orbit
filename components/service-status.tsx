"use client";
import Link from "next/link";
import { Activity, AlertCircle, CheckCircle2 } from "lucide-react";
import { useData } from "@/lib/data-store";
export function ServiceStatus({ settingsContext = false }: { settingsContext?: boolean }) {
  const { system, proxies, tasks, loading } = useData();
  const running = system?.workerState === "running";
  const readyProxies = proxies.filter(proxy => proxy.isActive).length;
  const queued = tasks.filter(task => task.status === "running").length;
  return <section className="panel mb-6"><div className="flex flex-wrap items-start justify-between gap-4 p-5"><div className="flex gap-3"><Activity className={running ? "text-primary" : "text-muted-foreground"} size={20} /><div><h2 className="text-sm font-medium">{loading ? "Проверка воркера…" : running ? `Исполнителей проектов: ${system?.activeProjectCount ?? 1}` : system?.workerState === "unknown" ? "Состояние воркера неизвестно" : system?.workerState === "stale" ? "Процесс воркера завершился" : settingsContext ? "Проекты сейчас не выполняются" : "Воркер не запущен"}</h2><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{running ? "Проекты работают параллельно. Внутри каждого проекта задания выполняются с настроенным числом потоков; при нехватке профилей или прокси ожидают свободные ресурсы." : "Откройте проект и нажмите «Запустить проект»."}</p></div></div><Link href="/projects" className="text-link">Открыть проекты →</Link></div>{queued > 0 && !readyProxies && <p className="flex items-center gap-2 border-t px-5 py-3 text-xs text-amber-300"><AlertCircle size={15} />Для {queued} задач нет включённых прокси. <Link href="/proxies" className="underline">Добавить прокси</Link></p>}{running && readyProxies > 0 && <p className="flex items-center gap-2 border-t px-5 py-3 text-xs text-muted-foreground"><CheckCircle2 size={15} />Включённых прокси: {readyProxies}. Работоспособность соединения проверяется перед посещением.</p>}</section>;
}
