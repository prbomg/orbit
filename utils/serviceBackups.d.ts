export interface BackupInfo { id:string;label:string;createdAt:string|null;important:boolean;bytes:number;archiveBytes?:number;source:string;fileCount:number;broken?:boolean; }
export interface BackupJob {id:string;action:string;status:string;message?:string;createdAt:string;backupId?:string;}
export interface BackupSettings {enabled:boolean;intervalHours:number;retentionDays:number;}
export interface BackupList {settings:BackupSettings;nextAt:string|null;backups:BackupInfo[];jobs:BackupJob[];}
export class BackupError extends Error { status:number; }
export function createBackupManager(): {list():Promise<BackupList>;configure(value:BackupSettings):Promise<BackupSettings>;protect(id:string,important:boolean):Promise<unknown>;remove(id:string):Promise<unknown>;enqueue(action:string,value?:{id?:string;label?:string;confirmation?:string}):Promise<BackupJob>;download(id:string):Promise<{handle:import('node:fs/promises').FileHandle;size:number}>;};
