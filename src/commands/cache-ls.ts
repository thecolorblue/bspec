import { resolveBspecHome } from "../config.ts";
import { hasCacheEntry, listCacheKeys, readMeta } from "../lib/cache.ts";

export async function cacheLs(opts: { home?: string } = {}): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  const keys = await listCacheKeys(home);

  if (keys.length === 0) {
    process.stdout.write("Cache is empty.\n");
    return;
  }

  process.stdout.write(
    `${"KEY".padEnd(12)}  ${"BLOCK".padEnd(18)}  ${"VERSION".padEnd(7)}  STATUS\n`,
  );
  for (const key of keys) {
    const fresh = hasCacheEntry(key, home);
    let block = "?";
    let version = "?";
    if (fresh) {
      const meta = await readMeta(key, home);
      block = meta.block_id;
      version = meta.version;
    }
    const status = fresh ? "fresh" : "corrupt";
    process.stdout.write(
      `${key.slice(0, 12).padEnd(12)}  ${block.padEnd(18)}  ${version.padEnd(7)}  ${status}\n`,
    );
  }
}
