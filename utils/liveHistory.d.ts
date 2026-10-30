export type LiveEvent = {time:string;event:string;_offset:number;[key:string]:unknown};
export function readEventPage(path:string,options?:{before?:number;limit?:number}):Promise<{events:LiveEvent[];nextCursor:number|null}>;
