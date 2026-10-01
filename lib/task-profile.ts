import { randomUUID } from "node:crypto";

/** Create a profile atomically with its task, or reuse an existing UUID. */
export function taskProfile(profileId: string = randomUUID()) {
  return {
    connectOrCreate: {
      where: { id: profileId },
      create: { id: profileId, name: `Профиль ${profileId.slice(0, 8)}` },
    },
  };
}
