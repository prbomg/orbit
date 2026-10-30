export type VisitStats = { window: {period:string;from:string|null;to:string|null;timezone:string};total:number;search:number;refined:number;direct:number;unknown:number;items:{kind:string;query:string|null;count:number;plainCount:number;refinedCount:number;refinementUnknownCount:number;variants:{actualQuery:string;count:number;lastVisitAt:string|null}[];lastVisitAt:string|null}[] };
export function visitWindow(options?:{period?:string;from?:string;to?:string},now?:number):unknown;
export function projectVisitStats(db:unknown,projectId:string,options?:{period?:string;from?:string;to?:string},now?:number):Promise<VisitStats|null>;
export function recordProjectVisit(db:unknown,data:unknown):Promise<unknown>;
export function taskVisitStats(db:unknown,taskId:string,options?:{period?:string;from?:string;to?:string},now?:number):Promise<VisitStats|null>;
