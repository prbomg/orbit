"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnalyticsProjectPicker } from "@/components/analytics-project-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreateTask, taskLabel } from "@/components/task-ui";
import { TaskProjectGroups } from "@/components/task-project-groups";
import { useData } from "@/lib/data-store";
import { taskPresentation } from "@/lib/task-presentation";
import type { Project } from "@/lib/projects";
const views=[['','Все'],['running','Выполняются'],['waiting','Ожидают'],['attention','Требуют внимания'],['paused','На паузе'],['completed','Завершены']] as const;
export default function TasksPage(){
 const {tasks,system,loading,error}=useData();const [projects,setProjects]=useState<Project[]>([]),[projectError,setProjectError]=useState('');
 const [query,setQuery]=useState(''),[project,setProject]=useState(''),[view,setView]=useState(''),[initialized,setInitialized]=useState(false);
 useEffect(()=>{const controller=new AbortController();void fetch('/api/projects/',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]),cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();setProjects(await r.json());}).catch(()=>{if(!controller.signal.aborted)setProjectError('Список проектов не загрузился. Обновите страницу, чтобы повторить.');});return()=>controller.abort();},[]);
 useEffect(()=>{const read=()=>{const p=new URLSearchParams(window.location.search);setQuery(p.get('q')||'');setProject(p.get('project')||'');setView(views.some(v=>v[0]===p.get('view'))?p.get('view')||'':p.get('status')==='failed'?'attention':'');setInitialized(true);};read();window.addEventListener('popstate',read);return()=>window.removeEventListener('popstate',read);},[]);
 useEffect(()=>{if(!initialized)return;const p=new URLSearchParams();if(query)p.set('q',query);if(project)p.set('project',project);if(view)p.set('view',view);const next=`/tasks/${p.size?'?'+p:''}`;if(window.location.pathname+window.location.search!==next)window.history.replaceState(null,'',next);},[query,project,view,initialized]);
 const rows=tasks.map(task=>({task,...taskPresentation(task,system)}));
 const matches=(row:typeof rows[number],value:string)=>!value||value==='running'&&row.state.kind==='running'||value==='waiting'&&['waiting','schedule','retry','resources'].includes(row.state.kind)||value==='attention'&&row.attention||value==='paused'&&row.state.kind==='paused'||value==='completed'&&row.state.kind==='completed';
 const scoped=rows.filter(r=>(!project||r.task.projectId===project)&&[taskLabel(r.task),r.task.project?.name||'',r.task.url,...r.task.searchQueries,...r.task.vitalPhrases].join(' ').toLowerCase().includes(query.toLowerCase()));
 const filtered=scoped.filter(r=>matches(r,view)).sort((a,b)=>Date.parse(b.task.createdAt)-Date.parse(a.task.createdAt)).map(r=>r.task);
 const choices=(projects.length?projects:[...new Map(tasks.filter(t=>t.project).map(t=>[t.projectId,t.project!])).values()]).slice().sort((a,b)=>a.name.localeCompare(b.name,'ru',{sensitivity:'base',numeric:true})||a.id.localeCompare(b.id));
 return <><div className="page-heading"><div><div className="eyebrow">УПРАВЛЕНИЕ ВЫПОЛНЕНИЕМ</div><h1>Задачи<span className="heading-dot">.</span></h1><p>Состояния, планы и причины ожидания проектов.</p></div>{choices.length?<CreateTask projects={choices} project={choices.find(p=>p.id===project)}/>:<Button asChild><Link href="/projects/">Создать проект</Link></Button>}</div>
 {(error||projectError)&&<p role="alert" className="form-error mb-4">{error||projectError}</p>}
 <div className="tasks-view-switch" role="group" aria-label="Состояние задач">{views.map(([value,label])=><button key={value} aria-pressed={view===value} onClick={()=>setView(value)}>{label}<span>{loading?'—':scoped.filter(r=>matches(r,value)).length}</span></button>)}</div>
 <div className="task-filters-simple"><div><label className="mb-2 block text-xs text-muted-foreground">Проект</label><AnalyticsProjectPicker projects={choices} value={project} onChange={setProject}/></div><label className="block min-w-0"><span className="mb-2 block text-xs text-muted-foreground">Поиск задач</span><Input aria-label="Поиск задач" placeholder="Название проекта, домен, ключевые слова или фразы" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
 <div className="mb-3 flex items-center justify-between gap-3"><h2>{views.find(v=>v[0]===view)?.[1]||'Все задачи'}</h2><span className="muted-label">Показано: {loading?'—':filtered.length} из {tasks.length}</span></div>
 <TaskProjectGroups tasks={filtered} allTasks={tasks} sort="manual" onManual={()=>{}}/>
 {loading&&<p role="status" className="page-hint">Загрузка задач…</p>}
 {!loading&&tasks.length===0&&<p className="page-hint">Задач пока нет. Создайте задачу для проекта.</p>}
 {filtered.length===0&&!loading&&tasks.length>0&&<p className="page-hint">Измените состояние, проект или поисковый запрос, чтобы увидеть другие задачи.</p>}</>;
}
