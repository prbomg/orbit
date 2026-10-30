export type CaptchaBalance = { balance: number | null; checkedAt: string | null; errorCode: string | null };
export function endpoint(): string;
export function getBalance(apiKey: string | null, options?: { baseUrl?: string; fetchImpl?: typeof fetch; refresh?: boolean }): Promise<CaptchaBalance>;
