"use client";

import { useState } from "react";
import { ArrowDownToLine, Network, ShieldCheck, Trash2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProxyEditor } from "@/components/proxy-editor";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ProxyInput, useData } from "@/lib/data-store";
import { ProxyRotationEditor } from "@/components/proxy-rotation-editor";

export default function ProxiesPage() {
  const { proxies, addProxies, removeProxy, toggleProxy, pendingIds, loading } = useData();
  const [rotationUrl, setRotationUrl] = useState("");
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
      items.push({ host, port: Number(port), username, password, isActive: true, rotationUrl: rotationUrl.trim() || null });
    });
    if (!items.length && !issues.length) issues.push("Добавьте хотя бы одну строку с прокси.");
    setErrors(issues); setMessage("");
    // Atomic import avoids accidentally re-importing a partially accepted batch.
    if (issues.length) return;
    setSaving(true);
    try { await addProxies(items); setRaw(""); setRotationUrl(""); setMessage(`Сохранено прокси: ${items.length}.`); }
    catch (cause) { setErrors([cause instanceof Error ? cause.message : "Не удалось сохранить прокси"]); }
    finally { setSaving(false); }
  }
  return <><div className="page-heading"><div><div className="eyebrow">СЕТЕВЫЕ РЕСУРСЫ</div><h1>Прокси<span className="heading-dot">.</span></h1><p>Один пул для всех ваших браузерных задач.</p></div><div className="flex flex-wrap items-center gap-3"><ProxyEditor /><span className="resource-count"><Network size={16} />{proxies.length} в пуле</span></div></div>
    <section className="panel import-panel"><div className="panel-heading"><div><h2>Массовая загрузка</h2><p>Добавьте список прокси — по одному на строку.</p></div><ArrowDownToLine size={20} className="text-muted-foreground" /></div><div className="import-body"><div><Label htmlFor="proxy-list" className="mb-3 block">Список прокси <span className="mono text-muted-foreground">ip:port:user:pass</span></Label><Textarea disabled={saving} id="proxy-list" value={raw} onChange={e => { setRaw(e.target.value); setErrors([]); setMessage(""); }} placeholder={'192.0.2.10:8000:username:password\n198.51.100.20:8080:username:password'} className="min-h-40 resize-y font-mono text-sm" spellCheck={false} /><div className="mt-5 space-y-2"><Label htmlFor="batch-rotation-url">Ссылка смены IP для импортируемых прокси</Label><Input id="batch-rotation-url" type="password" autoComplete="off" value={rotationUrl} disabled={saving} onChange={event => setRotationUrl(event.target.value)} placeholder="https://provider.example/rotate?key=…" maxLength={2048} /><p className="field-help">Необязательно. Применяется ко всем прокси в этом импорте. Для отдельных ссылок используйте редактирование прокси.</p></div>{errors.length > 0 && <div role="alert" className="form-error mt-3"><p>Исправьте строки перед импортом:</p><ul className="mt-1 list-disc pl-5">{errors.map(error => <li key={error}>{error}</li>)}</ul></div>}{message && <p role="status" className="mt-3 text-sm text-primary">{message}</p>}<div className="import-actions"><span>IPv4 · HTTP(S) · авторизация</span><Button disabled={saving || loading} onClick={() => void importProxies()}><PlusIcon />{saving ? "Сохранение…" : "Добавить прокси"}</Button></div></div><aside className="import-note"><ShieldCheck size={22} /><h3>Всё начинается с соединения</h3><p>Загрузите адрес, порт и учётные данные от вашего провайдера.</p><p>Учётные данные сохраняются в базе. Активность прокси управляется вручную; соединение не проверяется.</p></aside></div></section>
    <section className="panel table-panel"><div className="panel-heading"><div className="flex items-center gap-3"><h2>Ваши прокси</h2><span className="count-pill">{proxies.length}</span></div><span className="muted-label">Пароли скрыты</span></div><Table><TableHeader><TableRow><TableHead className="pl-6">Адрес / порт</TableHead><TableHead>Логин</TableHead><TableHead>Статус</TableHead><TableHead>Ссылка смены IP</TableHead><TableHead className="pr-6 text-right"><span className="sr-only">Удалить</span></TableHead></TableRow></TableHeader><TableBody>{proxies.map(proxy => <TableRow key={proxy.id}><TableCell className="pl-6"><span className="mono">{proxy.host}<span className="text-muted-foreground">:{proxy.port}</span></span></TableCell><TableCell className="text-muted-foreground">{proxy.username}</TableCell><TableCell><Badge variant="outline" className={`status-badge ${proxy.isActive ? "status-completed" : "status-paused"}`}>{proxy.isActive ? "Активен" : "Отключён"}</Badge></TableCell><TableCell><ProxyRotationEditor proxy={proxy} /></TableCell><TableCell className="pr-6 text-right"><ProxyEditor proxy={proxy} /><Button variant="ghost" size="icon" disabled={pendingIds.has(proxy.id)} onClick={() => void toggleProxy(proxy.id)} aria-label={`${proxy.isActive ? "Отключить" : "Включить"} прокси ${proxy.host}:${proxy.port}`}>{proxy.isActive ? <Pause size={15} /> : <Play size={15} />}</Button><Button variant="ghost" size="icon" disabled={pendingIds.has(proxy.id)} onClick={() => void removeProxy(proxy.id)} aria-label={`Удалить прокси ${proxy.host}:${proxy.port}`} title="Удалить прокси"><Trash2 size={15} /></Button></TableCell></TableRow>)}{proxies.length === 0 && <TableRow><TableCell colSpan={5} className="py-12 text-center text-muted-foreground">{loading ? "Загрузка прокси…" : "Пул пуст. Добавьте прокси выше."}</TableCell></TableRow>}</TableBody></Table></section>
  </>;
}
function PlusIcon() { return <span aria-hidden="true" className="text-lg leading-none">+</span>; }
