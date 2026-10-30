export function liveEventStream(options:{signal:AbortSignal;getSocket:()=>Promise<string|null>;lifetime?:number;retryDelay?:number}):ReadableStream<Uint8Array>;
