"use client";
import Link from "next/link";
import type { Project } from "@/lib/projects";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check, CirclePause, Eye, Globe2, LoaderCircle, Pause, Play, Plus, Trash2, X, Pencil, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Task, type TaskStatus, type TaskInput, type SearchEngine, type SystemState, useData } from "@/lib/data-store";

const statusMap = {
  running: { title: "В очереди", icon: LoaderCircle }, paused: { title: "На паузе", icon: CirclePause },
  completed: { title: "Завершена", icon: Check }, failed: { title: "Ошибка", icon: X },
};
export function StatusBadge({ status, label, tone }: { status: TaskStatus; label?: string; tone?: TaskStatus }) { const item = statusMap[status]; return <Badge variant="outline" className={`status-badge status-${tone ?? status}`}><item.icon size={13} />{label ?? item.title}</Badge>; }
function liveTaskStatus(task: Task, system: SystemState | null): { label: string; tone: TaskStatus; detail: string } | null {
  if (task.status !== "running") return null;
  if (!task.profile.isEnabled || task.profile.status === "banned") return { label: "Профиль недоступен", tone: "paused", detail: "Включите или замените профиль" };
  const run = system?.projectRun;
  if (run?.projectId === task.projectId) {
    if (run.state === "stopping") return { label: "Останавливается", tone: "paused", detail: "Текущая попытка прерывается" };
    if (run.taskId === task.id && run.state === "waiting" && run.errorType === "ProxyCheckError") return { label: "Ожидает прокси", tone: "paused", detail: "Последняя попытка не смогла открыть сайт через прокси" };
    if (run.taskId === task.id && run.state === "waiting") return { label: "Ожидает повтора", tone: "paused", detail: "Исполнитель запущен, следующая попытка позже" };
    if (run.taskId === task.id && run.state === "running" && run.event === "session_started") return { label: "Выполняется", tone: "running", detail: "Браузерная сессия идёт сейчас" };
    if (run.taskId === task.id && run.state === "running") return { label: "Подготовка", tone: "running", detail: "Исполнитель готовит новую сессию" };
    if (run.state === "running" || run.state === "waiting") return { label: "В очереди", tone: "paused", detail: "Исполнитель сейчас обрабатывает другую задачу" };
  }
  return { label: "Ожидает запуска", tone: "paused", detail: "Задача разрешена, исполнитель проекта не запущен" };
}
function TaskRuntimeCell({ task, system }: { task: Task; system: SystemState | null }) {
  const live = liveTaskStatus(task, system);
  return <TableCell className="whitespace-normal"><StatusBadge status={task.status} label={live?.label} tone={live?.tone} />{live?.detail && <p className="mt-1 max-w-52 text-xs text-muted-foreground">{live.detail}</p>}</TableCell>;
}
export const taskDomain = (task: Task) => { try { return task.project ? new URL(task.project.targetUrl).hostname : ""; } catch { return ""; } };
export const taskLabel = (task: Task) => task.taskType === "warmup" ? `Прогрев · ${task.profile.name}` : (task.searchEngine ? taskDomain(task) : task.url) || "Задача";
type Mode = "search" | "direct" | "warmup";
const modes = [{ value: "search", label: "Поиск сайта", description: "Запросы и целевой домен" }, { value: "direct", label: "Прямой URL", description: "Посещение страницы по локальному сценарию" }, { value: "warmup", label: "Прогрев профиля", description: "Обход трёх сайтов" }] as const;
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

export function CreateTask({ task, project, initialMode = "direct", initialProfileId = "" }: { task?: Task; project?: Project; initialMode?: Mode; initialProfileId?: string }) {
  const selectedProject = task?.project ?? project;
  const { saveTask, loading, profiles, pendingIds } = useData();
  const [mode, setMode] = useState<Mode>(task ? task.taskType === "warmup" ? "warmup" : task.searchEngine ? "search" : "direct" : initialMode);
  const [open, setOpen] = useState(false); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const phrases = (name: string) => [...new Set(String(data.get(name) ?? "").split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
    setError("");
    try {
      const searchQueries = mode === "search" ? phrases("searchQueries") : []; const vitalPhrases = mode === "search" ? phrases("vitalPhrases") : [];
      if (mode === "search" && !searchQueries.length) throw new Error("Добавьте хотя бы одну поисковую фразу.");
      if ([searchQueries, vitalPhrases].some(list => list.length > 100 || list.some(item => item.length > 500))) throw new Error("В каждом списке до 100 фраз, каждая до 500 символов.");
      const keywords = mode === "warmup" ? [] : phrases("keywords");
      if (keywords.length > 100 || keywords.some(item => item.length > 200)) throw new Error("До 100 меток по 200 символов.");
      let url = "";
      if (mode === "direct") { const parsed = new URL(String(data.get("url"))); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Введите HTTP(S) URL без авторизации."); url = parsed.href; }
      const input: TaskInput = { taskType: mode === "warmup" ? "warmup" : "target", url, targetKeywords: keywords,
        searchEngine: mode === "search" ? String(data.get("searchEngine")) as SearchEngine : "", searchQueries, vitalPhrases,
        projectId: mode === "warmup" ? null : selectedProject?.id, targetExecutions: Number(data.get("targetExecutions")), profileId: String(data.get("profileId") ?? "") || undefined,
        status: String(data.get("status")) as TaskStatus };
      setSaving(true); await saveTask(input, task?.id); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить задачу"); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!saving) { setOpen(value); setError(""); if (value) setMode(task ? task.taskType === "warmup" ? "warmup" : task.searchEngine ? "search" : "direct" : initialMode); } }}>
    <DialogTrigger asChild>{task ? <Button variant="ghost" size="icon" disabled={pendingIds.has(task.id)} aria-label={`Редактировать ${taskLabel(task)}`} title="Редактировать"><Pencil size={15} /></Button> : <Button disabled={loading} className="primary-button"><Plus size={16} />{initialMode === "warmup" ? "Прогреть" : "Создать задачу"}</Button>}</DialogTrigger>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{task ? "Редактирование задачи" : "Новая задача"}</DialogTitle><DialogDescription>Выберите сценарий и профиль. Все параметры сохраняются в базе.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="space-y-5">
        <fieldset disabled={saving} className="space-y-2"><legend className="mb-2 text-sm font-medium">Сценарий</legend><div className="grid gap-2 sm:grid-cols-3">{modes.filter(item => selectedProject ? item.value !== "warmup" : item.value === "warmup").map(item => <label key={item.value} className={`cursor-pointer rounded-lg border p-3 ${mode === item.value ? "border-primary bg-primary/10" : "border-input"}`}><span className="flex items-center gap-2 text-sm"><input type="radio" name="mode" value={item.value} checked={mode === item.value} onChange={() => setMode(item.value)} className="accent-primary" />{item.label}</span><span className="mt-2 block text-xs text-muted-foreground">{item.description}</span></label>)}</div></fieldset>
        {mode === "search" && <>
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="task-search-engine">Поисковик</Label><select id="task-search-engine" name="searchEngine" defaultValue={task?.searchEngine || "yandex"} disabled={saving} className={selectClass}><option value="yandex">Яндекс (ya.ru)</option><option value="mail">Mail</option><option value="dzen">Дзен</option></select></div><div className="space-y-2"><Label htmlFor="task-target-domain">Целевой домен проекта</Label><Input id="task-target-domain" value={selectedProject ? new URL(selectedProject.targetUrl).hostname : ""} readOnly /><p className="field-help">Меняется в настройках проекта.</p></div></div>
          <div className="space-y-2"><Label htmlFor="task-search-queries">Поисковые фразы</Label><Textarea id="task-search-queries" name="searchQueries" defaultValue={task?.searchQueries.join("\n")} placeholder={"купить товар\nзаказать товар"} required rows={4} maxLength={50100} disabled={saving} /><p className="field-help">Каждая с новой строки. До 100 фраз по 500 символов; пустые строки и дубликаты убираются.</p></div>
          <div className="space-y-2"><Label htmlFor="task-vital-phrases">Витальные фразы</Label><Textarea id="task-vital-phrases" name="vitalPhrases" defaultValue={task?.vitalPhrases.join("\n")} placeholder={"название бренда\nназвание магазина"} rows={3} maxLength={50100} disabled={saving} /><p className="field-help">Необязательно. Уточнение запроса, если цель не найдена после пяти страниц.</p></div>
          <p className="rounded-lg border p-3 text-xs leading-relaxed text-muted-foreground">До пяти страниц выдачи, затем одно уточнение. Посещение найденной цели: 1–5 минут. Успешная задача завершается и сохраняет сессию профиля.</p>
        </>}
        {mode === "direct" && <div className="space-y-2"><Label htmlFor="task-url">URL страницы</Label><Input id="task-url" name="url" type="url" defaultValue={task?.url || selectedProject?.targetUrl} placeholder="https://example.com" required maxLength={2048} disabled={saving} /><p className="field-help">URL по умолчанию берётся из проекта.</p></div>}
        {mode === "warmup" && <p className="rounded-lg border p-3 text-sm leading-relaxed text-muted-foreground">Профиль посетит три случайных сайта из списка доноров. После успешного обхода cookies и localStorage сохраняются; задача завершается.</p>}
        {mode !== "warmup" && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">Метки задачи</summary><div className="mt-3 space-y-2"><Label htmlFor="task-keywords">Метки</Label><Textarea id="task-keywords" name="keywords" rows={2} defaultValue={task?.targetKeywords.join("\n")} placeholder="По одной метке на строку" disabled={saving} /><p className="field-help">Для организации задач. Не влияют на поисковый запрос.</p></div></details>}
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="task-profile">Профиль браузера</Label><select id="task-profile" name="profileId" defaultValue={task?.profileId ?? initialProfileId} disabled={saving} className={selectClass}><option value="">Создать новый профиль</option>{profiles.map(profile => <option key={profile.id} value={profile.id} disabled={(profile.status === "banned" || !profile.isEnabled) && profile.id !== task?.profileId}>{profile.name}{profile.status === "banned" ? " · Заблокирован" : !profile.isEnabled ? " · Выключен" : ""}</option>)}</select><p className="field-help">Выберите существующий для повторного использования сессии.</p></div><div className="space-y-2"><Label htmlFor="task-status">Статус задачи</Label><select id="task-status" name="status" defaultValue={task?.status ?? "running"} disabled={saving} className={selectClass}><option value="running">В очереди на запуск</option><option value="paused">На паузе</option>{task?.status === "completed" && <option value="completed">Завершена</option>}{task?.status === "failed" && <option value="failed">Ошибка</option>}</select><p className="field-help">Задачи запускает отдельный процесс воркера.</p></div></div>
        {mode === "warmup" ? <input type="hidden" name="targetExecutions" value={task?.targetExecutions ?? 1} /> : <div className="space-y-2"><Label htmlFor="task-target-executions">Количество выполнений</Label><Input id="task-target-executions" name="targetExecutions" type="number" min={Math.max(1, task?.currentExecutions ?? 0)} max={10000} step={1} defaultValue={task?.targetExecutions ?? 1} required disabled={saving} /><p className="field-help">{task ? `Уже выполнено: ${task.currentExecutions}. Счётчик обновляется исполнителем.` : "Плановое количество запусков задачи."}</p></div>}
        {selectedProject && <p className="field-help">Проект: {selectedProject.name} · регион {selectedProject.yandexRegionId}</p>}
        {task && <p className="field-help">Изменение параметров текущего запуска отменяет сохранение его результата.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>Отмена</Button><Button type="submit" disabled={saving}>{saving ? "Сохранение…" : task ? "Сохранить изменения" : "Создать задачу"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
export function TaskTable({ tasks }: { tasks: Task[] }) {
  const { toggleTask, removeTask, setTaskStatus, loading, pendingIds, system } = useData();
  return <Table><TableHeader><TableRow><TableHead className="pl-6">Задача / сценарий</TableHead><TableHead>Фразы / профиль</TableHead><TableHead>Статус</TableHead><TableHead>Выполнения</TableHead><TableHead>Создана</TableHead><TableHead className="pr-6 text-right">Действия</TableHead></TableRow></TableHeader>
    <TableBody>{tasks.length ? tasks.map(task => <TableRow key={task.id}>
      <TableCell className="pl-6"><div className="task-name-cell"><span className="site-icon"><Globe2 size={18} /></span><div className="max-w-64 break-words"><strong>{task.taskType === "warmup" ? "Прогрев профиля" : (task.searchEngine ? taskDomain(task) : task.url)}</strong>{task.project && <Link href={`/projects/${task.project.id}/`} className="task-url">{task.project.name}</Link>}<span className="task-url">{task.taskType === "warmup" ? "3 сайта · один обход" : task.searchEngine ? `${task.searchEngine} · поисковый сценарий` : "Прямой URL · локальный сценарий"}</span>{task.url && <a href={task.url} target="_blank" rel="noopener noreferrer" className="task-url">Открыть страницу<ArrowUpRight size={11} /></a>}</div></div></TableCell>
      <TableCell className="max-w-80 whitespace-normal text-sm text-muted-foreground">{task.searchEngine && <details><summary className="cursor-pointer text-foreground">Запросов: {task.searchQueries.length} · витальных: {task.vitalPhrases.length}</summary><div className="mt-2 space-y-2 text-xs"><p className="whitespace-pre-line">{task.searchQueries.join("\n")}</p>{task.vitalPhrases.length > 0 && <p className="whitespace-pre-line">Уточнения: {task.vitalPhrases.join("\n")}</p>}</div></details>}{task.targetKeywords.length > 0 && <p className="mt-1 text-xs">Метки: {task.targetKeywords.join(", ")}</p>}<div className="mt-2 text-xs">{task.profile.name}{!task.profile.isEnabled ? " · Профиль выключен" : ""}</div><div className="mt-1 break-all font-mono text-xs" title="UUID профиля">{task.profileId}</div></TableCell>
      <TaskRuntimeCell task={task} system={system} /><TableCell className="whitespace-normal"><strong className="mono">{task.currentExecutions.toLocaleString("ru-RU")} / {task.targetExecutions.toLocaleString("ru-RU")}</strong><span className="mt-1 block text-xs text-muted-foreground">Выполнено {task.currentExecutions.toLocaleString("ru-RU")} из {task.targetExecutions.toLocaleString("ru-RU")}{task.currentExecutions < task.targetExecutions ? ` · осталось ${task.targetExecutions - task.currentExecutions}` : " · план выполнен"}</span></TableCell><TableCell className="text-sm text-muted-foreground">{new Date(task.createdAt).toLocaleString("ru-RU")}</TableCell>
      <TableCell className="pr-6 text-right"><div className="flex justify-end gap-1">{task.projectId && <Button asChild variant="outline" size="sm"><Link href={`/tasks/${task.id}/live/`} aria-label={`Наблюдать за задачей ${taskLabel(task)}`}><Eye size={15} />Наблюдать</Link></Button>}<CreateTask task={task} />{["running", "paused"].includes(task.status) ? <Button variant="ghost" size="icon" disabled={pendingIds.has(task.id)} onClick={() => void toggleTask(task.id)} aria-label={`${task.status === "running" ? "Приостановить" : "Продолжить"} ${taskLabel(task)}`} title={task.status === "running" ? "Приостановить" : "Продолжить"}>{task.status === "running" ? <Pause size={15} /> : <Play size={15} />}</Button> : <Button variant="ghost" size="icon" disabled={pendingIds.has(task.id) || task.currentExecutions >= task.targetExecutions} onClick={() => void setTaskStatus(task.id, "running").catch(() => {})} aria-label={`Повторить ${taskLabel(task)}`} title={task.currentExecutions >= task.targetExecutions ? "План выполнен; увеличьте количество в редакторе" : "Повторный запуск"}><RotateCcw size={15} /></Button>}<Button variant="ghost" size="icon" disabled={pendingIds.has(task.id)} onClick={() => void removeTask(task.id)} aria-label={`Удалить ${taskLabel(task)}`} title="Удалить задачу"><Trash2 size={15} /></Button></div></TableCell>
    </TableRow>) : <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">{loading ? "Загрузка задач…" : "Нет задач по выбранным условиям."}</TableCell></TableRow>}</TableBody></Table>;
}
