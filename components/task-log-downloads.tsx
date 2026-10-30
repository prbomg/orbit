"use client";
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
type Attempt = { id: string; status: string; dropped: number; expiredAt?: string; parts: { name: string; bytes: number }[] };
function localInput(date: Date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
export function TaskLogDownloads({ taskId, executionId, startedAt }: { taskId: string; executionId: string | null; startedAt: string | null }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null), [part, setPart] = useState('');
  const [notice, setNotice] = useState(''), [loading, setLoading] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => { setFrom(localInput(new Date(Date.now() - 7 * 86400000))); setTo(localInput(new Date())); }, []);
  const base = `/api/tasks/${encodeURIComponent(taskId)}/tech-log/`;
  useEffect(() => {
    setAttempt(null); setPart(''); setNotice('');
    if (!executionId || !startedAt) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const q = new URLSearchParams({ format: 'index', executionId, startedAt });
        const response = await fetch(`${base}?${q}`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json(); if (!response.ok) throw Error(data.error || 'Не удалось загрузить список логов');
        const current = data.attempts[0] || null;
        setAttempt(current); setPart(old => current?.parts.some((p: { name: string }) => p.name === old) ? old : current?.parts[0]?.name || '');
        setNotice(current ? current.parts.length ? '' : 'Подробный лог удалён по сроку хранения или лимиту объёма.' : 'Лог ещё не записан либо попытка была до введения новой политики.');
      } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Не удалось загрузить логи'); }
    };
    void load(); const timer = setInterval(() => { void load(); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [base, executionId, startedAt]);
  const params = new URLSearchParams({ attemptId: attempt?.id || '', part });
  const archive = async () => {
    const begin = new Date(from), end = new Date(to);
    if (!Number.isFinite(begin.getTime()) || !Number.isFinite(end.getTime()) || begin >= end || end.getTime() - begin.getTime() > 90 * 86400000) { setNotice('Задайте период не более 90 дней, от ранней даты к поздней.'); return; }
    setLoading(true); setNotice('');
    const query = new URLSearchParams({ format: 'zip', from: begin.toISOString(), to: end.toISOString() });
    try {
      const check = new URLSearchParams(query); check.set('format', 'index');
      const response = await fetch(`${base}?${check}`, { cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Не удалось проверить архив');
      if (!data.attempts.length) throw Error('За выбранный период нет сохранённых логов.');
      // Download manager streams ZIP; no whole-archive blob in browser RAM.
      const link = document.createElement('a'); link.href = `${base}?${query}`; link.download = `task-${taskId}-history.zip`; link.click();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось скачать архив'); }
    finally { setLoading(false); }
  };
  return <div className="my-3 rounded-lg border border-border p-3 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      {attempt && attempt.parts.length > 1 && <select aria-label="Часть технического лога" className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm" value={part} onChange={e => setPart(e.target.value)}>{attempt.parts.map((p,i) => <option key={p.name} value={p.name}>Часть {i+1} из {attempt.parts.length} · {Math.ceil(p.bytes/1024)} КиБ</option>)}</select>}
      {attempt && part ? <Button asChild variant="outline" size="sm"><a href={`${base}?${params}`} download><Download size={15}/>Скачать лог (.txt)</a></Button> : <Button variant="outline" size="sm" disabled><Download size={15}/>Скачать лог (.txt)</Button>}
      {attempt && attempt.parts.length > 1 && <Button asChild variant="outline" size="sm"><a href={`${base}?format=zip&attemptId=${encodeURIComponent(attempt.id)}`} download>Все части попытки (.zip)</a></Button>}
      <span className="text-xs text-muted-foreground">Выбранная попытка · части до 64 КиБ</span>
    </div>
    <details><summary className="cursor-pointer text-sm">Скачать историю за период</summary><div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="text-xs min-w-0">С<Input type="datetime-local" aria-label="Начало периода логов" value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label className="text-xs min-w-0">До<Input type="datetime-local" aria-label="Конец периода логов" value={to} onChange={e=>setTo(e.target.value)}/></label>
      <Button variant="outline" size="sm" disabled={loading} onClick={()=>void archive()}><Download size={15}/>Скачать историю (.zip)</Button>
    </div><p className="mt-2 text-xs text-muted-foreground">Время вашего браузера. До 90 дней. Архив содержит доступные части и сводку попыток, пересекающих период.</p></details>
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {!!attempt?.dropped && <p role="status" className="text-xs text-amber-500">Часть событий не записана из-за лимита хранения или очереди. Пропущено: {attempt.dropped}.</p>}
    <p className="text-xs text-muted-foreground">Подробности: успехи — 7 дней, ошибки — 30 дней; общий лимит технических логов — 2 ГБ. Старые детали могут удаляться раньше при заполнении лимита.</p>
  </div>;
}
