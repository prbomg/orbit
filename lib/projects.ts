export type Project = {
  id: string;
  name: string;
  targetUrl: string;
  yandexRegionId: string;
  regionName: string;
  createdAt: string;
  updatedAt: string;
  _count?: { tasks: number; profileUses: number; profileHistory?: number };
  profileHistory?: { id: string; profileId: string; executedAt: string; source: string; profile: { id: string; name: string } }[];
};

export async function projectRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options, cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.details?.map((item: { message: string }) => item.message).join(" · ") || body?.error || "Не удалось выполнить запрос");
  return body as T;
}
