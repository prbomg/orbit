import type { Task, ProjectRunState } from '@/lib/data-store';
export type DashboardTaskState = {kind:'running'|'error'|'completed'|'paused'|'waiting'|'schedule'|'retry'|'resources';label:string;count?:number;code?:string;until?:string|null};
export function taskState(task:Task,run?:ProjectRunState,now?:number):DashboardTaskState;
export function nextScheduleWindow(project:{scheduleHours:string;scheduleTimezone:string},now?:number):string|null;

export function nextTaskWindow(project:{scheduleHours:string;scheduleTimezone:string},task:Task,run?:ProjectRunState,now?:number):string|null;
