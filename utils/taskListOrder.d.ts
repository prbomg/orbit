type TaskRow = { id: string; projectId: string | null; project?: { name: string } | null; createdAt: string };
export type TaskListPreferences = { version: number; collapsed: string[]; orders: Record<string, string[]> };
export function orderTasks<T extends TaskRow>(tasks: T[], saved?: string[]): T[];
export function groupTasks<T extends TaskRow>(tasks: T[]): { id: string; name: string; tasks: T[] }[];
export function moveTask<T extends TaskRow>(tasks: T[], source: string, target: string): T[];
export function readTaskListPreferences(text: string | null): TaskListPreferences;
