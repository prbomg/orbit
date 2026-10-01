"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FolderKanban, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProjectEditor } from "@/components/project-editor";
import { projectRequest, type Project } from "@/lib/projects";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const reload = useCallback(async () => {
    const items = await projectRequest<Project[]>("/api/projects/");
    setProjects(items); setError("");
  }, []);
  useEffect(() => { void reload().catch(cause => setError(cause.message)).finally(() => setLoading(false)); }, [reload]);
  const filtered = projects.filter(project => [project.name, project.targetUrl, project.yandexRegionId].join(" ").toLowerCase().includes(query.toLowerCase()));
  async function remove() {
    if (!deleting) return;
    setPending(true); setDeleteError("");
    try { await projectRequest(`/api/projects/${deleting.id}/`, { method: "DELETE" }); await reload(); setDeleting(null); }
    catch (cause) { setDeleteError(cause instanceof Error ? cause.message : "Не удалось удалить проект"); }
    finally { setPending(false); }
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>Проекты<span className="heading-dot">.</span></h1><p>Сайты и параметры проектов в одном месте.</p></div><ProjectEditor onSaved={reload} /></div>
    <Input aria-label="Поиск проектов" placeholder="Название, сайт или ID региона" value={query} onChange={event => setQuery(event.target.value)} className="mb-6 max-w-md" />
    {loading && <p role="status" className="text-muted-foreground">Загрузка проектов…</p>}
    {error && <div role="alert" className="mb-5 flex items-center gap-4"><p className="text-destructive">{error}</p><Button variant="outline" onClick={() => void reload().catch(cause => setError(cause.message))}>Повторить</Button></div>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {filtered.map(project => <section key={project.id} className="panel min-w-0 p-5">
        <div className="mb-4 flex items-start justify-between gap-3"><FolderKanban className="text-primary" size={22} /><span className="text-xs text-muted-foreground">Регион {project.yandexRegionId}</span></div>
        <Link href={`/projects/${project.id}/`} className="block truncate text-lg font-semibold hover:text-primary">{project.name}</Link>
        <p className="mt-2 truncate text-sm text-muted-foreground" title={project.targetUrl}>{project.targetUrl}</p>
        <p className="my-4 text-sm">Задач: <span className="mono">{project._count?.tasks ?? 0}</span></p>
        <div className="flex flex-wrap items-center gap-2"><Button asChild variant="secondary"><Link href={`/projects/${project.id}/`}>Открыть<ArrowRight size={16} /></Link></Button><ProjectEditor project={project} onSaved={reload} /><Button variant="ghost" size="icon" aria-label={`Удалить проект ${project.name}`} onClick={() => { setDeleting(project); setDeleteError(""); }}><Trash2 size={16} /></Button></div>
      </section>)}
    </div>
    {!loading && !error && !filtered.length && <section className="panel p-10 text-center text-muted-foreground">{projects.length ? "Нет проектов по вашему запросу." : "Создайте первый проект, чтобы сохранить параметры сайта."}</section>}
    <Dialog open={Boolean(deleting)} onOpenChange={open => { if (!open && !pending) setDeleting(null); }}><DialogContent showCloseButton={!pending}><DialogHeader><DialogTitle>Удалить проект «{deleting?.name}»?</DialogTitle><DialogDescription>Можно удалить только проект без задач и истории профилей.</DialogDescription></DialogHeader>{deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}<div className="flex justify-end gap-2"><Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>Отмена</Button><Button variant="destructive" disabled={pending} onClick={() => void remove()}>{pending ? "Удаление…" : "Удалить проект"}</Button></div></DialogContent></Dialog>
  </>;
}
