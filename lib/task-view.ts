import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dailyState, type DailyTask } from "@/utils/taskDailySchedule";
export const taskInclude = { profile: true, project: true, executions: { where: { status: "running" }, select: { id: true, status: true, profileId: true } } } satisfies Prisma.TaskInclude;

export async function withTaskDailyState<T extends DailyTask>(task: T) {
  const state = await dailyState(prisma, task);
  return { ...task, dailyExecutionsToday: state.completed, dailyReservedToday: state.reserved,
    nextExecutionAt: state.nextAt?.toISOString() ?? null, dailyWaitReason: state.reason };
}
