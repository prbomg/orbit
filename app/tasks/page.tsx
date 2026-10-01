"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { CreateTask, TaskTable, taskLabel } from "@/components/task-ui";
import { ServiceStatus } from "@/components/service-status";
import { Input } from "@/components/ui/input";
import { useData } from "@/lib/data-store";
export default function TasksPage() {
  const { tasks, profiles } = useData(); const [query, setQuery] = useState(""); const [status, setStatus] = useState(""); const [mode, setMode] = useState(""); const [profile, setProfile] = useState("");
  const active = tasks.filter(task => task.status === "running" && task.profile.isEnabled && task.profile.status !== "banned").length;
  const filtered = tasks.filter(task => (!status || task.status === status) && (!profile || task.profileId === profile) && (!mode || (mode === "warmup" ? task.taskType === "warmup" : task.taskType !== "warmup" && (mode === "search" ? Boolean(task.searchEngine) : !task.searchEngine))) && [taskLabel(task), task.profile.name, ...task.searchQueries, ...task.vitalPhrases, ...task.targetKeywords].join(" ").toLowerCase().includes(query.toLowerCase()));
  const control = "h-10 rounded-md border border-input bg-background px-3 text-sm";
  return <><div className="page-heading"><div><div className="eyebrow">АВТОМАТИЗАЦИЯ</div><h1>Задачи<span className="heading-dot">.</span></h1><p>Сценарии, поисковые фразы и профили для каждого запуска.</p></div><Button asChild><Link href="/projects/">Выбрать проект</Link></Button></div><ServiceStatus />
    <div className="task-summary"><span><b className="mono">{tasks.length}</b>Всего задач</span><span><b className="mono text-primary">{active}</b>Запланировано</span><span><b className="mono">{tasks.filter(task => task.status === "paused").length}</b>На паузе</span><span><b className="mono">{tasks.filter(task => task.status === "completed").length}</b>Завершено</span></div>
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Input aria-label="Поиск задач" placeholder="Домен, фраза или профиль" value={query} onChange={event => setQuery(event.target.value)} /><select className={control} aria-label="Фильтр статуса" value={status} onChange={event => setStatus(event.target.value)}><option value="">Все статусы</option><option value="running">Запланированы</option><option value="paused">На паузе</option><option value="completed">Завершены</option><option value="failed">Ошибка</option></select><select className={control} aria-label="Фильтр сценария" value={mode} onChange={event => setMode(event.target.value)}><option value="">Все сценарии</option><option value="search">Поиск сайта</option><option value="direct">Прямой URL</option><option value="warmup">Прогрев</option></select><select className={control} aria-label="Фильтр профиля" value={profile} onChange={event => setProfile(event.target.value)}><option value="">Все профили</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <section className="panel table-panel"><div className="panel-heading"><h2>Все задачи</h2><span className="muted-label">Показано: {filtered.length} из {tasks.length}</span></div><TaskTable tasks={filtered} /></section><p className="page-hint">«Запланировано» означает, что задача разрешена к выполнению. Текущий этап показан в колонке «Статус». Если план выполнен, сначала увеличьте количество выполнений в редакторе. Данные обновляются каждые 5 секунд.</p></>;
}
