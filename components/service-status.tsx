"use client";
import Link from "next/link";
import { Activity, AlertCircle, CheckCircle2 } from "lucide-react";
import { useData } from "@/lib/data-store";
export function ServiceStatus() {
  const { system, proxies, tasks, loading } = useData();
  const running = system?.workerState === "running";
  const readyProxies = proxies.filter(proxy => proxy.isActive).length;
  const queued = tasks.filter(task => task.status === "running" && task.profile.isEnabled && task.profile.status !== "banned").length;
  return <section className="panel mb-6"><div className="flex flex-wrap items-start justify-between gap-4 p-5"><div className="flex gap-3"><Activity className={running ? "text-primary" : "text-muted-foreground"} size={20} /><div><h2 className="text-sm font-medium">{loading ? "Проверка воркера…" : running ? "Процесс воркера запущен" : system?.workerState === "unknown" ? "Состояние воркера неизвестно" : system?.workerState === "stale" ? "Процесс воркера завершился" : "Воркер не запущен"}</h2><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{running ? "Задачи выполняются последовательно. Прогресс смотрите на странице проекта." : "Откройте проект и нажмите «Запустить проект»."}</p></div></div><Link href="/projects" className="text-link">Открыть проекты →</Link></div>{queued > 0 && !readyProxies && <p className="flex items-center gap-2 border-t px-5 py-3 text-xs text-amber-300"><AlertCircle size={15} />Для {queued} задач нет включённых прокси. <Link href="/proxies" className="underline">Добавить прокси</Link></p>}{running && readyProxies > 0 && <p className="flex items-center gap-2 border-t px-5 py-3 text-xs text-muted-foreground"><CheckCircle2 size={15} />Включённых прокси: {readyProxies}. Работоспособность соединения проверяется перед посещением.</p>}</section>;
}
