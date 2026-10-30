"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { TaskTable } from "@/components/task-ui";
import { Button } from "@/components/ui/button";
import type { Task } from "@/lib/data-store";
import { groupTasks, moveTask, orderTasks, readTaskListPreferences, type TaskListPreferences } from "@/utils/taskListOrder";

const storageKey = 'orbit.tasks.layout.v1';
type Drag = { id: string; project: string; pointer: number; x: number; y: number; moved: boolean; tasks: Task[] };

export function TaskProjectGroups({ tasks, allTasks, sort, onManual }: { tasks: Task[]; allTasks: Task[]; sort: string; onManual: () => void }) {
  const [preferences, setPreferences] = useState<TaskListPreferences>(() => readTaskListPreferences(null));
  const current = useRef(preferences), root = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null);
  const [ready, setReady] = useState(false), [notice, setNotice] = useState(''), [storageError, setStorageError] = useState('');
  const [preview, setPreview] = useState<{ project: string; ids: string[]; id: string } | null>(null);
  const reorderable = ready && (sort === 'manual' || sort === 'new');
  useEffect(() => {
    const read = () => {
      try { const next = readTaskListPreferences(localStorage.getItem(storageKey)); current.current = next; setPreferences(next); }
      catch { setStorageError('Браузер не разрешает сохранять порядок. Изменения действуют до закрытия страницы.'); }
      setReady(true);
    };
    read();
    const changed = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) read(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  function save(next: TaskListPreferences) {
    current.current = next; setPreferences(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setStorageError(''); }
    catch { setStorageError('Не удалось сохранить порядок в браузере. Изменения действуют до закрытия страницы.'); }
  }
  const projectTasks = (id: string) => orderTasks(allTasks.filter(task => (task.projectId || 'unassigned') === id), sort === 'manual' ? preferences.orders[id] : []);
  function commit(project: string, ordered: Task[]) {
    save({ ...current.current, orders: { ...current.current.orders, [project]: ordered.map(task => task.id) } });
    onManual(); setNotice('Порядок задач сохранён в этом браузере.');
  }
  function finish(cancel = false) {
    const state = drag.current;
    if (!state) return;
    drag.current = null; setPreview(null);
    if (root.current?.hasPointerCapture(state.pointer)) root.current.releasePointerCapture(state.pointer);
    if (!cancel && state.moved) commit(state.project, state.tasks);
  }
  function start(event: PointerEvent<HTMLButtonElement>, task: Task) {
    if (!reorderable || event.button !== 0 || drag.current) return;
    event.preventDefault(); event.currentTarget.focus();
    const project = task.projectId || 'unassigned';
    drag.current = { id: task.id, project, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, tasks: projectTasks(project) };
    root.current?.setPointerCapture(event.pointerId);
  }
  const groups = groupTasks(tasks);
  return <div ref={root} className="space-y-4" onPointerMove={event => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-task-id]');
    if (target && root.current?.contains(target)) {
      const next = moveTask(state.tasks, state.id, target.dataset.taskId!);
      if (next !== state.tasks) { state.moved = true; state.tasks = next; setPreview({ project: state.project, ids: next.map(task => task.id), id: state.id }); }
    }
    if (event.clientY < 70) window.scrollBy(0, -18);
    else if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
  }} onPointerUp={event => { if (event.pointerId === drag.current?.pointer) finish(); }} onPointerCancel={event => { if (event.pointerId === drag.current?.pointer) finish(true); }} onLostPointerCapture={() => finish(true)} onKeyDown={event => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(true); } }}>
    <p id="task-order-help" className="page-hint">Перемещайте задачи за значок слева или стрелками на клавиатуре. Порядок сохраняется в этом браузере.</p>
    {!reorderable && ready && <p className="page-hint">Для перемещения выберите сортировку «Новые / ручной порядок» или «Сначала новые».</p>}
    <p role="status" className="sr-only">{notice}</p>
    {storageError && <p role="alert" className="form-error">{storageError}</p>}
    {groups.map(group => {
      const collapsed = preferences.collapsed.includes(group.id), panelId = `project-tasks-${group.id}`;
      const visible = new Set(group.tasks.map(task => task.id));
      const ordered = preview?.project === group.id ? orderTasks(projectTasks(group.id), preview.ids).filter(task => visible.has(task.id)) : reorderable ? projectTasks(group.id).filter(task => visible.has(task.id)) : group.tasks;
      return <section key={group.id} className="panel table-panel" data-task-project={group.id} aria-label={`Задачи проекта ${group.name}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="min-w-0 flex-1"><button type="button" className="flex w-full items-center gap-2 text-left font-medium focus-visible:outline-2 focus-visible:outline-primary" disabled={!ready} aria-expanded={!collapsed} aria-controls={panelId} onClick={() => {
            finish(true);
            save({ ...current.current, collapsed: collapsed ? current.current.collapsed.filter(id => id !== group.id) : [...current.current.collapsed, group.id] });
          }}>{collapsed ? <ChevronRight size={18} className="shrink-0"/> : <ChevronDown size={18} className="shrink-0"/>}<span className="break-words">{group.name}</span><span className="shrink-0 text-xs text-muted-foreground">{group.tasks.length}</span></button></h2>
          {preferences.orders[group.id]?.length > 0 && <Button size="sm" variant="ghost" aria-label={`Сбросить порядок задач проекта ${group.name}`} onClick={() => {
            finish(true);
            const orders = { ...current.current.orders }; delete orders[group.id]; save({ ...current.current, orders });
            onManual(); setNotice('В проекте восстановлен порядок: сначала новые.');
          }}><RotateCcw size={14}/>По дате</Button>}
        </div>
        <div id={panelId} hidden={collapsed}><TaskTable tasks={ordered} reorder={{ disabled: !reorderable, draggingId: preview?.id || null, onPointerDown: start, onMove: (task, direction) => {
          if (!reorderable) return;
          const index = ordered.findIndex(item => item.id === task.id), target = ordered[index + direction];
          if (target) commit(group.id, moveTask(projectTasks(group.id), task.id, target.id));
        } }}/></div>
      </section>;
    })}
  </div>;
}
