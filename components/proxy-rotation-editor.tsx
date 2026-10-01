"use client";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useData, type Proxy } from "@/lib/data-store";

export function ProxyRotationEditor({ proxy }: { proxy: Proxy }) {
  const { updateProxyRotation } = useData();
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState(proxy.rotationUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { setValue(proxy.rotationUrl ?? ""); }, [proxy.rotationUrl]);
  async function save() {
    setSaving(true); setError(""); setMessage("");
    try { await updateProxyRotation(proxy.id, value.trim() || null); setMessage("Сохранено"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить URL"); }
    finally { setSaving(false); }
  }
  return <div className="min-w-64 max-w-sm space-y-2"><div className="flex gap-2"><Input type={visible ? "text" : "password"} value={value} onChange={event => { setValue(event.target.value); setMessage(""); setError(""); }} disabled={saving} placeholder="URL смены IP (необязательно)" autoComplete="off" aria-label={`URL ротации ${proxy.host}:${proxy.port}`} /><Button variant="ghost" size="icon" onClick={() => setVisible(!visible)} aria-label={`${visible ? "Скрыть" : "Показать"} ссылку смены IP ${proxy.host}:${proxy.port}`}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</Button><Button variant="outline" size="sm" disabled={saving} onClick={() => void save()}>{saving ? "…" : "Сохранить"}</Button></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}{message && <p role="status" className="text-xs text-primary">{message}</p>}<p className="text-xs text-muted-foreground">{proxy.rotationUrl ? "Ротация включена · пауза 15 секунд" : "Без ротации"}</p></div>;
}
