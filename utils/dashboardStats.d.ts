import type { PrismaClient } from '@prisma/client';
export type DashboardStats = { period: 'today' | 'week'; timezone: string; today: {completed:number;failed:number}; totals:{completed:number;failed:number}; buckets: {at:string;label:string;completed:number;failed:number}[] };
export function dashboardStats(db: PrismaClient, period?: string, now?: number): Promise<DashboardStats>;
