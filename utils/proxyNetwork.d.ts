export type ProxyNetwork = {
 executionId?: string; proxyId?: string; proxyHost?: string; proxyPort?: number; proxyScheme?: string;
 browserIp?: string; workerIp?: string; previousIp?: string;
 checkStatus?: 'pending'|'observed'|'failed'|'disabled'; checkedAt?: string;
 ipComparison?: 'first_observation'|'changed'|'unchanged';
 routeComparison?: 'worker_unknown'|'matches_worker'|'differs_from_worker';
};
export function networkSnapshot(input: unknown): ProxyNetwork|null;
declare const proxyNetwork: { networkSnapshot: typeof networkSnapshot };
export default proxyNetwork;
