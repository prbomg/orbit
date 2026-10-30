export function diagnosticIpPage<T extends { stats: { ips: { ip: string; latestAt: string | null }[] } }>(summary: T, limit?: number): T & { ipPage: { limit: number; total: number; hasMore: boolean } };
export function diagnosticRecentPage<T extends { recent: unknown[] }>(summary: T, limit?: number): T & { recentPage: { limit: number; total: number; hasMore: boolean } };
