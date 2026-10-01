"use client";
import { useState, type FormEvent } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { projectRequest, type Project } from "@/lib/projects";

export function ProjectEditor({ project, onSaved }: { project?: Project; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError("");
    try {
      await projectRequest(project ? `/api/projects/${project.id}/` : "/api/projects/", {
        method: project ? "PATCH" : "POST",
        body: JSON.stringify({ name: form.get("name"), targetUrl: form.get("targetUrl"), yandexRegionId: form.get("yandexRegionId") }),
      });
      await onSaved(); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить проект"); }
    finally { setPending(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!pending) { setOpen(value); setError(""); } }}>
    <DialogTrigger asChild><Button variant={project ? "outline" : "default"}>{project ? <Pencil size={16} /> : <Plus size={16} />}{project ? "Редактировать" : "Создать проект"}</Button></DialogTrigger>
    <DialogContent showCloseButton={!pending}>
      <DialogHeader><DialogTitle>{project ? "Редактирование проекта" : "Новый проект"}</DialogTitle><DialogDescription>Название, адрес сайта и ID региона.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-2 text-sm"><span>Название проекта</span><Input name="name" required maxLength={100} defaultValue={project?.name} autoComplete="off" /></label>
        <label className="block space-y-2 text-sm"><span>Адрес сайта</span><Input name="targetUrl" type="url" required maxLength={2048} placeholder="https://example.com" defaultValue={project?.targetUrl} /></label>
        <label className="block space-y-2 text-sm"><span>ID региона Яндекса</span><Input name="yandexRegionId" inputMode="numeric" pattern="[1-9][0-9]{0,9}" required maxLength={10} placeholder="213" defaultValue={project?.yandexRegionId} /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Сохранение…" : "Сохранить проект"}</Button>
      </form>
    </DialogContent>
  </Dialog>;
}
