"use client";
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
  const version = useRef(0);
  const { tasks, loading } = useData();
  const related = tasks.filter(task => task.projectId === project.id);
  const reload = async () => { const current = ++version.current; const next = await projectRequest<Project>(`/api/projects/${project.id}/`); if (current === version.current) { setProject(next); setError(""); } };
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const current = ++version.current;
      void projectRequest<Project>(`/api/projects/${initialProject.id}/`).then(next => { if (active && current === version.current) { setProject(next); setError(""); } }).catch(() => { if (active) setError("Не удалось обновить параметры и историю проекта. Перезагрузите страницу."); });
    }, 5000);
    return () => { active = false; clearInterval(timer); version.current++; };
  }, [initialProject.id]);
  return <>
    <Link href="/projects/" className="mb-5 inline-block text-sm text-primary">← Все проекты</Link>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <div className="page-heading"><div><div className="eyebrow">ПРОЕКТ · РЕГИОН {project.yandexRegionId}</div><h1 className="break-words">{project.name}<span className="heading-dot">.</span></h1><p className="break-all">{project.targetUrl}</p></div><div className="flex flex-wrap gap-2"><ProjectEditor project={project} onSaved={reload} /><CreateTask project={project} /></div></div>
    <ProjectRunControls projectId={project.id} />
    <div className="task-summary"><span><b className="mono">{related.length}</b>Задач</span><span><b className="mono">{related.reduce((sum, task) => sum + task.currentExecutions, 0)}</b>Выполнено</span><span><b className="mono">{related.reduce((sum, task) => sum + task.targetExecutions, 0)}</b>По плану</span></div>
    <section className="panel table-panel"><div className="panel-heading"><h2>Задачи проекта</h2><span className="muted-label">{loading ? "Загрузка…" : related.length}</span></div><TaskTable tasks={related} /></section>
    <section className="panel mt-6"><div className="panel-heading"><h2>История профилей</h2><span className="muted-label">{project._count?.profileHistory ?? 0} записей · последние 100</span></div>
      {project.profileHistory?.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-muted-foreground"><th className="p-4">Профиль</th><th className="p-4">Дата</th><th className="p-4">Источник</th></tr></thead><tbody>{project.profileHistory.map(item => <tr key={item.id} className="border-b last:border-0"><td className="p-4">{item.profile.name}<span className="mt-1 block font-mono text-xs text-muted-foreground">{item.profileId}</span></td><td className="p-4">{new Date(item.executedAt).toLocaleString("ru-RU")}</td><td className="p-4">{item.source === "legacy" ? "Импорт старых данных" : "Выполнение"}</td></tr>)}</tbody></table></div> : <p className="p-8 text-center text-muted-foreground">Нет сохранённых выполнений для профилей этого проекта.</p>}
    </section>
  </>;
}
