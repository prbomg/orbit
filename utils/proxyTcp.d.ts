export class TcpError extends Error { code: string; }
export type Preset = { id: number; name: string; family: string; parameters: Record<string, unknown> };
export type Diagnostic = { capturedAt?:string|null; fresh?:boolean; checkedAt: string; cached: boolean; osGuess: string | null; observed: Record<string, unknown>; expected: Record<string, unknown>; comparisons: { field: string; expected: unknown; observed: unknown; match: boolean }[]; matches: number; total: number; dataAvailable: boolean; verified: boolean };
export function client(token?: string | null, fetchImpl?: typeof fetch): { proxies(): Promise<Record<string, unknown>[]>; presets(): Promise<Preset[]>; current(id: string): Promise<{profileId:number;name:string|null}>; apply(id:string,profileId:number):Promise<void>; diagnose(id:string):Promise<Diagnostic> };
export function resolveProviderId(proxy: {host:string;port:number;username:string}, rows: Record<string, unknown>[]): string;
export function sanitizeDiagnostic(data: unknown): Diagnostic;
export function compatible(proxy: unknown, profile: unknown): boolean;
