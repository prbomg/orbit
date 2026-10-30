"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ReleaseInfo, ReleaseList } from "@/utils/releaseManager";

function formatBytes(value: number | null) {
  if (value == null) return "Измеряется…";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"]; let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[index]}`;
}
const date = (value: string) => new Date(value).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
function status(row: ReleaseInfo) {
  if (row.reasons.includes("current")) return "Текущий релиз";
  if (row.reasons.includes("in_use")) return "Используется процессом";
  if (row.reasons.includes("preparing")) return "Подготавливается";
  if (row.reasons.includes("storage")) return "Используется для хранения данных";
  if (row.protected) return "Защищён от удаления";
  return "Можно удалить";
}
export function ReleaseManagerPanel() {
  const [data, setData] = useState<ReleaseList | null>(null), [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ReleaseInfo[] | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null), seenCompleted = useRef<Set<string>>(new Set());
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const response = await fetch("/api/system/releases/", { cache: "no-store", signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Не удалось загрузить список релизов");
      if (controller.signal.aborted || request.current !== controller) return;
      const value = result as ReleaseList; setData(value);
      setSelected(previous => new Set([...previous].filter(id => value.releases.some(row => row.id === id && !row.protected))));
      for (const job of value.deletions.filter(job => job.status === "completed")) if (!seenCompleted.current.has(job.id)) {
        seenCompleted.current.add(job.id); window.dispatchEvent(new Event("orbit-storage-changed"));
      }
      setError("");
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось загрузить список релизов"); }
    finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }, []);
  useEffect(() => { void refresh(); return () => { request.current?.abort(); request.current = null; }; }, [refresh]);
  const updating = data?.sizesPending || data?.deletions.some(job => job.status === "deleting");
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, updating ? 3000 : 30000);
    return () => clearInterval(timer);
  }, [updating, refresh]);
  const rank = (row: ReleaseInfo) => row.reasons.includes("current") ? 0 : row.protected ? 1 : 2;
  const releases = [...(data?.releases ?? [])].sort((a, b) => rank(a) - rank(b));
  const candidates = data?.releases.filter(row => !row.protected) ?? [];
  const chosen = data?.releases.filter(row => selected.has(row.id) && !row.protected) ?? [];
  const allSelected = candidates.length > 0 && candidates.every(row => selected.has(row.id));
  async function submit(rows: ReleaseInfo[]) {
    request.current?.abort(); request.current = null; setLoading(false);
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/system/releases/", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ releases: rows.map(row => ({ id: row.id, revision: row.revision })) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Не удалось начать удаление");
      setData(previous => previous ? { ...previous, releases: previous.releases.filter(row => !rows.some(selected => selected.id === row.id)), deletions: [result, ...previous.deletions.filter(job => job.id !== result.id)] } : previous);
      setSelected(new Set()); setConfirm(null); setNotice("Удаление началось. Прогресс показан ниже."); await refresh();
    } catch (cause) { setConfirm(null); setError(cause instanceof Error ? cause.message : "Не удалось начать удаление"); }
    finally { setBusy(false); }
  }
  async function retry(jobId: string) {
    request.current?.abort(); request.current = null; setLoading(false);
    setBusy(true); setError("");
    try { const response = await fetch("/api/system/releases/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry", jobId }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "Не удалось повторить удаление"); setData(previous => previous ? { ...previous, deletions: previous.deletions.map(job => job.id === jobId ? result : job) } : previous); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось повторить удаление"); }
    finally { setBusy(false); }
  }
  const total = chosen.every(row => row.bytes !== null) ? chosen.reduce((sum, row) => sum + (row.bytes || 0), 0) : null;
  return <section className="panel mb-6" aria-label="Сохранённые релизы">
    <div className="panel-heading flex flex-wrap items-center justify-between gap-3"><div><h2>Сохранённые релизы</h2><p>Текущая версия, используемые релизы и очистка старых файлов</p></div><Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />Обновить релизы</Button></div>
    <div className="border-t px-6 py-4 text-sm text-muted-foreground">Текущая версия и релизы, которые используют работающие процессы, защищены от удаления. Старые версии нужны для отката.</div>
    {error && <p role="alert" className="px-6 pb-4 text-sm text-amber-300">{error}</p>}{notice && <p role="status" className="px-6 pb-4 text-sm text-primary">{notice}</p>}
    {!data ? <p className="px-6 pb-6 text-sm text-muted-foreground">{loading ? "Загружаем список релизов…" : "Список пока недоступен"}</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Выбрать все доступные релизы" checked={allSelected} disabled={busy || !candidates.length} onChange={event => setSelected(event.target.checked ? new Set(candidates.map(row => row.id)) : new Set())} />Выбрать доступные</label><Button variant="destructive" disabled={busy || !chosen.length} onClick={() => setConfirm(chosen)}><Trash2 size={15} />Удалить выбранные ({chosen.length})</Button></div>
      <div className="max-h-[32rem] overflow-y-auto border-t px-6"><ul className="divide-y divide-border">{releases.map(row => <li key={row.id} className={`flex items-start gap-3 py-4 ${row.reasons.includes("current") ? "release-current" : ""}`}>
        <input type="checkbox" className="mt-1" aria-label={`Выбрать ${row.id}`} checked={selected.has(row.id)} disabled={busy || row.protected} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; })} />
        <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{row.id}</p><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{row.dateSource === "created" ? "Сохранён" : "Изменён"}: {date(row.savedAt)}</span><span>{formatBytes(row.bytes)}</span></div><p className={`mt-1 text-xs ${row.protected ? "text-primary" : "text-muted-foreground"}`}><span className={`release-state ${row.protected ? "release-state-protected" : ""}`}>{status(row)}</span></p></div>
      </li>)}</ul>{!data.releases.length && <p className="py-4 text-sm text-muted-foreground">Сохранённых релизов нет.</p>}</div>
      <div className="border-t px-6 py-4 text-xs text-muted-foreground">Всего: {data.releases.length}. Выбрано: {chosen.length}{chosen.length > 0 && total !== null ? ` · ${formatBytes(total)}` : ""}. Размер файлов уточняется автоматически.</div>
      {data.deletions.length > 0 && <div className="space-y-3 border-t px-6 py-4">{data.deletions.slice(0, 5).map(job => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 text-sm"><div><p>{job.status === "deleting" ? "Удаление релизов" : job.status === "completed" ? "Удаление завершено" : "Удаление не завершено"}: {job.done} из {job.total}</p>{job.error && <p className="mt-1 text-xs text-amber-300">{job.error}</p>}<p className="mt-1 text-xs text-muted-foreground">{date(job.createdAt)}</p></div>{job.status === "deleting" && <LoaderCircle size={16} className="animate-spin" />}{job.status === "failed" && <Button variant="outline" disabled={busy} onClick={() => void retry(job.id)}>Повторить очистку</Button>}</div>)}</div>}
    </>}
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !busy) setConfirm(null); }}><DialogContent><DialogHeader><DialogTitle>Удалить выбранные релизы?</DialogTitle><DialogDescription>Файлы этих версий будут удалены без возможности восстановления. Для отката к ним потребуется повторная загрузка.</DialogDescription></DialogHeader><ul className="max-h-52 overflow-y-auto text-sm">{confirm?.map(row => <li key={row.id} className="break-all py-1">{row.id}</li>)}</ul><p className="text-sm">Релизов: {confirm?.length}{confirm?.every(row => row.bytes !== null) ? ` · ${formatBytes(confirm.reduce((sum, row) => sum + (row.bytes || 0), 0))}` : ""}</p><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Отмена</Button><Button variant="destructive" disabled={busy} onClick={() => { if (confirm) void submit(confirm); }}>{busy && <LoaderCircle size={15} className="animate-spin" />}Подтвердить удаление</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
