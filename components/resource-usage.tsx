"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, HardDrive, Cpu, MemoryStick } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ResourceUsage } from "@/utils/serviceResources";

const number = (value: number, digits = 1) => value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
const bytes = (value: number | null | undefined) => {
  if (value == null) return "Недоступно";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${number(value)} ${units[index]}`;
};
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "ещё не завершена";

export function ResourceUsagePanel() {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (forceDisk = false) => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    const controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch(`/api/system/resources/${forceDisk ? "?refresh=1" : ""}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Не удалось получить сведения о ресурсах");
      setUsage(await response.json()); setError("");
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось получить сведения о ресурсах"); }
    finally { if (request.current === controller) { pending.current = false; if (!controller.signal.aborted) setLoading(false); } }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    const changed = () => { void refresh(true); };
    window.addEventListener("orbit-storage-changed", changed);
    return () => { clearInterval(timer); window.removeEventListener("orbit-storage-changed", changed); request.current?.abort(); request.current = null; pending.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (usage?.disk.scanState !== "scanning") return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [usage?.disk.scanState, refresh]);
  const disk = usage?.disk, processes = usage?.processes;
  const cpu = processes?.cpuCores;
  const usableBytes = disk?.volume ? disk.volume.usedBytes + disk.volume.availableBytes : 0;
  const usedPercent = disk?.volume && usableBytes > 0 ? Math.min(100, disk.volume.usedBytes / usableBytes * 100) : 0;
  const reservedBytes = disk?.volume ? Math.max(0, disk.volume.totalBytes - usableBytes) : 0;
  return <section className="panel mb-6" aria-label="Ресурсы сервиса">
    <div className="panel-heading flex flex-wrap items-center justify-between gap-3"><div><h2>Ресурсы сервиса</h2><p>Файлы Orbit и текущая нагрузка</p></div><Button variant="outline" disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />Обновить ресурсы</Button></div>
    {error && <p role="alert" className="border-t px-6 py-4 text-sm text-amber-300">{error}{usage ? " Показаны данные предыдущей проверки." : ""}</p>}
    {!usage ? <p className="border-t p-6 text-sm text-muted-foreground" role="status">{loading ? "Измеряем размер файлов и нагрузку…" : "Данные о ресурсах пока недоступны"}</p> : <>
      <div className="grid gap-5 border-t p-6 sm:grid-cols-2 xl:grid-cols-4">
        <div><div className="flex items-center gap-2 text-sm text-muted-foreground"><HardDrive size={16} />Файлы Orbit</div><p className="mt-2 text-2xl font-semibold">{disk?.bytes != null ? bytes(disk.bytes) : disk?.knownBytes ? `Учтено ${bytes(disk.knownBytes)}` : disk?.scanState === "scanning" ? "Измеряем…" : "Недоступно"}</p><p className="mt-2 text-xs text-muted-foreground">Код, профили, база, логи, копии и кэши</p>{disk?.scanState === "scanning" && <p role="status" className="mt-1 text-xs text-muted-foreground">Пересчитываем размеры файлов…{disk.complete ? " Показан последний завершённый замер." : disk.knownBytes > 0 ? " Показан последний доступный результат." : " Итог появится после завершения проверки."}</p>}</div>
        <div><p className="text-sm text-muted-foreground">Свободно на диске</p><p className="mt-2 text-2xl font-semibold">{bytes(disk?.volume?.availableBytes)}</p>{disk?.volume && <><p className="mt-2 text-xs text-muted-foreground">Занято {bytes(disk.volume.usedBytes)} из {bytes(disk.volume.totalBytes)} · {Math.ceil(usedPercent)}%</p>{reservedBytes > 0 && <p className="mt-1 text-xs text-muted-foreground">Резерв файловой системы: {bytes(reservedBytes)}</p>}<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background" role="progressbar" aria-label="Использование диска сервера" aria-valuenow={Math.ceil(usedPercent)} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-primary" style={{ width: `${usedPercent}%` }} /></div></>}</div>
        <div><div className="flex items-center gap-2 text-sm text-muted-foreground"><MemoryStick size={16} />Память Orbit</div><p className="mt-2 text-2xl font-semibold">{bytes(processes?.memoryBytes)}</p><p className="mt-2 text-xs text-muted-foreground">Веб-сервис, исполнители и браузеры</p>{processes?.serverMemory && <p className="mt-1 text-xs text-muted-foreground">Серверу доступно {bytes(processes.serverMemory.availableBytes)} из {bytes(processes.serverMemory.totalBytes)}</p>}</div>
        <div><div className="flex items-center gap-2 text-sm text-muted-foreground"><Cpu size={16} />CPU Orbit</div><p className="mt-2 text-2xl font-semibold">{cpu == null ? "Недоступно" : `${number(cpu, 2)} ядра`}</p><p className="mt-2 text-xs text-muted-foreground">Доступно ядер: {processes?.cpuCapacity == null ? "Недоступно" : number(processes.cpuCapacity, 2)}</p><p className="mt-1 text-xs text-muted-foreground">Процессов: {processes?.count ?? "—"} · браузерных: {processes?.browserCount ?? "—"}</p></div>
      </div>
      <div className="border-t px-6 py-4"><h3 className="text-sm font-medium">Место на диске по категориям</h3><dl className="mt-3 space-y-2 text-sm">{disk?.breakdown.map(item => <div key={item.key} className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">{item.label}</dt><dd className="shrink-0 tabular-nums">{item.bytes === null && disk?.scanState === "scanning" ? "Измеряем…" : bytes(item.bytes)}</dd></div>)}</dl>{disk?.releaseCount != null && <p className="mt-3 text-xs text-muted-foreground">Сохранённых релизов: {disk.releaseCount}. Текущий релиз: {bytes(disk.activeReleaseBytes)} — уже включён в размер приложения.</p>}
      <p className="mt-3 text-xs text-muted-foreground">Категории входят в общий объём выше. Файлы по ссылкам и общие зависимости учитываются один раз. Свободное место относится ко всему диску сервера.</p>
      </div><details className="resource-details border-t px-6 py-4 text-xs text-muted-foreground"><summary className="cursor-pointer text-sm font-medium">Как считаем место</summary>{disk?.scope && <div className="mt-3"><p>Каталоги и внешние файлы Orbit:</p><ul className="mt-2 space-y-1">{disk.scope.map(directory => <li key={directory} className="break-all font-mono">{directory}</li>)}</ul></div>}<div className="mt-3"><p>Проверка файлов: {time(usage.disk.measuredAt)}. Нагрузка: {time(usage.processes.measuredAt)}. Свободное место и нагрузка обновляются каждые 30 секунд; размеры файлов — раз в 5 минут и по кнопке обновления. Размеры указаны в двоичных единицах (1 ГиБ = 1024 МиБ).</p>{!disk?.complete && disk?.scanState !== "scanning" && <p className="mt-2 text-amber-300">Проверены ещё не все файлы. Учтённый объём не является полным размером Orbit.</p>}{disk?.scanState === "error" && disk.complete && <p className="mt-2 text-amber-300">Новый замер завершился не полностью. Показаны данные последней успешной проверки; повторим автоматически.</p>}{disk?.warning && <p className="mt-2 text-amber-300">{disk.warning}</p>}{processes?.memoryAccounting === "rss" && <p className="mt-2">Память оценена по RSS; общие страницы могут учитываться повторно.</p>}</div></details>
    </>}
  </section>;
}
