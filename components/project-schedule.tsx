"use client";

import { Fragment, useRef, useId, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { preset, type SchedulePreset } from "@/utils/projectSchedule";

const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const shortcuts: [SchedulePreset, string][] = [
  ["night", "Ежедневно ночью"], ["work", "Рабочее время"], ["day", "Ежедневно днём"], ["weekdays", "Будни"],
  ["weekends", "Выходные"], ["random", "Случайно · 70%"], ["all", "Все часы"], ["clear", "Очистить"],
];

export function ProjectSchedule({ hours, timezone, onHours, onTimezone, disabled, scope = "project" }: {
  hours: string; timezone: string; onHours: (value: string) => void; onTimezone: (value: string) => void; disabled: boolean; scope?: "project" | "warmup";
}) {
  const timezoneId = useId();
  const warmup = scope === "warmup";
  const drag = useRef<{ start: number; initial: string; value: string; pointerId: number } | null>(null);
  const count = [...hours].filter(value => value === "1").length;
  function paint(index: number) {
    const current = drag.current;
    if (!current) return;
    const startDay = Math.floor(current.start / 24), endDay = Math.floor(index / 24);
    const startHour = current.start % 24, endHour = index % 24;
    const next = [...current.initial];
    for (let day = Math.min(startDay, endDay); day <= Math.max(startDay, endDay); day++) {
      for (let hour = Math.min(startHour, endHour); hour <= Math.max(startHour, endHour); hour++) next[day * 24 + hour] = current.value;
    }
    onHours(next.join(""));
  }
  function cellAt(event: PointerEvent<HTMLDivElement>) {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-schedule-cell]");
    return cell && event.currentTarget.contains(cell) ? Number(cell.dataset.scheduleCell) : null;
  }
  return <fieldset disabled={disabled} className="min-w-0 space-y-4">
    <legend className="mb-2 text-sm font-medium">{warmup ? "Расписание прогрева профилей" : "Время выполнения задач"}</legend>
    <p className="text-xs leading-relaxed text-muted-foreground">{warmup ? "Зелёные ячейки разрешают начало новых сеансов прогрева всех профилей." : "Зелёные ячейки разрешают начало новых выполнений всех задач проекта."} Нажмите на ячейку или выделите прямоугольник, удерживая мышь. Начните с зелёной ячейки, чтобы снять выделение.</p>
    <div className="flex flex-wrap gap-2">{shortcuts.map(([name, label]) => <Button key={name} type="button" size="sm" variant="outline" onClick={() => onHours(preset(name))}>{label}</Button>)}</div>
    <p className="text-xs text-muted-foreground">«Ежедневно ночью» — все дни, 20:00–08:00. «Рабочее время» — пн–пт, 08:00–20:00. «Ежедневно днём» — все дни, 08:00–20:00.</p>
    <div className="max-w-full overflow-x-auto rounded-lg border border-border p-2">
      <div className="grid min-w-[760px] select-none gap-1" style={{ gridTemplateColumns: "2rem repeat(24, minmax(0, 1fr))" }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          const index = cellAt(event);
          if (index === null) return;
          event.preventDefault();
          (event.target as HTMLElement).focus({ preventScroll: true });
          drag.current = { start: index, initial: hours, value: hours[index] === "1" ? "0" : "1", pointerId: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
          paint(index);
        }}
        onPointerMove={event => { if (!drag.current || drag.current.pointerId !== event.pointerId) return; const index = cellAt(event); if (index !== null) paint(index); }}
        onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
        <span aria-hidden="true" />{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="pb-1 text-center font-mono text-[11px] text-muted-foreground">{hour}</span>)}
        {days.map((day, dayIndex) => <Fragment key={day}>
          <span className="flex items-center text-xs text-muted-foreground">{day}</span>
          {Array.from({ length: 24 }, (_, hour) => {
            const index = dayIndex * 24 + hour, selected = hours[index] === "1";
            const label = `${day}, ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`;
            return <button key={hour} type="button" data-schedule-cell={index} aria-label={label} aria-pressed={selected} title={label}
              className={`h-7 touch-none rounded-sm border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${selected ? "border-emerald-500/60 bg-emerald-500/70 hover:bg-emerald-400/80" : "border-border bg-muted/30 hover:bg-muted"}`}
              onClick={event => { if (event.detail === 0) onHours(hours.slice(0, index) + (selected ? "0" : "1") + hours.slice(index + 1)); }} />;
          })}
        </Fragment>)}
      </div>
    </div>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <p className="text-sm" aria-live="polite">Выбрано <strong>{count}</strong> из 168 часов в неделю{count === 0 && <span className="mt-1 block text-amber-300">Новые выполнения не будут запускаться.</span>}</p>
      <label className="block w-full space-y-1 text-xs sm:w-64"><span>Часовой пояс</span><Input required maxLength={100} value={timezone} onChange={event => onTimezone(event.target.value)} list={timezoneId} placeholder="Europe/Moscow" aria-label="Часовой пояс" /><datalist id={timezoneId}>{["Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Omsk", "Asia/Krasnoyarsk", "Asia/Irkutsk", "Asia/Yakutsk", "Asia/Vladivostok", "Asia/Magadan", "Asia/Kamchatka", "UTC"].map(zone => <option key={zone} value={zone} />)}</datalist></label>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{warmup ? "Время указано в выбранном часовом поясе. Уже начатые сеансы завершаются, новые ждут разрешённого часа. Расписание действует на всю очередь, включая следующие этапы и повторные попытки. Общая и индивидуальная паузы сохраняются. Для полного разделения с заданиями оставьте запас времени между окнами. Ограничение часов может увеличить общий срок прогрева." : "Время указано в выбранном часовом поясе. Уже начатые сеансы завершаются. Исполнитель ждёт следующего разрешённого часа автоматически; задачи на паузе остаются на паузе. Прогрев профилей работает по своим настройкам."}</p>
  </fieldset>;
}
