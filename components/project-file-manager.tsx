"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FileArchive, FileCode2, Folder, History, Link2, Loader2, RefreshCw, Save, Search, Trash2, Undo2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DirectoryListing, FileContent, FileHistory, FileVersion, ProjectFile } from "@/utils/projectFiles";

const endpoint = "/api/system/files/";
const url = (action: string, path = "", extra: Record<string, string> = {}) => `${endpoint}?${new URLSearchParams({ action, path, ...extra })}`;
class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request<T>(target: string, options?: RequestInit): Promise<T> {
  const response = await fetch(target, { cache: "no-store", ...options });
  const result = await response.json().catch(() => ({ error: response.status === 413 ? "Файл превышает допустимый размер загрузки" : "Сервер вернул некорректный ответ" }));
  if (!response.ok) throw new RequestError(result.error || "Не удалось выполнить операцию", response.status);
  return result;
}
const body = (method: string, value: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
function bytes(value: number) {
  if (value < 1024) return `${value} Б`;
  const unit = value < 1048576 ? 1024 : value < 1073741824 ? 1048576 : 1073741824;
  return `${(value / unit).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${unit === 1024 ? "КиБ" : unit === 1048576 ? "МиБ" : "ГиБ"}`;
}
const date = (value: string) => new Date(value).toLocaleString("ru-RU");
const parentPath = (value: string) => value.split("/").slice(0, -1).join("/");
type Confirmation = { action: "delete"; file: ProjectFile } | { action: "restore"; version: FileVersion; revision: string | null } | { action: "purge"; version: FileVersion };
type UploadItem = { file: File; path: string; revision: string | null };

export function ProjectFileManager() {
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<"files" | "history">("files");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [history, setHistory] = useState<FileHistory | null>(null);
  const [selected, setSelected] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [uploads, setUploads] = useState<UploadItem[] | null>(null);
  const [uploadProgress, setUploadProgress] = useState("");
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = selected?.content !== null && selected !== null && draft !== selected.content;
  const message = (error: unknown) => setError(error instanceof Error ? error.message : "Не удалось выполнить операцию");
  const discard = () => !dirty || window.confirm("Есть несохранённые изменения файла. Продолжить без сохранения?");

  useEffect(() => {
    const timer = setTimeout(() => { setFilter(query); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const target = tab === "files" ? url("list", path, { q: filter, offset: String(offset) }) : url("history", "", { offset: String(offset) });
    request<DirectoryListing | FileHistory>(target, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      if (tab === "files") setListing(result as DirectoryListing); else setHistory(result as FileHistory);
    }).catch(error => { if (!abort.signal.aborted) message(error); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [path, filter, offset, tab, refresh]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const leave = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.("a[href]");
      if (!link || link.hasAttribute("download") || link.getAttribute("target") === "_blank") return;
      if (!window.confirm("Есть несохранённые изменения файла. Покинуть страницу?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [dirty]);

  function navigate(next: string) {
    if (busy || !discard()) return;
    sequence.current++; setSelected(null); setDraft(""); setPath(next); setOffset(0); setQuery(""); setFilter(""); setNotice(""); setError("");
  }
  async function open(file: ProjectFile) {
    if (busy) return;
    if (file.type === "directory") { navigate(file.path); return; }
    if (file.type !== "file") { setError(file.reason || "Этот объект нельзя открыть"); return; }
    if (!discard()) return;
    const current = ++sequence.current;
    setBusy(true); setError("");
    try {
      const result = await request<FileContent>(url("read", file.path));
      if (current === sequence.current) {
        setSelected(result); setDraft(result.content || ""); setNotice("");
        requestAnimationFrame(() => editor.current?.focus());
      }
    } catch (error) { message(error); }
    finally { setBusy(false); }
  }
  const save = useCallback(async () => {
    if (!selected?.editable || !dirty || busy) return;
    setBusy(true); setError("");
    try {
      const result = await request<{ file: FileContent }>(endpoint, body("PATCH", { path: selected.path, revision: selected.revision, content: draft }));
      setSelected(result.file); setDraft(result.file.content || ""); setRefresh(value => value + 1);
      setNotice("Файл сохранён. Предыдущая версия доступна в «Корзине и версиях».");
    } catch (error) { message(error); }
    finally { setBusy(false); }
  }, [selected, dirty, draft, busy]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [save]);
  function downloadDraft() {
    const blob = URL.createObjectURL(new Blob([draft], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = blob; anchor.download = selected?.name || "draft.txt"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(blob), 1000);
  }
  function switchTab(next: "files" | "history") {
    if (busy || !discard()) return;
    sequence.current++; setSelected(null); setDraft(""); setTab(next); setOffset(0); setError(""); setNotice("");
  }
  async function prepareRestore(version: FileVersion) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      let revision: string | null = null;
      try { revision = (await request<FileContent>(url("read", version.path))).revision; }
      catch (error) { if (!(error instanceof RequestError) || error.status !== 404) throw error; }
      setConfirmation({ action: "restore", version, revision });
    } catch (error) { message(error); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true); setError("");
    try {
      if (confirmation.action === "delete") {
        await request(endpoint, body("DELETE", { path: confirmation.file.path, revision: confirmation.file.revision }));
        if (selected?.path === confirmation.file.path) { setSelected(null); setDraft(""); }
        setNotice("Файл перемещён в корзину. Его можно восстановить.");
      } else if (confirmation.action === "restore") {
        await request(endpoint, body("POST", { action: "restore", id: confirmation.version.id, revision: confirmation.revision }));
        setNotice(`Восстановлен файл ${confirmation.version.path}`);
      } else {
        await request(endpoint, body("POST", { action: "purge", id: confirmation.version.id }));
        setNotice("Резервная копия удалена окончательно.");
      }
      setConfirmation(null); setRefresh(value => value + 1);
    } catch (error) { setConfirmation(null); message(error); }
    finally { setBusy(false); }
  }
  async function prepareUploads(chosen: File[]) {
    if (!chosen.length || busy || !listing?.uploadAllowed) return;
    if (chosen.some(file => [path, file.name].filter(Boolean).join("/") === selected?.path) && !discard()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (chosen.length > 20) throw new Error("Выберите не более 20 файлов за одну загрузку");
      const plan: UploadItem[] = [];
      for (const file of chosen) {
        if (file.size > listing.uploadLimit) throw new Error(`${file.name}: файл больше ${bytes(listing.uploadLimit)}`);
        if (!file.name || /[/\\\x00-\x1f\x7f]/.test(file.name) || [".", ".."].includes(file.name)) throw new Error("Некорректное имя файла");
        const target = [path, file.name].filter(Boolean).join("/");
        if (plan.some(item => item.path === target)) throw new Error(`Два файла с одинаковым именем: ${file.name}`);
        let revision: string | null = null;
        try {
          const existing = await request<ProjectFile>(url("stat", target));
          if (!existing.writable) throw new Error(existing.reason || "Замена файла запрещена");
          revision = existing.revision;
        } catch (error) { if (!(error instanceof RequestError) || error.status !== 404) throw error; }
        plan.push({ file, path: target, revision });
      }
      setUploads(plan);
    } catch (error) { message(error); }
    finally { setBusy(false); }
  }
  async function uploadFiles() {
    if (!uploads?.length || busy) return;
    setBusy(true); setError(""); setNotice("");
    let completed = 0;
    try {
      for (const item of uploads) {
        setUploadProgress(`Загрузка ${completed + 1} из ${uploads.length}: ${item.file.name}`);
        await request(endpoint + "?" + new URLSearchParams({ path: item.path, ...(item.revision ? { revision: item.revision } : {}) }), {
          method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: item.file,
        });
        completed++;
        setUploads(uploads.slice(completed));
        if (selected?.path === item.path) { setSelected(null); setDraft(""); sequence.current++; }
      }
      setUploads(null);
      setNotice(`Загружено файлов: ${completed}. Предыдущие версии заменённых файлов сохранены в «Корзине и версиях».`);
    } catch (error) {
      setUploads(null);
      message(new Error(`Загрузка ${uploads[completed].file.name} остановлена. ${error instanceof Error ? error.message : "Ошибка загрузки"}. Успешно загружено: ${completed} из ${uploads.length}. Для повтора выберите оставшиеся файлы.`));
    } finally {
      setUploadProgress(""); setBusy(false); setRefresh(value => value + 1);
      if (completed) { setQuery(""); setFilter(""); setOffset(0); }
    }
  }
  const data = tab === "files" ? listing : history;
  return <section aria-label="Файловый менеджер" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Режим файлового менеджера">
        <Button variant={tab === "files" ? "default" : "outline"} aria-pressed={tab === "files"} onClick={() => switchTab("files")} disabled={busy}><Folder />Файлы проекта</Button>
        <Button variant={tab === "history" ? "default" : "outline"} aria-pressed={tab === "history"} onClick={() => switchTab("history")} disabled={busy}><History />Корзина и версии</Button>
      </div>
      <Button variant="outline" onClick={() => setRefresh(value => value + 1)} disabled={loading || busy}><RefreshCw className={loading ? "animate-spin" : ""} />Обновить список</Button>
    </div>
    <p className="text-sm text-muted-foreground">Изменения интерфейса применяются после сборки и перезапуска приложения; изменения воркера — после его перезапуска.</p>
    {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{error}{dirty && <Button variant="outline" className="ml-3" onClick={downloadDraft}><Download />Скачать черновик</Button>}</div>}
    {notice && <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">{notice}</p>}
    {tab === "files" ? <>
      <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <Button variant="ghost" size="icon" aria-label="На папку выше" onClick={() => navigate(parentPath(path))} disabled={!path || busy}><ArrowLeft /></Button>
        <nav aria-label="Путь к папке" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          <button className="rounded px-1 py-2 text-primary hover:underline" onClick={() => navigate("")}>Проект</button>
          {path.split("/").filter(Boolean).map((part, index, all) => <span key={index} className="flex min-w-0 items-center gap-1"><span className="text-muted-foreground">/</span><button className="max-w-56 truncate rounded px-1 py-2 hover:underline" title={part} onClick={() => navigate(all.slice(0, index + 1).join("/"))}>{part}</button></span>)}
        </nav>
        <input ref={fileInput} type="file" multiple className="hidden" aria-label="Выберите файлы для загрузки" onChange={event => { const chosen = Array.from(event.target.files || []); event.target.value = ""; void prepareUploads(chosen); }} />
        <Button disabled={busy || loading || !listing?.uploadAllowed} onClick={() => fileInput.current?.click()}><Upload />Загрузить файлы</Button>
        <Button asChild variant="outline"><a href={url("archive", path)} download aria-label="Скачать текущую папку ZIP"><FileArchive />Скачать папку ZIP</a></Button>
        <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input className="pl-9" aria-label="Поиск в текущей папке" placeholder="Имя файла в этой папке" value={query} onChange={event => setQuery(event.target.value)} /></div>
      </div>
      <p className="text-xs text-muted-foreground">ZIP включает всю папку и подпапки, без корзины и символических ссылок. Сначала сохраните изменения.</p>
      <p className="text-xs text-muted-foreground">До 20 файлов за раз, каждый до {bytes(listing?.uploadLimit || 20 * 1024 * 1024)}. Замена существующих файлов — с подтверждением.</p>
      <div className={`grid min-w-0 items-start gap-4 ${selected ? "xl:grid-cols-[minmax(300px,2fr)_minmax(0,3fr)]" : ""}`}>
        <div className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-busy={loading}>
          <div className="flex items-center justify-between border-b px-4 py-3 text-xs text-muted-foreground"><span>{path || "Корень проекта"}</span><span>{loading ? "Загрузка…" : `${listing?.total || 0} элементов`}</span></div>
          <ul aria-label="Файлы и папки" className="divide-y">
            {!loading && !listing?.entries.length && <li className="p-8 text-center text-sm text-muted-foreground">{filter ? "Совпадений нет" : "Папка пуста"}</li>}
            {listing?.entries.map(file => <li key={file.path} className={`flex min-w-0 items-center gap-2 px-3 py-3 ${selected?.path === file.path ? "bg-primary/5" : "hover:bg-muted/40"}`}>
              <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void open(file)} disabled={busy || loading} title={file.reason || file.name} aria-label={`Открыть ${file.name}`}>
                {file.type === "directory" ? <Folder className="size-5 shrink-0 text-primary" /> : file.type === "link" ? <Link2 className="size-5 shrink-0 text-muted-foreground" /> : <FileCode2 className="size-5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{file.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{file.type === "directory" ? "Папка" : file.type === "link" ? "Ссылка" : bytes(file.size)} · {date(file.modifiedAt)}{!file.writable && file.type === "file" ? " · Только чтение" : ""}</span></span>
              </button>
              {file.type === "directory" && <Button asChild variant="ghost" size="icon" title="Скачать папку ZIP"><a href={url("archive", file.path)} download aria-label={`Скачать папку ${file.name} ZIP`}><FileArchive /></a></Button>}
              {file.type === "file" && <div className="flex shrink-0 gap-1">
                <Button asChild variant="ghost" size="icon" title="Скачать"><a href={url("download", file.path)} download aria-label={`Скачать ${file.name}`}><Download /></a></Button>
                <Button variant="ghost" size="icon" disabled={!file.writable || busy || loading} title={file.reason || "В корзину"} aria-label={`Удалить ${file.name}`} onClick={() => { if (selected?.path !== file.path || discard()) setConfirmation({ action: "delete", file }); }}><Trash2 className="text-destructive" /></Button>
              </div>}
            </li>)}
          </ul>
        </div>
        {selected && <section aria-label={`Редактор ${selected.name}`} className="min-w-0 overflow-hidden rounded-lg border bg-card xl:sticky xl:top-4">
          <div className="flex min-w-0 items-center justify-between gap-2 border-b p-4">
            <div className="min-w-0"><h2 className="truncate text-sm font-semibold" title={selected.path}>{selected.path}</h2><p className="mt-1 text-xs text-muted-foreground">{bytes(selected.size)} · {dirty ? "Есть несохранённые изменения" : "Сохранённая версия"}</p></div>
            <Button variant="ghost" size="icon" aria-label="Закрыть редактор" disabled={busy} onClick={() => { if (discard()) { setSelected(null); setDraft(""); } }}><X /></Button>
          </div>
          {selected.content !== null ? <textarea ref={editor} aria-label="Содержимое файла" className="block h-[55vh] min-h-80 w-full resize-y border-0 bg-background p-4 font-mono text-xs leading-6 outline-none focus:ring-2 focus:ring-inset focus:ring-primary/40" spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" value={draft} readOnly={!selected.editable || busy} onChange={event => setDraft(event.target.value)} />
            : <div className="p-8 text-sm text-muted-foreground">{selected.reason || "Предпросмотр недоступен"}</div>}
          {selected.content !== null && selected.reason && <p className="border-t px-4 py-3 text-xs text-muted-foreground">{selected.reason}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t p-3">
            <Button onClick={() => void save()} disabled={!selected.editable || !dirty || busy}><Save />{busy ? "Подождите…" : "Сохранить"}</Button>
            <Button asChild variant="outline"><a href={url("download", selected.path)} download><Download />Скачать файл</a></Button>
            {dirty && <Button variant="ghost" onClick={downloadDraft}>Скачать черновик</Button>}
            <span className="text-xs text-muted-foreground">UTF-8 · до 512 КиБ · Ctrl/Cmd+S</span>
          </div>
        </section>}
      </div>
    </> : <div className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b p-4"><h2 className="font-medium">Корзина и предыдущие версии</h2><p className="mt-1 text-sm text-muted-foreground">Резервная копия создаётся перед каждым изменением. Восстановление существующего файла также сохраняет его текущую версию.</p></div>
      <ul className="divide-y" aria-label="История файлов" aria-busy={loading}>
        {!loading && !history?.entries.length && <li className="p-8 text-center text-sm text-muted-foreground">Удалённых файлов и сохранённых версий пока нет.</li>}
        {history?.entries.map(version => <li key={version.id} className="flex flex-wrap items-center gap-3 p-4">
          <span className="min-w-0 flex-1"><span className="block break-all text-sm font-medium">{version.path}</span><span className="mt-1 block text-xs text-muted-foreground">{version.action === "delete" ? "Удалён в корзину" : "До редактирования"} · {date(version.createdAt)} · {bytes(version.size)}</span></span>
          <Button variant="outline" disabled={busy} onClick={() => void prepareRestore(version)} aria-label={`Восстановить ${version.path}`}><Undo2 />Восстановить</Button>
          <Button variant="ghost" size="icon" disabled={busy} title="Удалить копию окончательно" aria-label={`Удалить копию ${version.path}`} onClick={() => setConfirmation({ action: "purge", version })}><Trash2 className="text-destructive" /></Button>
        </li>)}
      </ul>
    </div>}
    {data && data.total > data.limit && <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{offset + 1}–{Math.min(offset + data.limit, data.total)} из {data.total}</span>
      <div className="flex gap-2"><Button variant="outline" disabled={offset === 0 || loading || busy} onClick={() => setOffset(Math.max(0, offset - data.limit))}>Назад</Button><Button variant="outline" disabled={offset + data.limit >= data.total || loading || busy} onClick={() => setOffset(offset + data.limit)}>Далее</Button></div>
    </div>}
    <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{confirmation?.action === "delete" ? "Переместить файл в корзину?" : confirmation?.action === "purge" ? "Удалить копию окончательно?" : "Восстановить версию файла?"}</DialogTitle>
          <DialogDescription className="break-all">{confirmation?.action === "delete" ? confirmation.file.path : confirmation?.version.path}</DialogDescription></DialogHeader>
        <p className="text-sm text-muted-foreground">{confirmation?.action === "delete" ? "Файл исчезнет из рабочей папки. Копия останется в корзине для восстановления." : confirmation?.action === "purge" ? "Эту резервную копию нельзя будет восстановить. Рабочий файл останется без изменений." : confirmation?.revision ? "Текущий файл будет заменён выбранной версией. Перед заменой сохраним резервную копию." : "Файл будет возвращён в исходную папку."}</p>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Отмена</Button><Button variant={confirmation?.action === "restore" ? "default" : "destructive"} disabled={busy} onClick={() => void confirm()}>{busy && <Loader2 className="animate-spin" />}{confirmation?.action === "delete" ? "Переместить в корзину" : confirmation?.action === "purge" ? "Удалить окончательно" : "Подтвердить восстановление"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={uploads !== null} onOpenChange={open => { if (!open && !busy) setUploads(null); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>Загрузить файлы в папку?</DialogTitle><DialogDescription className="break-all">{path || "Корень проекта"}. Совпадающие имена будут заменены с сохранением предыдущей версии.</DialogDescription></DialogHeader>
        <ul className="max-h-72 space-y-3 overflow-y-auto text-sm" aria-label="Файлы для загрузки">
          {uploads?.map(item => <li key={item.path} className="flex items-start justify-between gap-3"><span className="min-w-0 break-all">{item.file.name}<span className="block text-xs text-muted-foreground">{bytes(item.file.size)}</span></span><span className={item.revision ? "shrink-0 font-medium text-destructive" : "shrink-0 text-muted-foreground"}>{item.revision ? "Замена" : "Новый файл"}</span></li>)}
        </ul>
        {uploadProgress && <p role="status" className="break-all text-sm">{uploadProgress}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setUploads(null)}>Отмена</Button><Button disabled={busy || !uploads?.length} onClick={() => void uploadFiles()}>{busy ? <><Loader2 className="animate-spin" />Загрузка…</> : uploads?.some(item => item.revision) ? "Загрузить и заменить" : "Загрузить"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
