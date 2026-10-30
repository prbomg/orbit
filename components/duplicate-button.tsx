"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectRequest } from "@/lib/projects";

export function DuplicateButton({ kind, id, name, onCreated, onFeedback }: { kind: "projects" | "tasks"; id: string; name: string; onCreated: () => Promise<void>; onFeedback?: (feedback: { message: string; error: string }) => void }) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  useEffect(() => { onFeedback?.({ message, error }); }, [message, error, onFeedback]);
  const label = kind === "projects" ? "проект" : "задачу";
  async function duplicate() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage(""); setError("");
    try {
      await projectRequest(`/api/${kind}/${encodeURIComponent(id)}/duplicate/`, { method: "POST" });
      setMessage(kind === "projects" ? "Копия создана без задач." : "Копия задачи создана на паузе.");
      try { await onCreated(); }
      catch { setError("Копия создана, но список не обновился. Обновите страницу."); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать копию"); }
    finally { locked.current = false; setBusy(false); }
  }
  return <span className="duplicate-action">
    <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={`Дублировать ${label} ${name}`} title={kind === "projects" ? "Дублировать проект без задач" : "Дублировать задачу · копия на паузе"} onClick={() => void duplicate()}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Copy size={16}/>}</Button>
    {!onFeedback && message && <span role="status" className="duplicate-feedback">{message}</span>}
    {!onFeedback && error && <span role="alert" className="duplicate-feedback text-destructive">{error}</span>}
  </span>;
}
