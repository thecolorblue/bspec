import { existsSync } from "node:fs";
import { resolveBspecHome } from "../config.ts";
import {
  cacheArchivePath,
  cacheMetaPath,
  listCacheKeys,
  readMeta,
} from "../lib/cache.ts";
import { BspecError } from "../lib/errors.ts";

export async function cacheVerify(opts: { home?: string } = {}): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  const keys = await listCacheKeys(home);

  if (keys.length === 0) {
    process.stdout.write("Cache is empty. Nothing to verify.\n");
    return;
  }

  const problems: string[] = [];
  for (const key of keys) {
    if (!existsSync(cacheArchivePath(key, home))) {
      problems.push(
        `Cache entry ${key} is missing outputs.tar.gz. ` +
          `Run bspec cache prune or rebuild with a new version.`,
      );
      continue;
    }
    if (!existsSync(cacheMetaPath(key, home))) {
      problems.push(`Cache entry ${key} is missing meta.json.`);
      continue;
    }
    try {
      const meta = await readMeta(key, home);
      if (!meta.block_id || !meta.version || !meta.params_hash || !Array.isArray(meta.produces)) {
        problems.push(`Cache entry ${key} has incomplete metadata.`);
      }
    } catch {
      problems.push(`Cache entry ${key} has unreadable metadata.`);
    }
  }

  if (problems.length > 0) {
    throw new BspecError(problems.join("\n"));
  }
  process.stdout.write(`Verified ${keys.length} cache entr${keys.length === 1 ? "y" : "ies"}. All ok.\n`);
}
