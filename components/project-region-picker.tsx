"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { regionLabel, resolveRegion, searchRegions, type Region } from "@/utils/projectRegions";

export function ProjectRegionPicker({ regionId = "", regionName = "", disabled = false, geolocationRadiusKm }: { regionId?: string; regionName?: string; disabled?: boolean; geolocationRadiusKm?: number }) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const initial = regionId ? resolveRegion(regionId) : null;
  const [value, setValue] = useState(initial?.name ? regionLabel({ yandexRegionId: regionId }) : regionId);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const selected = resolveRegion(value);
  const results = searchRegions(value);
  const savedName = selected?.name || (selected?.id === regionId ? regionName : "");
  useEffect(() => {
    input.current?.setCustomValidity(selected ? "" : "Выберите регион из подсказок или укажите его числовой ID.");
  }, [selected?.id, value]);
  function choose(region: Region) {
    setValue(`${region.name} (${region.id})`);
    setExpanded(false); setActive(-1);
    input.current?.focus();
  }
  return <div className="region-picker space-y-2 text-sm">
    <label htmlFor={id}>Регион Яндекса</label>
    <div className="region-picker-control"><Input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-list`} aria-activedescendant={expanded && active >= 0 && results[active] ? `${id}-option-${active}` : undefined} aria-describedby={`${id}-help`} required disabled={disabled} maxLength={100} autoComplete="off" placeholder="Начните вводить город или регион" value={value}
      onFocus={() => { setExpanded(true); setActive(-1); }}
      onBlur={() => setExpanded(false)}
      onChange={event => { setValue(event.target.value); setExpanded(true); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setExpanded(true);
          setActive(current => !results.length ? -1 : current < 0 ? event.key === "ArrowDown" ? 0 : results.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
        } else if (event.key === "Enter" && expanded && active >= 0 && results[active]) {
          event.preventDefault(); choose(results[active]);
        } else if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      }} />
    <input type="hidden" name="yandexRegionId" value={selected?.id ?? ""} />
    <input type="hidden" name="regionName" value={savedName} />
    {expanded && <div id={`${id}-list`} role="listbox" aria-label="Регионы Яндекса" className="region-picker-options max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-border bg-card p-1 shadow-xl">
      {results.map((region, index) => <div key={region.id} id={`${id}-option-${index}`} role="option" aria-selected={index === active} className={`cursor-pointer rounded-md px-3 py-2 hover:bg-secondary ${index === active ? "bg-secondary" : ""}`} onMouseDown={event => event.preventDefault()} onClick={() => choose(region)}>{region.name} <span className="text-muted-foreground">({region.id})</span></div>)}
      {!results.length && <p className="px-3 py-2 text-muted-foreground">Регион не найден в справочнике. Можно указать его ID.</p>}
    </div>}</div>
    <p id={`${id}-help`} className="text-xs text-muted-foreground">{selected ? selected.name ? `Выбран: ${selected.name} (${selected.id})` : `ID ${selected.id} вне справочника; будет сохранён без изменения.` : "Выберите подсказку или введите полное название. Числовой ID тоже поддерживается."}</p>
    {selected && <p className="text-xs text-muted-foreground">{selected.geolocation ? `Центр для эмуляции: ${selected.geolocation.latitude}, ${selected.geolocation.longitude}; радиус ${geolocationRadiusKm ?? selected.geolocation.radiusKm} км.` : 'В справочнике нет координат этого региона. Для геолокации укажите центр вручную.'}</p>}
  </div>;
}
