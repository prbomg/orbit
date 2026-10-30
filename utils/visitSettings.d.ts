export type VisitSettings={minSeconds:number;maxSeconds:number;maxInternalTransitions:number;allowedSections:string[];trackMetrics?:boolean;disableMetrics?:boolean};
export function normalizeSection(value:string):string;
export function allowsSection(url:string,sections?:string[]):boolean;
export function visitSettings(value:unknown):VisitSettings|null;
