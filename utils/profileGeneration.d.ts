export type ProfileGeneration = { current: boolean; version: string | null; adapter: string | null; catalogVersion: string | null; model: string | null; android: string | null; source: string | null };
export function profileGeneration(passport: unknown): ProfileGeneration;
