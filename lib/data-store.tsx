"use client";
import type { Project } from "@/lib/projects";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type TaskStatus = "running" | "paused" | "completed" | "failed";
export type TaskType = "warmup" | "target";
export type SearchEngine = "yandex" | "mail" | "dzen";
export type SearchFields = { searchEngine: SearchEngine; searchQueries: string[]; vitalPhrases: string[] };
export type Profile = { id: string; name: string; createdAt: string; status: "new" | "warming_up" | "ready" | "banned"; warmupScore: number; isEnabled: boolean; session?: { state: string; savedAt: string | null; mobileOS: string | null; cookiesCount: number; originsCount: number } };
export type Task = { id: string; taskType: TaskType; searchEngine: SearchEngine | ""; searchQueries: string[]; vitalPhrases: string[]; projectId: string | null; project: Project | null; targetExecutions: number; profileId: string; profile: Profile; url: string; targetKeywords: string[]; status: TaskStatus; currentExecutions: number; createdAt: string };
export type TaskInput = { taskType: TaskType; url: string; targetKeywords: string[]; searchEngine: SearchEngine | ""; searchQueries: string[]; vitalPhrases: string[]; projectId?: string | null; targetExecutions: number; profileId?: string; status: TaskStatus };
export type Proxy = { id: string; host: string; port: number; username: string; isActive: boolean; rotationUrl: string | null };
export type ProxyInput = Omit<Proxy, "id" | "rotationUrl"> & { password: string; rotationUrl?: string | null };
export type SystemState = { workerState: "running" | "stopped" | "stale" | "unknown"; projectRun: { state: string; projectId: string; taskId?: string | null; event?: string; errorType?: string | null } | null; checkedAt: string; headless: boolean; proxyScheme: string; planMode: "local" | "openai"; directVisitSeconds: number[]; searchVisitSeconds: number[]; rotationWaitSeconds: number; mobileDevices: string[]; captchaProvider: string };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, cache: "no-store", headers: { "Content-Type": "application/json", ...options.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.details?.map((item: { message: string }) => item.message).join(" · ") || body?.error || `Ошибка запроса (${response.status})`);
  return body as T;
}
type Store = {
  tasks: Task[]; profiles: Profile[]; proxies: Proxy[]; system: SystemState | null; loading: boolean; error: string; lastUpdated: string | null;
  pendingIds: Set<string>; refresh: () => Promise<void>;
  saveTask: (data: TaskInput, id?: string) => Promise<void>; setTaskStatus: (id: string, status: TaskStatus) => Promise<void>; toggleTask: (id: string) => Promise<void>; removeTask: (id: string) => Promise<void>;
  addProfile: (name: string) => Promise<void>; updateProfile: (id: string, data: { name?: string; status?: Profile["status"]; isEnabled?: boolean }) => Promise<void>;
  addProxies: (items: ProxyInput[]) => Promise<void>; updateProxy: (id: string, data: Partial<ProxyInput>) => Promise<void>;
  removeProxy: (id: string) => Promise<void>; toggleProxy: (id: string) => Promise<void>; updateProxyRotation: (id: string, rotationUrl: string | null) => Promise<void>;
};
const DataContext = createContext<Store | null>(null);
export function DataProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]); const [profiles, setProfiles] = useState<Profile[]>([]); const [proxies, setProxies] = useState<Proxy[]>([]);
  const [system, setSystem] = useState<SystemState | null>(null); const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [pendingIds, setPendingIds] = useState(new Set<string>());
  const version = useRef(0); const polling = useRef(false);
  const fetchData = useCallback(async (foreground = false) => {
    if (polling.current) return;
    polling.current = true; const current = ++version.current;
    if (foreground) setLoading(true);
    try {
      const [nextTasks, nextProxies, nextProfiles, nextSystem] = await Promise.all([request<Task[]>("/api/tasks/"), request<Proxy[]>("/api/proxies/"), request<Profile[]>("/api/profiles/"), request<SystemState>("/api/system/")]);
      if (version.current === current) { setTasks(nextTasks); setProxies(nextProxies); setProfiles(nextProfiles); setSystem(nextSystem); setLastUpdated(new Date().toISOString()); setError(""); }
    } catch (cause) { if (version.current === current) setError(cause instanceof Error ? cause.message : "Не удалось загрузить данные"); }
    finally { polling.current = false; if (foreground) setLoading(false); }
  }, []);
  const refresh = useCallback(() => fetchData(true), [fetchData]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void fetchData(); }, 5000);
    const focus = () => { if (document.visibilityState === "visible") void fetchData(); };
    document.addEventListener("visibilitychange", focus);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", focus); version.current++; };
  }, [refresh, fetchData]);
  async function operation<T>(id: string, action: () => Promise<T>, apply: (value: T) => void) {
    version.current++; setPendingIds(prev => new Set(prev).add(id));
    try { const value = await action(); version.current++; apply(value); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить данные"); throw cause; }
    finally { setPendingIds(prev => { const next = new Set(prev); next.delete(id); return next; }); }
  }
  const updateProxy = (id: string, data: Partial<ProxyInput>) => operation(id, () => request<Proxy>(`/api/proxies/${id}/`, { method: "PATCH", body: JSON.stringify(data) }), next => setProxies(prev => prev.map(item => item.id === id ? next : item)));
  const setTaskStatus = (id: string, status: TaskStatus) => operation(id, () => request<Task>(`/api/tasks/${id}/`, { method: "PATCH", body: JSON.stringify({ status }) }), next => setTasks(prev => prev.map(item => item.id === id ? next : item)));
  return <DataContext.Provider value={{ tasks, profiles, proxies, system, lastUpdated, loading, error, pendingIds, refresh,
    saveTask: (data, id) => operation(id ?? "new-task", () => request<Task>(id ? `/api/tasks/${id}/` : "/api/tasks/", { method: id ? "PATCH" : "POST", body: JSON.stringify(data) }), task => {
      setTasks(prev => id ? prev.map(item => item.id === id ? task : item) : [task, ...prev]);
      setProfiles(prev => prev.some(profile => profile.id === task.profileId) ? prev : [task.profile, ...prev]);
    }), setTaskStatus,
    toggleTask: async id => { const task = tasks.find(item => item.id === id); if (task) await setTaskStatus(id, task.status === "running" ? "paused" : "running").catch(() => {}); },
    removeTask: id => operation(id, () => request<void>(`/api/tasks/${id}/`, { method: "DELETE" }), () => setTasks(prev => prev.filter(item => item.id !== id))).catch(() => {}),
    addProfile: name => operation("new-profile", () => request<Profile>("/api/profiles/", { method: "POST", body: JSON.stringify({ name }) }), next => setProfiles(prev => [next, ...prev])),
    updateProfile: (id, data) => operation(id, () => request<Profile>(`/api/profiles/${id}/`, { method: "PATCH", body: JSON.stringify(data) }), next => {
      setProfiles(prev => prev.map(item => item.id === id ? { ...item, ...next } : item));
      setTasks(prev => prev.map(item => item.profileId === id ? { ...item, profile: { ...item.profile, ...next } } : item));
    }),
    addProxies: items => operation("new-proxies", () => request<Proxy[]>("/api/proxies/", { method: "POST", body: JSON.stringify({ proxies: items }) }), next => setProxies(prev => [...prev, ...next])), updateProxy,
    updateProxyRotation: (id, rotationUrl) => updateProxy(id, { rotationUrl }),
    removeProxy: id => operation(id, () => request<void>(`/api/proxies/${id}/`, { method: "DELETE" }), () => setProxies(prev => prev.filter(item => item.id !== id))).catch(() => {}),
    toggleProxy: async id => { const proxy = proxies.find(item => item.id === id); if (proxy) await updateProxy(id, { isActive: !proxy.isActive }).catch(() => {}); },
  }}>{children}</DataContext.Provider>;
}
export function useData() { const store = useContext(DataContext); if (!store) throw new Error("DataProvider is required"); return store; }
