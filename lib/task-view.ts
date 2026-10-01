import { Prisma } from "@prisma/client";
export const taskInclude = { profile: true, project: true, executions: { include: { profile: true }, orderBy: { createdAt: "asc" as const } } } satisfies Prisma.TaskInclude;
