import type {LogData} from './attemptDiagnostics';
export function readDiagnosticLog(path:string,options?:{maxBytes?:number}):Promise<LogData>;
export function diagnosticFileIndex(runtime:string):Promise<Map<string,{events?:{path:string;mtime:number;runId:string};network?:{path:string;mtime:number;runId:string}}>>;
