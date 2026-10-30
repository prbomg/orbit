"use client";

import { useState } from "react";
import { Plus, Trash2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProxyTcpEditor } from "@/components/proxy-tcp-editor";
import { ProxyEditor } from "@/components/proxy-editor";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ProxyInput, useData } from "@/lib/data-store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProxyRotationEditor } from "@/components/proxy-rotation-editor";

export default function ProxiesPage() {
  const { proxies, addProxies, removeProxy, toggleProxy, pendingIds, loading } = useData();
  const [importOpen, setImportOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const filtered = proxies.filter(proxy => (!status || (status === "active" ? proxy.isActive : !proxy.isActive)) && `${proxy.host}:${proxy.port} ${proxy.username}`.toLowerCase().includes(query.toLowerCase()));
  const [raw, setRaw] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  async function importProxies() {
    const lines = raw.split(/\r?\n/);
    const items: ProxyInput[] = [];
    const issues: string[] = [];
    const seen = new Set(proxies.map(p => `${p.host}:${p.port}:${p.username}`));
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      // Preserve colons in a password; this input format uses IPv4 addresses.
      const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+):([^:\s]+):(.+)$/.exec(line.trim());
      if (!match || match[1].split(".").some(part => Number(part) > 255) || Number(match[2]) < 1 || Number(match[2]) > 65535) {
        issues.push(`Строка ${index + 1}: ожидается IPv4:port:user:pass, порт от 1 до 65535.`); return;
      }
      const [, host, port, username, password] = match;
      const identity = `${host}:${Number(port)}:${username}`;
      if (seen.has(identity)) { issues.push(`Строка ${index + 1}: такой прокси уже добавлен.`); return; }
      seen.add(identity);
      items.push({ host, port: Number(port), username, password, isActive: true, rotationUrl: null });
    });
    if (!items.length && !issues.length) issues.push("Добавьте хотя бы одну строку с прокси.");
    setErrors(issues); setMessage("");
    // Atomic import avoids accidentally re-importing a partially accepted batch.
    if (issues.length) return;
    setSaving(true);
    try { await addProxies(items); setRaw(""); setMessage(`Сохранено прокси: ${items.length}.`); setImportOpen(false); }
    catch (cause) { setErrors([cause instanceof Error ? cause.message : "Не удалось сохранить прокси"]); }
    finally { setSaving(false); }
  }
  return <><div className="page-heading"><div><div className="eyebrow">СЕТЕВЫЕ РЕСУРСЫ</div><h1>Прокси<span className="heading-dot">.</span></h1><p>Один пул для всех ваших браузерных задач.</p></div><div className="flex flex-wrap items-center gap-3"><Button onClick={() => setImportOpen(true)}><Plus size={16} />Добавить прокси</Button></div></div>
    {message && <p role="status" className="mb-4 text-sm text-primary">{message}</p>}
    <div className="resource-toolbar proxy-filters"><Input aria-label="Поиск прокси" placeholder="Адрес, порт или логин" value={query} onChange={event => setQuery(event.target.value)} /><select className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Статус прокси" value={status} onChange={event => setStatus(event.target.value)}><option value="">Все прокси</option><option value="active">Включены</option><option value="disabled">Отключены</option></select><span className="text-sm text-muted-foreground">Включены <strong className="text-foreground">{proxies.filter(proxy => proxy.isActive).length}</strong> из {proxies.length}</span></div>
    <Dialog open={importOpen} onOpenChange={open => { if (!saving) setImportOpen(open); }}><DialogContent className="max-h-[85dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl" showCloseButton={!saving}><DialogHeader><DialogTitle>Добавить прокси</DialogTitle><DialogDescription>Вставьте IP:порт:логин:пароль. Можно добавить один прокси или список — по одному на строку.</DialogDescription></DialogHeader><div className="min-w-0"><Label htmlFor="proxy-list" className="mb-3 block">Список прокси <span className="mono text-muted-foreground">ip:port:user:pass</span></Label><Textarea disabled={saving} id="proxy-list" value={raw} onChange={e => { setRaw(e.target.value); setErrors([]); setMessage(""); }} placeholder={'192.0.2.10:8000:username:password\n198.51.100.20:8080:username:password'} className="min-h-40 min-w-0 max-w-full resize-y font-mono text-sm [field-sizing:fixed]" spellCheck={false} autoCapitalize="none" autoCorrect="off" autoComplete="off" /><p className="field-help mt-3">Ссылку смены IP можно задать отдельно для каждого прокси в списке после добавления.</p>{errors.length > 0 && <div role="alert" className="form-error mt-3"><p>Исправьте строки перед импортом:</p><ul className="mt-1 list-disc pl-5">{errors.map(error => <li key={error}>{error}</li>)}</ul></div>}{message && <p role="status" className="mt-3 text-sm text-primary">{message}</p>}<div className="import-actions"><span>IPv4 · HTTP(S) · авторизация</span><Button disabled={saving || loading} onClick={() => void importProxies()}><PlusIcon />{saving ? "Сохранение…" : "Добавить прокси"}</Button></div></div></DialogContent></Dialog>

    <section className="panel table-panel proxy-list"><div className="panel-heading"><div className="flex items-center gap-3"><h2>Ваши прокси</h2><span className="count-pill">{filtered.length}</span></div><span className="muted-label">Статус включения в пул</span></div><Table className="proxy-table"><TableHeader><TableRow><TableHead className="pl-6">Адрес / порт</TableHead><TableHead>Статус</TableHead><TableHead>Смена IP</TableHead><TableHead>TCP-пресет</TableHead><TableHead className="pr-6 text-right"><span className="sr-only">Действия</span></TableHead></TableRow></TableHeader><TableBody>{filtered.map(proxy => <TableRow key={proxy.id}><TableCell className="pl-6"><span className="mono">{proxy.host}<span className="text-muted-foreground">:{proxy.port}</span></span><span className="mt-1 block text-xs text-muted-foreground">{proxy.username}</span></TableCell><TableCell data-label="Состояние"><Badge variant="outline" className={`status-badge ${proxy.isActive ? "status-running" : "status-paused"}`}>{proxy.isActive ? "Включён" : "Отключён"}</Badge></TableCell><TableCell data-label="Смена IP"><ProxyRotationEditor proxy={proxy} /></TableCell><TableCell data-label="TCP-пресет"><ProxyTcpEditor proxy={proxy} /></TableCell><TableCell className="proxy-actions-cell"><div className="resource-actions"><ProxyEditor proxy={proxy} /><Button variant="ghost" size="icon" disabled={pendingIds.has(proxy.id)} onClick={() => void toggleProxy(proxy.id)} title={proxy.isActive ? "Отключить прокси" : "Включить прокси"} aria-label={`${proxy.isActive ? "Отключить" : "Включить"} прокси ${proxy.host}:${proxy.port}`}>{proxy.isActive ? <Pause size={15} /> : <Play size={15} />}</Button><Button variant="ghost" size="icon" disabled={pendingIds.has(proxy.id)} onClick={() => void removeProxy(proxy.id)} aria-label={`Удалить прокси ${proxy.host}:${proxy.port}`} title="Удалить прокси"><Trash2 size={15} /></Button></div></TableCell></TableRow>)}{filtered.length === 0 && <TableRow><TableCell colSpan={5} className="resource-empty">{loading ? "Загрузка прокси…" : proxies.length ? "Нет прокси по выбранным условиям." : "Пул пуст. Добавьте прокси одной строкой или вставьте список."}</TableCell></TableRow>}</TableBody></Table></section>
  </>;
}
function PlusIcon() { return <span aria-hidden="true" className="text-lg leading-none">+</span>; }
