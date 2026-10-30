"use client";
import { moveProject } from "@/utils/projectOrder";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowRight, Clock3, FolderKanban, GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProjectDeleteDialog } from "@/components/project-delete-dialog";
import { DuplicateButton } from "@/components/duplicate-button";
import { ProjectEditor } from "@/components/project-editor";
import { ProjectRunControls } from "@/components/project-run-controls";
import { useData } from "@/lib/data-store";
import { regionLabel } from "@/utils/projectRegions";
import { ALL_HOURS } from "@/utils/projectSchedule";
import { projectRequest, type Project } from "@/lib/projects";

export default function ProjectsPage() {
  const { tasks, loading: dataLoading, error: dataError, refresh } = useData();
  const orderBusy = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<{id:string;pointer:number;x:number;y:number;before:Project[];moved:boolean}|null>(null);
  const current = useRef<Project[]>([]);
  const [dragging,setDragging] = useState<string|null>(null);
  const [savingOrder,setSavingOrder] = useState(false);
  const [orderNotice,setOrderNotice] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const reload = useCallback(async () => {
    const [active, archived] = await Promise.all([projectRequest<Project[]>("/api/projects/"), projectRequest<Project[]>("/api/projects/?archived=1")]);
    const items = [...active, ...archived];
    current.current=items; setProjects(items); setError("");
  }, []);
  useEffect(() => { void reload().catch(cause => setError(cause.message)).finally(() => setLoading(false)); }, [reload]);
  const filtered = projects.filter(project => Boolean(project.archivedAt) === showArchive).filter(project => [project.name, project.targetUrl, regionLabel(project)].join(" ").toLowerCase().includes(query.toLowerCase()));
  async function saveOrder(before:Project[]) {
    const next=current.current;
    if(before.map(p=>p.id).join()===next.map(p=>p.id).join())return;
    orderBusy.current=true;setError("");setSavingOrder(true);setOrderNotice("Сохраняем порядок…");
    try { await projectRequest("/api/projects/order/",{method:"PATCH",body:JSON.stringify({ids:next.filter(p=>Boolean(p.archivedAt)===showArchive).map(p=>p.id),archived:showArchive})});setOrderNotice("Порядок сохранён"); }
    catch(cause){current.current=before;setProjects(before);setOrderNotice("");setError(cause instanceof Error?cause.message:"Не удалось сохранить порядок");}
    finally{orderBusy.current=false;setSavingOrder(false);}
  }
  function move(source:string,target:string){const next=moveProject(current.current,source,target);current.current=next;setProjects(next);}
  function finishDrag(cancel=false){const state=drag.current;if(!state)return;drag.current=null;setDragging(null);if(grid.current?.hasPointerCapture(state.pointer))grid.current.releasePointerCapture(state.pointer);if(cancel){current.current=state.before;setProjects(state.before);}else void saveOrder(state.before);}
  async function changeArchive(project: Project, action: "archive" | "restore") {
    setPending(true); setDeleteError("");
    try { await projectRequest(`/api/projects/${project.id}/`, { method: "POST", body: JSON.stringify({ action }) }); await reload(); setArchiving(null); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "Не удалось изменить архив"; if (action === "archive") setDeleteError(message); else setError(message); }
    finally { setPending(false); }
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>Проекты<span className="heading-dot">.</span></h1><p>Сайты и параметры проектов в одном месте.</p></div><ProjectEditor onSaved={reload} /></div>
    <div className="resource-toolbar project-filters"><div className="flex gap-2"><Button variant={showArchive ? "outline" : "secondary"} aria-pressed={!showArchive} onClick={() => setShowArchive(false)}>Активные · {projects.filter(p => !p.archivedAt).length}</Button><Button variant={showArchive ? "secondary" : "outline"} aria-pressed={showArchive} onClick={() => setShowArchive(true)}><Archive size={16} />Архив · {projects.filter(p => p.archivedAt).length}</Button></div>
    <Input aria-label="Поиск проектов" placeholder="Название, сайт или регион" value={query} onChange={event => setQuery(event.target.value)} className="project-search" /></div>
    {loading && <p role="status" className="text-muted-foreground">Загрузка проектов…</p>}
    {error && <div role="alert" className="mb-5 flex items-center gap-4"><p className="text-destructive">{error}</p><Button variant="outline" onClick={() => void reload().catch(cause => setError(cause.message))}>Повторить</Button></div>}
    <p id="project-order-help" className="mb-3 text-xs text-muted-foreground">Порядок карточек можно менять перетаскиванием или стрелками на клавиатуре.</p>
    <p role="status" aria-live="polite" className="sr-only">{orderNotice}</p>
    <div ref={grid} className="project-grid" onPointerMove={event=>{
      const state=drag.current;if(!state||event.pointerId!==state.pointer)return;
      if(!state.moved&&Math.hypot(event.clientX-state.x,event.clientY-state.y)<6)return;
      state.moved=true;setDragging(state.id);
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>("[data-project-id]")?.dataset.projectId;
      if(target)move(state.id,target);
      if(event.clientY<70)window.scrollBy(0,-18);else if(event.clientY>window.innerHeight-70)window.scrollBy(0,18);
    }} onPointerUp={()=>finishDrag()} onPointerCancel={()=>finishDrag(true)} onLostPointerCapture={()=>{if(drag.current)finishDrag(true);}} onKeyDown={event=>{if(event.key==="Escape")finishDrag(true);}}>

      {filtered.map(project => {
        const related = tasks.filter(task => task.projectId === project.id);
        const completed = related.reduce((sum, task) => sum + task.currentExecutions, 0);
        const planned = related.reduce((sum, task) => sum + task.targetExecutions, 0);
        const errors = related.filter(task => task.status === "failed").length;
        const hours = [...(project.scheduleHours ?? ALL_HOURS)].filter(bit => bit === "1").length;
        return <section key={project.id} data-project-id={project.id} className={`panel project-card ${dragging===project.id?"project-card-dragging":""}`}>
          <div className="project-card-top"><div className="flex items-center gap-2"><button type="button" className="project-drag-handle" aria-label={`Переместить проект ${project.name}`} aria-describedby="project-order-help" title="Перетащить проект" disabled={savingOrder||pending||loading} onPointerDown={event=>{if(event.button!==0||orderBusy.current||pending)return;event.preventDefault();event.currentTarget.focus();drag.current={id:project.id,pointer:event.pointerId,x:event.clientX,y:event.clientY,before:current.current,moved:false};grid.current?.setPointerCapture(event.pointerId);}} onKeyDown={event=>{
            if(event.key!=="ArrowUp"&&event.key!=="ArrowDown")return;event.preventDefault();if(orderBusy.current)return;
            const index=filtered.findIndex(p=>p.id===project.id),target=filtered[index+(event.key==="ArrowUp"?-1:1)];if(!target)return;
            const before=current.current;move(project.id,target.id);void saveOrder(before);
          }}><GripVertical size={18}/></button><span className="project-card-icon"><FolderKanban size={21} /></span></div>{project.archivedAt ? <span className="project-state">В архиве</span> : <ProjectRunControls projectId={project.id} projectName={project.name} iconOnly showStatus />}</div>
          <Link href={`/projects/${project.id}/`} className="project-card-title" title={project.name}>{project.name}</Link>
          <p className="project-card-url" title={project.targetUrl}>{project.targetUrl}</p>
          <p className="mt-3 text-sm text-muted-foreground">{regionLabel(project)}</p>
          <div className="project-card-schedule"><Clock3 size={14} /><span>{hours === 168 ? "Круглосуточно" : hours === 0 ? "Запуск по расписанию запрещён" : `${hours} ч в неделю`}<small>{project.scheduleTimezone ?? "Europe/Moscow"}</small></span></div>
          <div className="project-card-progress"><div><span>Выполнено</span><strong className="mono">{dataLoading || dataError ? "—" : `${completed.toLocaleString("ru-RU")} / ${planned.toLocaleString("ru-RU")}`}</strong></div><progress className="orbit-progress" aria-label={`Прогресс проекта ${project.name}`} value={dataLoading || dataError ? 0 : Math.min(completed, planned)} max={Math.max(1, planned)} /></div>
          <div className="project-card-meta"><span>Задач: {project._count?.tasks ?? related.length}</span><span>{dataLoading || dataError ? "С ошибкой: —" : errors > 0 ? <span className="text-destructive">С ошибкой: {errors}</span> : "С ошибкой: 0"}</span></div>
          <div className="project-card-actions">
          <Button asChild variant="ghost" size="icon"><Link href={`/projects/${project.id}/`} aria-label={`Открыть проект ${project.name}`} title="Открыть проект"><ArrowRight size={16} /></Link></Button>
          {!project.archivedAt && <><ProjectEditor project={project} onSaved={reload} scheduleOnly iconOnly /><ProjectEditor project={project} onSaved={reload} iconOnly /></>}
          <DuplicateButton kind="projects" id={project.id} name={project.name} onCreated={async()=>{setShowArchive(false);setQuery('');await reload();}}/>
          <span className="project-action-divider" aria-hidden="true" />
          {project.archivedAt ? <Button variant="outline" size="icon" aria-label={`Восстановить проект ${project.name}`} title="Восстановить" disabled={pending} onClick={() => void changeArchive(project, "restore")}><ArchiveRestore size={16} /></Button> : <Button variant="ghost" size="icon" aria-label={`В архив проект ${project.name}`} title="В архив" onClick={() => { setArchiving(project); setDeleteError(""); }}><Archive size={16} /></Button>}
          <Button variant="ghost" size="icon" aria-label={`Удалить проект ${project.name}`} title="Удалить" onClick={() => { setDeleting(project); setDeleteError(""); }}><Trash2 size={16} /></Button>
          </div>
        </section>;
      })}
    </div>
    {!loading && !error && !filtered.length && <section className="panel p-10 text-center text-muted-foreground">{query ? "Нет проектов по вашему запросу." : showArchive ? "В архиве пока нет проектов." : "Создайте первый проект, чтобы сохранить параметры сайта."}</section>}
    <Dialog open={Boolean(archiving)} onOpenChange={open => { if (!open && !pending) setArchiving(null); }}><DialogContent showCloseButton={!pending}><DialogHeader><DialogTitle>В архив «{archiving?.name}»?</DialogTitle><DialogDescription>Проект будет скрыт из активного списка. Задачи и статистика сохранятся. Ожидающие задачи будут приостановлены. После восстановления задачи можно возобновить вручную.</DialogDescription></DialogHeader>{deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}<div className="flex justify-end gap-2"><Button variant="outline" disabled={pending} onClick={() => setArchiving(null)}>Отмена</Button><Button disabled={pending} onClick={() => archiving && void changeArchive(archiving, "archive")}>{pending ? "Архивирование…" : "В архив"}</Button></div></DialogContent></Dialog>
    {deleting && <ProjectDeleteDialog key={deleting.id} project={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void Promise.all([reload(), refresh()]).catch(() => setError("Проект удалён, но список не обновился. Обновите страницу.")); }}/>}

  </>;
}
