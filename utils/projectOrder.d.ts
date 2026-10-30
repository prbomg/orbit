export function moveProject<T extends {id:string;archivedAt?:unknown}>(items:T[],source:string,target:string):T[];
export function saveProjectOrder(tx:import('@prisma/client').Prisma.TransactionClient,ids:string[],archived:boolean):Promise<void>;
