import "server-only";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

/** Return metadata only: no cookies, storage values or fingerprints reach the UI. */
export async function profileSession(id: string) {
  const absent = { state: "missing", savedAt: null, mobileOS: null, cookiesCount: 0, originsCount: 0 };
  if (!/^[a-f0-9-]{36}$/i.test(id)) return { ...absent, state: "unreadable" };
  let file;
  try {
    file = await open(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? "profiles", `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 10_000_000) throw new Error("Invalid profile");
    const value = JSON.parse(await file.readFile("utf8"));
    if (value.profileId !== id || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) throw new Error("Invalid profile");
    return { state: "saved", savedAt: typeof value.savedAt === "string" ? value.savedAt : stat.mtime.toISOString(),
      mobileOS: ["android", "ios"].includes(value.mobileOS) ? value.mobileOS : null,
      cookiesCount: value.cookies.length, originsCount: value.origins.length };
  } catch (error) { return { ...absent, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }; }
  finally { await file?.close(); }
}
