import type { PrismaClient, Prisma } from '@prisma/client';
import type { Diagnostic, Preset } from './proxyTcp';
export function state(db: PrismaClient, id: string, fetchImpl?: typeof fetch): Promise<{providerId:string;config:Prisma.ProxyTcpChannelGetPayload<Record<string,never>> | null;presets:Preset[];current:{profileId:number;name:string|null};members:number;busy:boolean}>;
export function apply(db: PrismaClient,id:string,presetId:number,fetchImpl?:typeof fetch):Promise<unknown>;
export function diagnose(db:PrismaClient,id:string,fetchImpl?:typeof fetch):Promise<unknown>;
export function syncBinding(tx:Prisma.TransactionClient,id:string,rows?:Record<string,unknown>[]):Promise<void>;
export function message(error:unknown):string;

export function provider(db:PrismaClient,fetchImpl?:typeof fetch):Promise<ReturnType<typeof import('./proxyTcp').client>>;
