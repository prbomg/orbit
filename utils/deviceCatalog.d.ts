import type { ZodType } from 'zod';
export type WebglLimits = { maxTextureSize:number;maxCubeMapTextureSize:number;maxRenderbufferSize:number;maxViewportDims:[number,number];maxVertexAttribs:number };
export type DeviceTemplate = { id:string;revision:number;name:string;model:string;os:string;arch?:'arm64';bitness?:'64';webglLimits?:WebglLimits;physicalScreen:{width:number;height:number};renderScreen:{width:number;height:number};physicalMemoryGb:number;browser:{width:number;height:number;dpr:number;memory:number;cpu:number;touch:number;vendor:string;renderer:string};defaultWeight:number;evidence:{reviewedAt:string;status:'emulation';measuredAt:string|null;sources:{url:string;scope:string}[];note:string} };
export const DEVICE_CATALOG:{version:string;publishedAt?:string;templates:DeviceTemplate[]};
export const DEFAULT_WEIGHTS:Record<string,number>;
export const weightsSchema:ZodType<Record<string,number>>;
export function resolveWeights(value:unknown):Record<string,number>;
export function selectTemplate(seed:string,weights?:Record<string,number>):DeviceTemplate;
export function findTemplate(id:string,version?:string,revision?:number):DeviceTemplate|undefined;
