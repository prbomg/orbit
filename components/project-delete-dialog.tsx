"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { projectRequest, type Project } from "@/lib/projects";

type DeletionInfo = { name: string; tasks: number; executions: number; visits: number; profileUses: number; profileHistory: number; blocked: boolean };
export function ProjectDeleteDialog({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted: () => void }) {
  const [info, setInfo] = useState<DeletionInfo | null>(null), [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setInfo(null); setError(""); setConfirmation("");
    projectRequest<DeletionInfo>(`/api/projects/${project.id}/?deletion=1`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setInfo(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось проверить проект"); });
    return () => controller.abort();
  }, [project.id, revision]);
  async function remove() {
    if (pending || !info || info.blocked || confirmation !== info.name) return;
    setPending(true); setError("");
    try {
      await projectRequest(`/api/projects/${project.id}/`, { method: "DELETE", body: JSON.stringify({ deleteHistory: true, confirmation }) });
      onDeleted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить проект"); }
    finally { setPending(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}><DialogContent showCloseButton={!pending}>
    <DialogHeader><DialogTitle>Удалить проект «{info?.name ?? project.name}»?</DialogTitle><DialogDescription>Проект, его задачи и связанная история будут удалены без возможности восстановления из панели. Чтобы сохранить историю, используйте архив.</DialogDescription></DialogHeader>
    {!info && !error && <p role="status">Проверяем связанные данные…</p>}
    {info && <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
        <dt>Задачи</dt><dd>{info.tasks}</dd><dt>Попытки выполнения</dt><dd>{info.executions}</dd>
        <dt>Посещения</dt><dd>{info.visits}</dd><dt>Привязки профилей</dt><dd>{info.profileUses}</dd><dt>История профилей</dt><dd>{info.profileHistory}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">Сами профили, их сессии и прокси останутся. Отдельные файлы технических логов не удаляются. Статистика этого проекта исчезнет из панели.</p>
      {info.blocked ? <p role="alert" className="text-sm text-destructive">Остановите проект и дождитесь завершения активных выполнений. Затем обновите проверку.</p> : <label className="grid gap-2 text-sm">Для подтверждения введите название проекта: <strong className="break-all">{info.name}</strong><Input aria-label="Название проекта для удаления" autoComplete="off" value={confirmation} disabled={pending} onChange={e => setConfirmation(e.target.value)}/></label>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" disabled={pending} onClick={onClose}>Отмена</Button>
      {(error || info?.blocked) && <Button variant="outline" disabled={pending} onClick={() => setRevision(v => v + 1)}>Обновить проверку</Button>}
      <Button variant="destructive" disabled={pending || !info || info.blocked || confirmation !== info.name} onClick={() => void remove()}>{pending ? "Удаление…" : "Удалить проект и историю"}</Button>
    </div>
  </DialogContent></Dialog>;
}
