import "server-only";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import snapshots from "@/utils/profileSnapshots";
import { stat } from "node:fs/promises";
import sessionState from "@/utils/sessionState";
import publication from "@/utils/profilePublication";
import { maxProfileBytes } from "@/utils/profileLimits";

/** Return metadata only: no cookies, storage values or fingerprints reach the UI. */
export async function profileSession(id: string) {
  const absent = { state: "missing", savedAt: null, mobileOS: null, sizeBytes: 0, ...sessionState.sessionSummary({ cookies: [], origins: [] }) };
  if (!/^[a-f0-9-]{36}$/i.test(id)) return { ...absent, state: "unreadable" };
  let file;
  let backupAvailable = false;
  try { backupAvailable = (await stat(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? 'profiles', `${id}.json.previous`))).isFile(); } catch {}
  const storage = { backupAvailable, snapshotId: null as string | null, passportHash: null as string | null };
  try {
    if (await publication.hasPendingPublication(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? 'profiles'), id)) return { ...absent, ...storage, state: 'pending_commit' };
    file = await open(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? "profiles", `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    const limit = maxProfileBytes();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid profile");
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text) > limit) throw new Error("profile_too_large");
    const value = JSON.parse(text);
    if (value.version !== 2 || value.profileId !== id || (value.savedAt !== null && (typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt))))) throw new Error("Invalid profile");
    if (!snapshots.checkSnapshot(value)) throw new Error('Snapshot checksum mismatch');
    const state = sessionState.storageStateSchema.parse(value);
    return { state: value.savedAt ? "saved" : "unsaved", savedAt: value.savedAt,
      ...storage, snapshotId: value.snapshot?.id || null, passportHash: value.snapshot?.passportHash || null,
      mobileOS: ["android", "ios"].includes(value.mobileOS) ? value.mobileOS : null,
      sizeBytes: stat.size, ...sessionState.sessionSummary(state) };
  } catch (error) { return { ...absent, ...storage, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }; }
  finally { await file?.close(); }
}
