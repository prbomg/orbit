"use client";
import Link from "next/link";
import { ArrowRight, CheckCheck, ListTodo, Network, Activity, BarChart3, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateTask, TaskTable } from "@/components/task-ui";
import { ServiceStatus } from "@/components/service-status";
import { useData } from "@/lib/data-store";

export default function Dashboard() {
  const { tasks, proxies, loading } = useData();
  const active = tasks.filter(t => t.status === "running" && t.profile.isEnabled && t.profile.status !== "banned");
  const total = tasks.reduce((sum, task) => sum + task.currentExecutions, 0);
  const chartTasks = tasks.slice(0, 7);
  const max = Math.max(4, Math.ceil(Math.max(0, ...chartTasks.map(t => t.currentExecutions)) / 4) * 4);
  const metrics = [
    { title: "Задачи в очереди", value: loading ? "—" : String(active.length).padStart(2, "0"), detail: `из ${tasks.length} задач в пространстве`, icon: ListTodo, accent: true },
    { title: "Всего выполнений", value: loading ? "—" : total.toLocaleString("ru-RU"), detail: "по сохранённым счётчикам задач", icon: CheckCheck, accent: false },
    { title: "Прокси в пуле", value: loading ? "—" : String(proxies.length).padStart(2, "0"), detail: `${proxies.filter(p => p.isActive).length} включены`, icon: Network, accent: false },
  ];
  return <>
    <div className="page-heading"><div><div className="eyebrow">ОБЗОР ПРОСТРАНСТВА</div><h1>Всё под контролем<span className="heading-dot">.</span></h1><p>Ваши задачи, выполнения и ресурсы — в одном месте.</p></div><Button asChild><Link href="/projects/">Выбрать проект</Link></Button></div>
    <ServiceStatus /><div className="stats-grid">{metrics.map(metric => <section className={`stat-card ${metric.accent ? "stat-featured" : ""}`} key={metric.title}><div className="stat-top"><span>{metric.title}</span><metric.icon size={18} /></div><div className="stat-value mono">{metric.value}</div><div className="stat-bottom">{metric.accent && <span className="live-dot" />}{metric.detail}</div></section>)}</div>
    <div className="overview-grid">
      <section className="panel activity-panel"><div className="panel-heading"><div><h2>Выполнения по задачам</h2><p>Последние семь созданных задач</p></div><span className="period"><BarChart3 size={14} />Счётчики</span></div>
        <div className="chart-summary"><span className="mono">{total.toLocaleString("ru-RU")}</span><span>выполнений всего</span></div>
        {chartTasks.length > 0 ? <div className="bar-chart" role="img" aria-label={chartTasks.map(t => `${t.url}: ${t.currentExecutions}`).join(", ")}><div className="chart-y">{[max, max * .75, max * .5, max * .25, 0].map(value => <span key={value}>{value}</span>)}</div><div className="chart-plot"><div className="chart-grid" />{chartTasks.map((task, i) => <div className={`bar-column ${i === 0 ? "current" : ""}`} key={task.id} title={task.url}><span className="bar-number mono">{task.currentExecutions}</span><div className="bar" style={{ height: `${task.currentExecutions / max * 100}%` }} /><span className="bar-label">{String(i + 1).padStart(2, "0")}</span></div>)}</div></div> : <p className="px-6 py-12 text-sm text-muted-foreground">{loading ? "Загрузка статистики…" : "Создайте задачу, чтобы увидеть счётчики."}</p>}
      </section>
      <section className="panel snapshot-panel"><div className="panel-heading"><h2>Готовы к запуску</h2><Activity size={18} className="text-primary" /></div><div className="snapshot-count"><span className="mono">{active.length}</span><span>задач<br />в очереди</span></div><div className="snapshot-list">{active.slice(0, 3).map(task => <div key={task.id}><span className="live-dot" /><span>{task.taskType === "warmup" ? "Прогрев профиля" : task.project ? new URL(task.project.targetUrl).hostname : task.url}</span><span className="mono">{task.currentExecutions}</span></div>)}{active.length === 0 && <p className="text-muted-foreground">Нет активных задач.</p>}</div><Button asChild variant="outline" className="w-full"><Link href="/tasks">Управлять задачами<ArrowRight size={15} /></Link></Button><div className="snapshot-foot"><Terminal size={13} /><span>Выполнения учитываются после посещения</span></div></section>
    </div>
    <section className="panel table-panel"><div className="panel-heading"><div className="flex items-center gap-3"><h2>Задачи в очереди</h2><span className="count-pill">{active.length}</span></div><Link href="/tasks" className="text-link">Все задачи<ArrowRight size={14} /></Link></div><TaskTable tasks={active} /></section>
  </>;
}
