import type { Prisma, Project } from '@prisma/client';
declare const archive: { changeArchive(tx: Prisma.TransactionClient, id: string, action: 'archive' | 'restore'): Promise<Project> };
export = archive;
