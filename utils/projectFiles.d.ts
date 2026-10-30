export type ProjectFile = {
  path: string; name: string; type: "file" | "directory" | "link" | "other"; size: number;
  modifiedAt: string; revision: string; writable: boolean; reason: string | null;
};
export type FileContent = ProjectFile & { content: string | null; editable: boolean };
export type FileVersion = { id: string; path: string; action: "edit" | "delete"; createdAt: string; size: number };
export type DirectoryListing = { path: string; entries: ProjectFile[]; total: number; offset: number; limit: number; textLimit: number; uploadLimit: number; uploadAllowed: boolean };
export type FileHistory = { entries: FileVersion[]; total: number; offset: number; limit: number };
export class FileManagerError extends Error { status: number; constructor(status: number, message: string); }
export const TEXT_LIMIT: number;
export const UPLOAD_LIMIT: number;
export function createProjectFiles(options?: { root?: string; history?: string }): {
  list(options?: { path?: string; query?: string; offset?: number; limit?: number }): Promise<DirectoryListing>;
  read(path: string): Promise<FileContent>;
  stat(path: string): Promise<ProjectFile>;
  upload(path: string, revision: string | null, stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options?: { signal?: AbortSignal }): Promise<{ file: ProjectFile; versionId: string | null }>;
  download(path: string): Promise<{ stream: ReadableStream<Uint8Array>; name: string; size: number }>;
  archive(path?: string, options?: { signal?: AbortSignal }): Promise<{ stream: ReadableStream<Uint8Array>; name: string }>;
  save(path: string, revision: string, content: string): Promise<{ file: FileContent; versionId: string }>;
  remove(path: string, revision: string): Promise<{ versionId: string }>;
  history(options?: { offset?: number; limit?: number }): Promise<FileHistory>;
  restore(id: string, revision: string | null): Promise<{ path: string }>;
  purge(id: string): Promise<{ removed: boolean }>;
};
