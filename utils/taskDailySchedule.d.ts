import type { Prisma, PrismaClient } from '@prisma/client';
export type DailyTask = { id: string; dailyExecutionLimit?: number | null; targetExecutions: number; currentExecutions: number; project?: { scheduleHours?: string; scheduleTimezone?: string } | null };
export type DayCalendar = { dayKey: string; start: number; end: number; timezone: string; windows: {start:number;end:number}[] };
export type DailyState = {allowed:boolean;reason:'schedule'|'daily_limit'|'daily_schedule'|null;completed:number;reserved:number;nextAt:Date|null};
export function dayCalendar(project: DailyTask['project'], now?: Date): DayCalendar | null;
export function generateSlots(calendar: DayCalendar, count: number, now?: Date, random?: () => number): number[];
export function settingsKey(task: DailyTask): string;
export function dailyState(db: PrismaClient | Prisma.TransactionClient, task: DailyTask, options?: {now?:Date;create?:boolean;random?:()=>number}): Promise<DailyState>;
export const STALE_MS: number;
