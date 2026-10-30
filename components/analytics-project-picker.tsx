"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type ProjectOption = { id: string; name: string; archivedAt: string | null };
export function AnalyticsProjectPicker({ projects, value, onChange }: { projects: ProjectOption[]; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(-1);
  const id = useId(), list = useRef<HTMLDivElement>(null);
  const selected = projects.find(project => project.id === value);
  const label = selected ? `${selected.name}${selected.archivedAt ? ' · архив' : ''}` : value ? 'Выбранный проект' : 'Все проекты';
  const options = [{ id: '', name: 'Все проекты', archivedAt: null }, ...[...projects].sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true }))].filter(project => project.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  useEffect(() => { if (active >= 0) list.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  function choose(next: string) { onChange(next); setOpen(false); }
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); setQuery(''); setActive(-1); }}>
    <Popover.Trigger asChild><Button id={`${id}-trigger`} type="button" variant="outline" className="w-full min-w-0 justify-between gap-2 font-normal" aria-label={`Выбрать проект: ${label}`} title={label}><span className="truncate">{label}</span><ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}/></Button></Popover.Trigger>
    <Popover.Portal><Popover.Content align="start" sideOffset={6} collisionPadding={16} aria-label="Выбор проекта" className="z-50 flex w-[var(--radix-popover-trigger-width)] min-w-0 max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl" style={{ maxHeight: 'min(380px, var(--radix-popover-content-available-height))' }}>
      <div className="relative shrink-0 border-b border-border p-2"><Search size={15} className="pointer-events-none absolute left-5 top-5 text-muted-foreground"/><Input role="combobox" aria-label="Поиск проекта" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list" aria-activedescendant={active >= 0 && options[active] ? `${id}-option-${active}` : undefined} className="pl-9" placeholder="Найти проект…" value={query} onChange={event => { setQuery(event.target.value); setActive(-1); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => !options.length ? -1 : index < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); }
        else if (event.key === 'Enter' && active >= 0 && options[active]) { event.preventDefault(); choose(options[active].id); }
      }}/></div>
      <div ref={list} id={`${id}-options`} role="listbox" aria-label="Проекты" className="min-h-0 overflow-y-auto overscroll-contain p-1">
        {options.map((project, index) => <button key={project.id} type="button" role="option" aria-selected={project.id === value} id={`${id}-option-${index}`} data-option-index={index} tabIndex={-1} className={`flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-secondary ${active === index ? 'bg-secondary' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => choose(project.id)}><Check size={15} className={`mt-0.5 shrink-0 ${project.id === value ? 'text-primary' : 'invisible'}`}/><span className="min-w-0 break-words [overflow-wrap:anywhere]">{project.name}{project.archivedAt && <span className="text-xs text-muted-foreground"> · архив</span>}</span></button>)}
        {!options.length && <p role="status" className="px-3 py-5 text-sm text-muted-foreground">Проекты не найдены.</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
