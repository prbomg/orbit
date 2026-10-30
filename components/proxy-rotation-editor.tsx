"use client";
import { Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useData, type Proxy } from "@/lib/data-store";

export function ProxyRotationEditor({ proxy }: { proxy: Proxy }) {
  const { updateProxyRotation } = useData();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(proxy.rotationUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function changeOpen(next: boolean) {
    if (saving) return;
    if (next) { setValue(proxy.rotationUrl ?? ""); setError(""); }
    setOpen(next);
  }
  async function save() {
    setSaving(true); setError("");
    try { await updateProxyRotation(proxy.id, value.trim() || null); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить URL"); }
    finally { setSaving(false); }
  }
  return <div className="proxy-rotation-summary">
    <p className="proxy-rotation-url" aria-label={`Ссылка смены IP ${proxy.host}:${proxy.port}`}>{proxy.rotationUrl || "Не задана"}</p>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild><Button variant="ghost" size="sm" aria-label={`Настроить смену IP ${proxy.host}:${proxy.port}`} title="Настроить смену IP">{proxy.rotationUrl ? <Pencil size={14} /> : <RefreshCw size={14} />}{proxy.rotationUrl ? "Изменить" : "Задать ссылку"}</Button></DialogTrigger>
      <DialogContent className="max-h-[85dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto" showCloseButton={!saving}><DialogHeader><DialogTitle>Смена IP</DialogTitle><DialogDescription>{proxy.host}:{proxy.port} · ссылка провайдера для смены адреса.</DialogDescription></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); void save(); }} className="min-w-0 space-y-4">
          <label className="block space-y-2 text-sm"><span>Ссылка смены IP</span><Input type="text" value={value} onChange={event => { setValue(event.target.value); setError(""); }} disabled={saving} placeholder="https://provider.example/rotate?key=…" autoComplete="off" autoCapitalize="none" autoCorrect="off" maxLength={2048} aria-label={`URL ротации ${proxy.host}:${proxy.port}`} /></label>
          <p className="field-help">Ссылка применяется при следующей смене IP. Сохранение не запускает смену адреса. Пустое поле отключает ротацию.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>Отмена</Button><Button type="submit" disabled={saving}>{saving ? "Сохранение…" : "Сохранить"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
