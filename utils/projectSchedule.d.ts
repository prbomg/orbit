export const ALL_HOURS: string;
export const DEFAULT_TIMEZONE: string;
export function validTimezone(value: unknown): boolean;
export function isAllowed(project: { scheduleHours?: string; scheduleTimezone?: string } | null, now?: Date): boolean;
export type SchedulePreset = 'work' | 'night' | 'day' | 'weekdays' | 'weekends' | 'random' | 'clear' | 'all';
export function preset(name: SchedulePreset): string;

export function isWarmupAllowed(settings: { warmupEnabled?: boolean; warmupScheduleHours?: string; warmupScheduleTimezone?: string } | null, now?: Date): boolean;
