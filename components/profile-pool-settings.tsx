"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { projectRequest as api } from "@/lib/projects";
import { ProjectSchedule } from "@/components/project-schedule";
export type PoolSettings = { warmupPlanPreset?: string; updatedAt: string; autoReplenishEnabled: boolean; minReadyProfiles: number; replenishBatchSize: number; warmupEnabled: boolean; warmupScheduleHours: string; warmupScheduleTimezone: string; warmupScheduleAllowed: boolean; warmupConcurrency: number; warmupSharedProxy: boolean; warmupStageIntervalHours: number; maxPendingProfiles: number; dailyProfileDemand: number; readinessFreshnessHours: number };
const keys = ['warmupPlanPreset','autoReplenishEnabled','minReadyProfiles','replenishBatchSize','warmupEnabled','warmupScheduleHours','warmupScheduleTimezone','warmupConcurrency','warmupSharedProxy','warmupStageIntervalHours','maxPendingProfiles','dailyProfileDemand','readinessFreshnessHours'] as const;
export function ProfilePoolSettings({ config, onSaved }: { config: PoolSettings; onSaved: () => void }) {
  const [draft, setDraft] = useState(config), [base, setBase] = useState(config), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { if (!dirty) { setDraft(config); setBase(config); } }, [config, dirty]);
  const change = (key: keyof PoolSettings, value: number | boolean | string) => { setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setMessage(''); };
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const fields = Object.fromEntries(keys.filter(key => draft[key] !== base[key]).map(key => [key, draft[key]]));
      if (!Object.keys(fields).length) { setDirty(false); return; }
      const next = await api<PoolSettings>('/api/settings/', { method: 'PATCH', body: JSON.stringify({ ...fields, expectedUpdatedAt: base.updatedAt }) });
      setBase(next); setDraft(next); setDirty(false); setMessage('Настройки сохранены. Часы прогрева применяются ко всей очереди. Интервалы между этапами сохраняются у начатых профилей.'); onSaved();
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Ошибка сохранения'); } finally { setBusy(false); }
  }
  const pipeline = Math.ceil(draft.dailyProfileDemand * draft.warmupStageIntervalHours * (draft.warmupPlanPreset === 'storage' ? 0 : ['revisit','navigation'].includes(draft.warmupPlanPreset || '') ? 1 : 6) / 24 * 1.25);
  return <section className="panel"><div className="panel-heading"><div><h2>Запас и сценарий прогрева</h2><p>План определяет обязательные проверки и время подготовки.</p></div></div><form onSubmit={save} className="space-y-5 border-t p-5">
    <div className="space-y-2"><Label htmlFor="warmup-plan">Цель подготовки новых профилей</Label><select id="warmup-plan" className="block w-full rounded-md border bg-background p-2 text-sm" value={draft.warmupPlanPreset || 'standard'} onChange={e=>change('warmupPlanPreset',e.target.value)}><option value="standard">Стандартная подготовка — 6 сессий, 3 сайта</option><option value="storage">Сохранение состояния — 1 сессия, 1 сайт</option><option value="revisit">Повторное посещение — 2 сессии, 1 сайт</option><option value="navigation">Мобильная навигация — 2 сессии, 2 сайта</option></select><p className="text-xs text-muted-foreground">Каждый план включает проверку сохранения после перезапуска. Выбор применяется к новым профилям и явному запуску подготовки заново. Начатые планы сохраняются.</p></div>
    <div className="flex flex-wrap gap-5">{[['autoReplenishEnabled','Автопополнение'],['warmupEnabled','Прогрев включён'],['warmupSharedProxy','Совместная работа на прокси']] .map(([key,label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(draft[key as keyof PoolSettings])} onChange={e => change(key as keyof PoolSettings,e.target.checked)} />{label}</label>)}</div>
    <ProjectSchedule scope="warmup" hours={draft.warmupScheduleHours} timezone={draft.warmupScheduleTimezone} onHours={value => change("warmupScheduleHours", value)} onTimezone={value => change("warmupScheduleTimezone", value)} disabled={busy} />
    <div className="flex flex-wrap items-center gap-2 text-sm"><span>Сценарий:</span><Button type="button" variant={draft.warmupStageIntervalHours === 12 ? 'default':'outline'} onClick={() => change('warmupStageIntervalHours',12)}>72 часа</Button><Button type="button" variant={draft.warmupStageIntervalHours === 8 ? 'default':'outline'} onClick={() => change('warmupStageIntervalHours',8)}>48 часов</Button></div>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{([
      ['minReadyProfiles','Готовых в запасе',1,10000], ['replenishBatchSize','Создавать за один раз',1,1000], ['warmupConcurrency','Потоков прогрева',1,undefined], ['warmupStageIntervalHours','Базовый интервал, часы',8,24], ['maxPendingProfiles','Лимит активной очереди',100,10000], ['dailyProfileDemand','Потребность в сутки',0,10000], ['readinessFreshnessHours','Срок актуальности проверки, часы',1,720]
    ] as const).map(([key,label,min,max]) => <div key={key} className="grid gap-2"><Label htmlFor={key}>{label}</Label><Input id={key} type="number" step={key === 'warmupStageIntervalHours' ? 'any':1} min={min} max={max} required value={draft[key]} onChange={e => change(key,Number(e.target.value))} /></div>)}</div>
    <p className="field-help">План: начало → +{(draft.warmupStageIntervalHours*2/3).toFixed(1)} ч. → +{draft.warmupStageIntervalHours*2} ч. → +{draft.warmupStageIntervalHours*3} ч. → +{draft.warmupStageIntervalHours*4} ч. → +{draft.warmupStageIntervalHours*6} ч. Ожидание не занимает поток. При задержках паузы между сессиями сохраняются.</p>
    <p className="field-help">Рекомендуется в подготовке: {pipeline} профилей — потребность за срок прогрева + 25% на повторы. Готовый запас: {draft.minReadyProfiles}. При потребности 0 автопополнение поддерживает только указанный готовый запас. Лимит относится к активной автоматической очереди; ручная партия показывается отдельно.</p>
    {pipeline > draft.maxPendingProfiles && <p className="text-sm text-amber-300">Лимит очереди меньше расчётной потребности. Увеличьте его, чтобы запас успевал пополняться.</p>}
    <p className="field-help">IP меняется перед группой запусков и сохраняется, пока группа работает. Основные задачи получают канал отдельно. После истечения актуальности выполняется короткая проверка готовности без полного перезапуска.</p>
    {dirty && config.updatedAt !== base.updatedAt && <p role="alert" className="text-sm text-amber-300">Настройки изменились в другой вкладке. Обновите форму перед сохранением.</p>}
    <div className="flex gap-2"><Button disabled={!dirty || busy} type="submit">Сохранить настройки</Button><Button type="button" variant="outline" onClick={() => { setDirty(false); setDraft(config); setBase(config); setMessage(''); }}>Обновить форму</Button></div>{message && <p role="status" className="text-sm">{message}</p>}
  </form></section>;
}
