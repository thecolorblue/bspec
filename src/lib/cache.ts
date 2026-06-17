import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "../config.ts";
import { cacheMetaSchema, type CacheMeta } from "./schemas.ts";

export const OUTPUTS_ARCHIVE = "outputs.tar.gz";
export const META_FILE = "meta.json";

export function cacheEntryDir(key: string, home: string): string {
  return join(cacheDir(home), key);
}

export function cacheArchivePath(key: string, home: string): string {
  return join(cacheEntryDir(key, home), OUTPUTS_ARCHIVE);
}

export function cacheMetaPath(key: string, home: string): string {
  return join(cacheEntryDir(key, home), META_FILE);
}

/** A cache hit requires both the archive and metadata to be present. */
export function hasCacheEntry(key: string, home: string): boolean {
  return existsSync(cacheArchivePath(key, home)) && existsSync(cacheMetaPath(key, home));
}

export async function readMeta(key: string, home: string): Promise<CacheMeta> {
  const raw = await readFile(cacheMetaPath(key, home), "utf8");
  return cacheMetaSchema.parse(JSON.parse(raw));
}

export async function listCacheKeys(home: string): Promise<string[]> {
  const dir = cacheDir(home);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
