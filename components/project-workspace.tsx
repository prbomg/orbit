"use client";
import { regionLabel } from "@/utils/projectRegions";
import { ALL_HOURS, isAllowed } from "@/utils/projectSchedule";
import { ProjectQueryStats } from "@/components/project-query-stats";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CreateTask, TaskTable } from "@/components/task-ui";
import { ProjectEditor } from "@/components/project-editor";
import { ProjectRunControls } from "@/components/project-run-controls";
import { projectRequest, type Project } from "@/lib/projects";
import { useData } from "@/lib/data-store";

export function ProjectWorkspace({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState(initialProject);
  const [error, setError] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const update = () => setScheduleOpen(isAllowed(project));
    update(); const timer = setInterval(update, 10000);
    return () => clearInterval(timer);
  }, [project.scheduleHours, project.scheduleTimezone]);
  const version = useRef(0);
  const { tasks, loading } = useData();
  const related = tasks.filter(task => task.projectId === project.id);
  const reload = async () => { const current = ++version.current; const next = await projectRequest<Project>(`/api/projects/${project.id}/`); if (current === version.current) { setProject(next); setError(""); } };
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const current = ++version.current;
      void projectRequest<Project>(`/api/projects/${initialProject.id}/`).then(next => { if (active && current === version.current) { setProject(next); setError(""); } }).catch(() => { if (active) setError("Не удалось обновить параметры проекта. Перезагрузите страницу."); });
    }, 5000);
    return () => { active = false; clearInterval(timer); version.current++; };
  }, [initialProject.id]);
  return <>
    <Link href="/projects/" className="mb-5 inline-block text-sm text-primary">← Все проекты</Link>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <div className="page-heading"><div><div className="eyebrow">ПРОЕКТ · {regionLabel(project)}</div><h1 className="break-words">{project.name}<span className="heading-dot">.</span></h1><p className="break-all">{project.targetUrl}</p></div><div className="flex flex-wrap gap-2"><ProjectEditor project={project} onSaved={reload} /><CreateTask project={project} /></div></div>
    {project.pool && <div className="panel mb-5 p-4 text-sm">Доступно прогретых профилей: <strong>{project.pool.available}</strong> · осталось выполнений: <strong>{project.pool.remaining}</strong>{project.pool.deficit > 0 && <p className="mt-2 text-amber-300">Готовые профили используются в разрешённые часы. Остальные {project.pool.deficit} выполнений продолжатся по мере готовности новых профилей.</p>}</div>}
    <section className="panel mb-5 flex flex-wrap items-center justify-between gap-4 p-5">
      <div><h2 className="text-sm font-medium">Расписание задач</h2><p className="mt-1 text-xs text-muted-foreground">{(project.scheduleHours ?? ALL_HOURS) === ALL_HOURS ? "Круглосуточно" : `${[...(project.scheduleHours ?? ALL_HOURS)].filter(bit => bit === "1").length} из 168 часов в неделю`} · {project.scheduleTimezone ?? "Europe/Moscow"}</p><p className={`mt-2 text-xs ${scheduleOpen === false ? "text-amber-300" : "text-muted-foreground"}`}>{scheduleOpen === null ? "Проверка расписания…" : scheduleOpen ? "Сейчас расписание разрешает новые выполнения" : "Сейчас новые выполнения запрещены расписанием"}</p></div>
      <ProjectEditor project={project} onSaved={reload} scheduleOnly />
    </section>
    <ProjectRunControls projectId={project.id} />
    <div className="task-summary"><span><b className="mono">{related.length}</b>Задач</span><span><b className="mono">{related.reduce((sum, task) => sum + task.currentExecutions, 0)}</b>Выполнено</span><span><b className="mono">{related.reduce((sum, task) => sum + task.targetExecutions, 0)}</b>По плану</span></div>
    <section className="panel table-panel"><div className="panel-heading"><h2>Задачи проекта</h2><span className="muted-label">{loading ? "Загрузка…" : related.length}</span></div><TaskTable tasks={related} /></section>
    <ProjectQueryStats projectId={project.id}/>

  </>;
}
