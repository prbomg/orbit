"use client";
import { useState, type FormEvent } from "react";
import { CalendarClock, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { projectRequest, type Project } from "@/lib/projects";

import { ProjectRegionPicker } from "@/components/project-region-picker";
import { ProjectSchedule } from "@/components/project-schedule";
import { ALL_HOURS, DEFAULT_TIMEZONE } from "@/utils/projectSchedule";

export function ProjectEditor({ project, onSaved, scheduleOnly = false, iconOnly = false }: { project?: Project; scheduleOnly?: boolean; iconOnly?: boolean; onSaved: () => Promise<void> }) {
  const [hours, setHours] = useState(project?.scheduleHours ?? ALL_HOURS);
  const [timezone, setTimezone] = useState(project?.scheduleTimezone ?? DEFAULT_TIMEZONE);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [geoMode, setGeoMode] = useState(project?.geolocation?.mode ?? 'region');
  const regionGeolocation = project && (!project.geolocation || project.geolocation.mode === 'region')
    ? project.geolocation ?? { mode: 'region' as const }
    : { mode: 'region' as const, radiusKm: 5 };
  const regionRadiusKm = regionGeolocation.radiusKm ?? 1;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError("");
    try {
      await projectRequest(project ? `/api/projects/${project.id}/` : "/api/projects/", {
        method: project ? "PATCH" : "POST",
        body: JSON.stringify({ ...(scheduleOnly ? {} : { name: form.get("name"), targetUrl: form.get("targetUrl"), yandexRegionId: form.get("yandexRegionId"), regionName: form.get("regionName"), geolocation: geoMode === 'manual' ? { mode: geoMode, latitude: Number(form.get('geoLatitude')), longitude: Number(form.get('geoLongitude')), radiusKm: Number(form.get('geoRadius')) } : geoMode === 'region' ? regionGeolocation : { mode: geoMode } }), scheduleHours: hours, scheduleTimezone: timezone }),
      });
      await onSaved(); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить проект"); }
    finally { setPending(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!pending) { setOpen(value); setError(""); if (value) { setHours(project?.scheduleHours ?? ALL_HOURS); setTimezone(project?.scheduleTimezone ?? DEFAULT_TIMEZONE); setGeoMode(project?.geolocation?.mode ?? 'region'); } } }}>
    <DialogTrigger asChild><Button variant={iconOnly ? "ghost" : project ? "outline" : "default"} size={iconOnly ? "icon" : "default"} aria-label={iconOnly ? `${scheduleOnly ? "Настроить расписание проекта" : "Редактировать проект"} ${project?.name}` : undefined} title={iconOnly ? scheduleOnly ? "Настроить расписание" : "Редактировать" : undefined}>{scheduleOnly ? <CalendarClock size={16} /> : project ? <Pencil size={16} /> : <Plus size={16} />}{!iconOnly && (scheduleOnly ? "Настроить расписание" : project ? "Редактировать" : "Создать проект")}</Button></DialogTrigger>
    <DialogContent showCloseButton={!pending} className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
      <DialogHeader><DialogTitle>{scheduleOnly ? "Расписание задач проекта" : project ? "Редактирование проекта" : "Новый проект"}</DialogTitle><DialogDescription>Параметры проекта и разрешённое время запуска задач.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="min-w-0 space-y-4">
        {!scheduleOnly && <fieldset disabled={pending} className="space-y-4">
        <label className="block space-y-2 text-sm"><span>Название проекта</span><Input name="name" required maxLength={100} defaultValue={project?.name} autoComplete="off" /></label>
        <label className="block space-y-2 text-sm"><span>Адрес сайта</span><Input name="targetUrl" type="url" required maxLength={2048} placeholder="https://example.com" defaultValue={project?.targetUrl} /></label>
        <ProjectRegionPicker regionId={project?.yandexRegionId} regionName={project?.regionName} disabled={pending} geolocationRadiusKm={geoMode === 'region' ? regionRadiusKm : undefined} />
        <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <label className="block space-y-2"><span>Геолокация браузера</span><select className="w-full rounded-md border border-border bg-background p-2" value={geoMode} onChange={event => setGeoMode(event.target.value as typeof geoMode)}>
            <option value="region">От центра города · радиус {regionRadiusKm} км</option><option value="manual">Задать центр и радиус вручную</option><option value="off">Не задавать координаты</option>
          </select></label>
          {geoMode === 'manual' && <div className="grid gap-3 sm:grid-cols-3">
            <label>Широта<Input name="geoLatitude" type="number" step="any" min={-85} max={85} required defaultValue={project?.geolocation?.mode === 'manual' ? project.geolocation.latitude : undefined} /></label>
            <label>Долгота<Input name="geoLongitude" type="number" step="any" min={-180} max={180} required defaultValue={project?.geolocation?.mode === 'manual' ? project.geolocation.longitude : undefined} /></label>
            <label>Радиус, км<Input name="geoRadius" type="number" step="any" min={0} max={50} required defaultValue={project?.geolocation?.mode === 'manual' ? project.geolocation.radiusKm : 1} /></label>
          </div>}
          <p className="text-xs leading-relaxed text-muted-foreground">{geoMode === 'off' ? 'Координаты браузера не задаются.' : 'Новая точка для каждого выполнения; внутри выполнения координаты постоянны.'}</p>
          {geoMode !== 'off' && <details className="text-xs text-muted-foreground"><summary>О координатах</summary><p className="mt-2 leading-relaxed">Эмуляция с точностью 14–38 м. Радиус задаёт круг вокруг центра, а не границы города. Для регионов без координат укажите центр вручную. Изменения действуют со следующего выполнения.</p></details>}
        </div>
        </fieldset>}
        <ProjectSchedule hours={hours} timezone={timezone} onHours={setHours} onTimezone={setTimezone} disabled={pending} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? "Сохранение…" : scheduleOnly ? "Сохранить расписание" : "Сохранить проект"}</Button>
      </form>
    </DialogContent>
  </Dialog>;
}
