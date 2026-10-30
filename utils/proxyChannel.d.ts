export type ChannelProxy = { id: string; host: string; port: number; channel?: string | null; rotationUrl?: string | null; tcpChannelId?: string | null };
export function proxyKey(proxy: ChannelProxy): string;
export function proxyKeys(proxy: ChannelProxy): string[];
export function channelMembers<T extends ChannelProxy>(proxies: T[], proxy: T): T[];

export function channelKeys<T extends ChannelProxy>(proxies: T[], proxy: T): string[];
